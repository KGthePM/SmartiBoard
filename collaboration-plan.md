# Team collaboration without a hosted database (v4.0)

*Plan only — nothing in this document is built.*

## Context

Smarti Board is single-player by construction: one SQLite file, one settings row, no auth,
no per-user scoping. The ask is team collaboration — and specifically, doing it **without**
a hosted database like Supabase.

That is achievable, and the reason is that the constraint was never SQLite. Three pieces are
already in place:

- **SQLite runs in WAL mode** (`lib/db.ts:41`) and is a genuine multi-writer database. A
  handful of concurrent editors on one box is unremarkable for it.
- **`--lan` already exists** (v2.5) and already binds every interface behind an opt-in flag.
  The transport for "several people, one board" is shipped.
- **SSE is already a pattern in this codebase** (`app/api/boards/[id]/ideas/route.ts`). The
  exact mechanism for pushing one person's edit into another person's canvas is something the
  repo has already written, tested and reasoned about.

What is actually missing is the **wire protocol**. `components/canvas/Board.tsx:363-398`
autosaves the *entire board* as a whole-document `PUT`, and `saveBoard` (`lib/db.ts:120`)
upserts on id with no version check. So:

> **Two browser tabs on the same board already destroy each other's work today, silently.**
> Last writer wins, whole document. This is a live single-user bug, not just a multiplayer
> blocker, and fixing it is Phase 1 — valuable even if nothing else here is built.

The intended outcome: a team reaches one always-on host over a private network, edits the
same board at once with per-card merge, sees each other's names, cursors and selections, and
shares one AI collaborator rather than N of them — with **no cloud service, no second
database, no accounts, and no schema migration.**

### Decisions taken

| Question | Answer |
|---|---|
| Reach | Remote team, **always-on host** — one Smarti install that stays up, reached over Tailscale (recommended) or a tunnel behind Access. Same app code as the LAN case. |
| Concurrency | **Per-node merge, live.** Different cards → both win. Same card → last-writer-wins on that card only, never the whole board. |
| Presence | **Names + live cursors + selection.** Session-only, never persisted. |

### Explicitly declined

- **Supabase / any hosted DB.** Adds a service, an account system and a network dependency to
  an app whose `lib/db.ts` states outright that self-hosting should be `docker run`, not a
  dependency graph. Nothing here needs it.
- **Yjs / Automerge CRDTs, peer-to-peer.** True serverless, but it re-founds `lib/store.ts`
  and the board document as a CRDT — touching every mutation, both undo stacks (Yjs brings its
  own `UndoManager` with different semantics), the fingerprint and the ghost. A rewrite of the
  app's spine for a "no server" story that still needs signaling, still needs relay on most
  real networks, and still needs someone online to hold state. With an always-on host chosen,
  the server *is* the answer.
- **Per-node revision/vector clocks in the board JSON.** Unnecessary: the server is a single
  process and is therefore the sequencer. Arrival order is the total order. This is what buys
  us **no board-JSON change and no migration.**
- **A passcode or any auth concept in the app.** Declined in v2.5 and stays declined for the
  same reason. See Security below — the network is the boundary.

---

## Architecture

### The one new idea: ops, and the server is the sequencer

Replace "here is the whole board" with "here is what changed." The server applies ops in
arrival order to the stored board, saves, and broadcasts them. Because there is exactly one
process holding exactly one file, arrival order is a total order — so no revisions, no
clocks, no CRDT, and nothing added to `Board`.

### `lib/sync.ts` — new, pure, node-free

The heart of the feature, and the only genuinely new logic. Same shape as `lib/search.ts`,
`lib/transfer.ts` and `lib/collapse.ts`: pure, node-free, exhaustively unit-tested, imported
by both the client and the route.

```ts
export type Op =
  | { t: 'node.put'; node: IdeaNode }   // add OR full replace
  | { t: 'node.del'; id: NodeId }
  | { t: 'edge.add'; edge: Edge }
  | { t: 'edge.del'; id: string }
  | { t: 'board.set'; title?: string; objective?: string; privacy?: boolean }

export function diffBoards(prev: Board, next: Board): Op[]
export function applyOps(board: Board, ops: unknown): Board   // total, never throws
```

**The node is the unit of merge, deliberately.** `node.put` is a whole-node replace, so it
covers text, move, resize, font step, `done` and reactions with one op. Field-level ops would
buy almost nothing — two people rarely resize the same card while a third re-colours it — and
would cost a large op set and a large test surface. This is exactly the "per-node merge"
that was chosen.

`applyOps` takes `parseBoard`'s doctrine: **total and tolerant.** An unknown `t`, a malformed
node, a `node.del` for an id that is already gone — each is dropped in silence and the rest of
the batch applies. A bad op costs the op, never the board.

### `lib/hub.ts` — new, server-only

In-process pub/sub. A `Map<boardId, Room>` pinned on `globalThis` so Next's dev HMR does not
orphan live subscribers. Per room: the subscriber set, a monotonic `seq`, the presence map,
and the ghost lease (Phase 4). No dependency, no external broker — single process is already
a stated given in `lib/db.ts`.

### `app/api/boards/[id]/sync/route.ts` — new

- **`POST`** — `{ clientId, ops }`. Load, `applyOps`, `saveBoard`, assign `seq`, broadcast,
  return `{ seq }`. This is the only write path that changes.
- **`GET`** — SSE, same frame idiom as the ideas route:
  - `{"type":"hello","seq":N,"board":{…}}` — full state on connect, so a client that was
    offline resyncs by reconnecting rather than by replaying a log.
  - `{"type":"ops","seq":N,"clientId":"…","ops":[…]}`
  - `{"type":"presence","peers":[…]}`
  - `{"type":"ghost", …}` (Phase 4), `{"type":"ping"}` for idle keepalive.

`PUT /api/boards/[id]` stays exactly as it is — v3.3 import, the desktop path and any
hand-editing still depend on whole-board writes, and it is the honest fallback if a sync
POST fails.

### Client — `components/canvas/useSync.ts`, new hook

This is a **swap inside the existing autosave seam**, not a new lifecycle. `Board.tsx:363-398`
already debounces, tracks a sequence number, shows a saving/saved/error indicator, retries on
failure, and flushes on unmount (`flushUnsaved`, `Board.tsx:311`). All of that survives; only
two lines change in kind:

- `savedRef` holds the last **acked Board** instead of a JSON string.
- the body becomes `diffBoards(savedRef.current, board)`, and an empty op list is the new
  "nothing to save" (replacing the string comparison at `Board.tsx:368`).

The SSE consumer lives in the same hook and feeds `applyRemote`. Echoes of our own POST are
suppressed by `clientId`.

### Store — two new actions in `lib/store.ts`

**`applyRemote(ops: Op[])`** — and its doctrine is the most important sentence in this plan:

> **Another person's edit is never in your undo stack.** It pushes no undo snapshot and spends
> no redo. It *does* bump `lastMutationAt`, because the board now says something different and
> the ghost is allowed to notice.

That is the direct descendant of the v1 rule that a suggestion *appearing* is never in the
user's undo stack while *accepting* one is. A ⌘Z that reverted a teammate's card is the
multiplayer form of the haunted board.

It must also: prune `selectedIds` and `expandedIds` of nodes that were deleted out from under
us; clear the local `proposal` if a remote `board.set` turns privacy **on** — reusing
`setPrivacy`'s existing rule that this must *not* route through `rejectedByBoard`, because
nobody turned that idea down; and leave `rejectedByBoard` / `deletedEdgesByBoard` alone.

**`setPeers(peers)`** — presence. Session tier, cleared by `beginLoad`.

### Undo, rebased — the sharp edge

`undoStack` holds **whole-board snapshots** (`pushUndo`). Two consequences:

1. **Restoring one needs no new code.** Undo sets `board`; the autosave effect diffs it and
   sends ops; the server merges them like any other edit. The diff seam absorbs undo for free.
2. **But a stale snapshot carries stale copies of teammates' cards**, so a ⌘Z would resurrect
   what they deleted and revert what they typed. The fix: **`applyRemote` also applies the
   remote ops to every snapshot in `undoStack` and `redoStack`.** Cheap (≤50 boards, small
   ops), pure (`applyOps` again, no new logic), and it means a snapshot never holds an
   out-of-date version of somebody else's work. Undo then only ever undoes *your* edits.

`beginLoad` already clears both stacks per board, so nothing leaks across a switch.

### Presence

`POST /api/boards/[id]/presence`, throttled client-side to ~10/sec:
`{ clientId, name, color, cursor: {x,y}, selectedIds, editingId }`, broadcast on the same SSE
stream, dropped on disconnect. Cursors are in **board coordinates**, so they land correctly
under each viewer's own pan and zoom (`lib/gesture.ts` already owns that algebra).

Spends nothing: not persisted, not in `Board`, not in the fingerprint, never in a prompt,
never a token. Same tier as the selection — `beginLoad` clears it and `setPresenting(true)`
hides it, for the same reason there is no selection ring on a projector.

The display name lives in `localStorage` and is **a label, not an identity.** Nothing checks
it, nothing is scoped by it. This must be said in the UI copy so it is never mistaken for auth.

New tokens `--peer-ring` / `--peer-label` with the mandatory three-theme answer. In Neon,
peers **glow like user content, because that is what they are** — the ghost stays the only
thing on the board that does not glow, and the three-layer invariant is untouched, since a
teammate's card is user content and a proposal is still never a node.

### The ghost, shared

`shouldRequest` permits one live ghost per board; with N clients, N of them would fire at the
same change and spend the host's key N times. Fix: a **ghost lease** in the hub (TTL ~30s).
`/suggest` claims it; a client that loses the race gets `{ proposal: null, reason: 'claimed' }`
and stays quiet — which is a refusal reason ranked with the existing ones, not an error, and
stays silent per the v1.4 rule that configuration failures are loud in exactly two places.

The winner's proposal broadcasts as an ephemeral `ghost` frame, so the room sees **one ghost,
together** — the "one live ghost at a time" invariant held literally rather than per-tab, and
arguably the moment this product is most itself. Accepting is an ordinary op (`acceptProposal`
constructs a node, the diff carries it). Dismissal broadcasts and lands in each client's
`rejectedByBoard`. Privacy Mode is a board field, so one person flipping it stops everyone,
and `/suggest` and `/ideas` already check the **stored** board — the guarantee is already
server-side and needs no change.

Still exactly one unsolicited AI behavior and one user-invoked one. This adds neither.

---

## Security — the part not to soften

v2.5 ruled that the `--lan` flag *is* the entire security model, and it was right for a run
that ends when you close the laptop. **An always-on remote host inverts that assumption**, and
the app still has no login, no session, no cookie, no middleware and no per-user scoping.
Anyone who can reach the port can read and write every board and spend the configured provider
key.

I would add no auth — a display name is a label. So the network must be the boundary, and this
is **documentation, not app code**:

- **Recommended: Tailscale.** The tailnet is the identity boundary, device auth is real auth
  maintained by someone else, and `SMARTI_HOST=0.0.0.0` behind it exposes nothing to the
  internet. This is the one I would write into the README as *the* answer.
- **Cloudflare Tunnel only with Cloudflare Access in front of it.** A bare
  `trycloudflare.com` hostname is a public URL to every board on the host and to its API key.
- **Name the shared-library trade plainly:** one SQLite file with no per-user scoping means
  everyone on the host sees *every* board in the library and shares one provider key and one
  settings row. That is the cost of no accounts, and it should be in the README, not
  discovered.

`next.config.ts`'s `allowedDevOrigins` covers RFC 1918 and `*.local` only — a Tailscale
`100.64.0.0/10` address is **not** in that list, so `next dev` over a tailnet will serve the
page and then refuse its own API calls. Either add the CGNAT range or, better, document that
an always-on host runs `npm run build && npm start` (where `allowedDevOrigins` does not
apply) rather than `next dev`.

**Desktop is not the host.** v3.1 deliberately binds loopback only and ships no `--lan`,
because a double-clicked icon has no moment at which an operator decides. That ruling stands;
the always-on host is the web install. Say so rather than quietly leaving people to find out.

---

## Doctrine to write down

The brief lists **real-time multiplayer as explicitly out of scope for v1.** This retires that
line deliberately, the way v2.0 retired the board summary — it is not an oversight to be
glossed over. It needs a proper entry in `CLAUDE.md`, `AGENTS.md` and `README.md` in the house
style, stating: the server is the sequencer; the node is the unit of merge; a teammate's edit
is never in your undo stack; presence spends nothing; the ghost is leased so the room shares
one; and the network is the boundary because the app has no auth and is not getting any.

---

## Build sequence

Each phase is independently shippable.

1. **Ops protocol.** `lib/sync.ts` + `lib/sync.test.ts`, `sync/route.ts` (POST only),
   `useSync.ts` swapping the diff into the existing autosave seam. **Fixes the two-tab clobber
   with no UI at all.** Ship this even if the rest waits.
2. **Live updates.** `lib/hub.ts`, SSE `GET`, `applyRemote`, undo/redo stack rebasing.
3. **Presence.** Presence route, cursor/selection rendering, name prompt, theme tokens.
4. **Shared ghost.** Ghost lease in the hub, `reason: 'claimed'`, `ghost` broadcast frame.
5. **Remote access.** README section (Tailscale, Access, the shared-library trade, the
   `allowedDevOrigins` note), and the doctrine entries above.

## Files

**New:** `lib/sync.ts`, `lib/sync.test.ts`, `lib/hub.ts`,
`app/api/boards/[id]/sync/route.ts`, `app/api/boards/[id]/presence/route.ts`,
`components/canvas/useSync.ts`, `components/canvas/PeerCursors.tsx`.

**Modified:** `components/canvas/Board.tsx` (autosave seam → `useSync`; peer layer),
`lib/store.ts` (`applyRemote`, `setPeers`, `beginLoad` clears peers, stack rebasing),
`app/api/boards/[id]/suggest/route.ts` (lease), `app/globals.css` (peer tokens ×3 themes),
`README.md` / `CLAUDE.md` / `AGENTS.md`.

**Unchanged, and worth noting:** `lib/graph.ts` (**no schema change**), `lib/db.ts` (**no
migration**), `lib/ai/trigger.ts`, `lib/ai/prompt.ts`, and everything in `desktop/`.

## Verification

**No browsers, no screenshots** — per `CLAUDE.md` and standing preference. Visual checks are
called out for the user to make.

- `npm test` — `lib/sync.test.ts` is where the confidence lives: `diffBoards` produces a
  minimal op list for each store mutation; `applyOps(prev, diffBoards(prev, next))` round-trips
  to `next`; malformed/unknown ops drop without throwing; concurrent per-node merges resolve as
  specified. Plus the existing `lib/store.test.ts` extended for `applyRemote`'s no-undo rule
  and stack rebasing.
- `npm run typecheck`, `npm run build`.
- Against `npm run dev`: `curl -N http://127.0.0.1:3000/api/boards/<id>/sync` in one shell to
  hold the SSE stream, `curl -X POST … -d '{"clientId":"b","ops":[…]}'` in another, and confirm
  the frame arrives with a `seq`. Two POSTs touching **different** nodes must both survive;
  two touching the **same** node must leave the later one, with the rest of the board intact.
- `sqlite3 data/smarti.db 'select data from boards where id=…'` to confirm the merge landed on
  disk and no field was dropped.
- Kill the SSE client mid-edit, reconnect, and confirm the `hello` frame resyncs it — the
  offline path, and the reason there is no op log to replay.
- **Visual checks:** cursors tracking correctly under pan/zoom, peer colors legible in all
  three themes, and the shared ghost appearing once rather than once per tab.
