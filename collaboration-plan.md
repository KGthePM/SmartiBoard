# Team collaboration without a hosted database (v4.x)

*Plan only, except v3.6 (the ops layer), v4.0 (live updates and the shared ghost) and v4.1*
*(sharing on a network), which are built and working. v4.2 (the tunnel) was built but is*
*⏸ paused pending re-evaluation — see `v4.2-tunnel.md` for the failure. See*
*`v4.0-live-collaboration.md` and `v4.1-sharing.md` for the working releases in detail;*
*v4.3 — "Shared with me" — is next, and depends on v4.2 being resolved first.*

## Goal

**Everyone has Smarti installed on their own machine. You share a board with a link, it opens
in the other person's app, and you edit it together** — a Google Doc that happens to run on
your PC instead of someone else's. No cloud service, no accounts, no second database, no
board-schema change.

SQLite is already WAL (`lib/db.ts:41`) and a real multi-writer; `--lan` (v2.5) already binds
every interface; SSE is already a pattern (`app/api/boards/[id]/ideas/route.ts`). What is
missing is the **wire protocol**. `Board.tsx:363-398` autosaves the *whole board* as a
`PUT` and `saveBoard` (`lib/db.ts:120`) upserts on id with no version check:

> **Two browser tabs on the same board already destroy each other's work today, silently.**
> Last writer wins, whole document. A live single-user bug, not just a multiplayer blocker —
> fixing it is v3.6 and is worth shipping alone.

### Decisions

| Question | Answer |
|---|---|
| Where a shared board lives | **The owner's install only.** Guests join live and hold no copy. One process = one sequencer, so no CRDT. |
| Who can host | **Anyone, including desktop.** Share is a per-board action — the operator moment v3.1 said a double-clicked icon lacks. |
| Reach | **Tiered.** Default link is the LAN address (free, no dependency). A second button opens a `cloudflared` quick tunnel for a public https link. |
| Guest scope | **Only the shared board.** Unguessable per-board token; no library, no other board, no settings, no key. |
| Concurrency | **Per-node merge.** Different cards → both win. Same card → LWW on that card only. |
| Presence | Names, cursors, selection. Session-only, never persisted. |

### Declined

| | Why |
|---|---|
| Supabase / any hosted DB | Holds state and identity. Nothing here needs it. |
| Yjs / Automerge CRDTs | Re-founds `lib/store.ts`, both undo stacks, the fingerprint and the ghost — for a "no server" story that still needs signaling and relay. |
| Replicating the board into the guest's library | That is the multi-master merge just declined, plus an offline story and two databases that can disagree. |
| Revision/vector clocks in the board JSON | Arrival order at a single process *is* the total order. This is what buys no board-JSON change. |
| A passcode, login, or user identity | The token authorises a *board*, not a person. |
| Requiring Tailscale, or any VPN | Two installs, two accounts and tailnet membership before a link resolves. Stays documented for people already running it; `tsnet` doesn't help — the friction is the accounts, not distribution. Same reason ngrok is out: it wants a signup. |
| A relay Smarti runs | **Supabase would hold state; a tunnel forwards bytes and holds nothing.** Lose Cloudflare and only reach is lost — which is why a tunnel is admitted and a service is not. |
| Downloading `cloudflared` at runtime | Bundled at build time or found on `PATH`. An idea board should not pull executables on a button press. |

---

## `lib/sync.ts` — new, pure, node-free

Replace "here is the whole board" with "here is what changed." Same shape as `lib/search.ts`
and `lib/transfer.ts`: pure, node-free, exhaustively tested, imported by client and route.

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

**The node is the unit of merge.** `node.put` is a whole-node replace, so one op covers text,
move, resize, font step, `done` and reactions. Field-level ops would cost a large op set and
test surface to solve a collision nobody has.

`applyOps` takes `parseBoard`'s doctrine — **total and tolerant**: an unknown `t`, a malformed
node, a `node.del` for a gone id are each dropped in silence and the rest of the batch applies.

**Delivery is at-least-once**, so every op must be idempotent. All are for free except one:
**`edge.add` upserts by id**, or a lost response duplicates the edge. The property is a test —
applying any batch twice leaves the board unchanged.

## `lib/hub.ts` and the sync route — new

**`lib/hub.ts`** is in-process pub/sub: `Map<boardId, Room>` pinned on `globalThis` so dev HMR
doesn't orphan subscribers. Per room: subscribers, a monotonic `seq`, presence, the share
registry, the ghost lease. No broker — single process is already a given in `lib/db.ts`.

**`app/api/boards/[id]/sync/route.ts`:**

- **POST** `{ clientId, ops }` — load, `applyOps`, `saveBoard`, assign `seq`, broadcast, return
  `{ seq }`. The only write path that changes. Caps the batch (op count + byte ceiling): a
  misbehaving peer costs a 4xx, not memory.
- **GET** — SSE, same frame idiom as the ideas route: `hello` (full state on connect, so an
  offline client resyncs by reconnecting rather than replaying a log), `ops`, `presence`,
  `ghost`, `ping`.

`PUT /api/boards/[id]` is unchanged — import, desktop and hand-editing still need whole-board
writes, and it is the honest fallback if a sync POST fails.

## `components/canvas/useSync.ts` — new hook

**A swap inside the existing autosave seam, not a new lifecycle.** `Board.tsx:363-398` already
debounces, tracks a sequence, shows saving/saved/error, retries, and flushes on unmount
(`flushUnsaved`, `Board.tsx:311`). All of that survives; only the body changes:

- `savedRef` holds the last **acked Board** instead of a JSON string.
- the body is `diffBoards(savedRef.current, board)`; an empty op list is the new "nothing to
  save" (replacing the string compare at `Board.tsx:368`).
- **`flushUnsaved` swaps too.** It is the one save that fires unsupervised; if it kept
  whole-board PUTting, the clobber v3.6 exists to fix would survive every board switch.

The SSE consumer lives in the same hook and feeds `applyRemote`; our own echoes are suppressed
by `clientId`. The stream is per board and the board-switch effect closes it, and once open
`hello` is authoritative over the initial GET (`Board.tsx:352`).

**The reconnect rule, because it is the hardest merge here and must not be improvised:** the
host's changes since our last ack are `diffBoards(savedRef, hello)` — **not**
`diffBoards(local, hello)`, which would compute ops that wipe our own unsaved work. Apply that
through `applyRemote`, then set `savedRef := hello`. Our surviving edits now read as dirty
against the new basis and ride the next debounce; an in-flight POST re-sends harmlessly because
the ops are idempotent.

**Latency contract:** content travels at ~`AUTOSAVE_MS` — a collaborator's drag lands when it
settles, not per frame; cursors are the live layer. If that feels slow, also flush at commit
boundaries (drag end, edit blur); still no per-frame traffic.

## `lib/store.ts` — `applyRemote(ops)`

Four rules, all of which produce visible bugs if missed:

1. **Another person's edit is never in your undo stack.** No undo snapshot, no redo spend. It
   *does* bump `lastMutationAt` — the board says something different and the ghost may notice.
   (The descendant of v1's rule that a ghost *appearing* isn't undoable but accepting one is.)
2. **Never clobber a node with unsaved local edits.** The textarea is controlled over
   `node.text` (`NodeCard.tsx:218`) and commits per keystroke, so a remote `node.put` mid-burst
   yanks the card out from under the typist. **Skip remote `node.put`/`node.del` for any id in
   the local dirty set** (what `diffBoards(savedRef, board)` touches). LWW already decided ours
   wins; the skip retires itself when the save acks. This one rule covers live streaming,
   reconnect, and the open textarea at once.
3. **Rebase both stacks.** `undoStack` holds whole-board snapshots, so a stale one resurrects
   what a teammate deleted. `applyRemote` runs `applyOps` over every snapshot in `undoStack` and
   `redoStack` — cheap, no new logic, and undo then only ever undoes *your* edits. Consequence
   to accept: ⌘Z can restore their wording of a card you both edited. That is LWW applied to
   history, and the alternative is the per-field merge engine this plan exists to not need.
4. Prune `selectedIds` / `expandedIds` of nodes deleted under us; clear `proposal` if a remote
   `board.set` turns privacy **on** (not via `rejectedByBoard` — nobody turned that idea down);
   leave `rejectedByBoard` and `deletedEdgesByBoard` alone.

Restoring a snapshot needs no new code: undo sets `board`, the autosave effect diffs it, the
host merges it like any other edit. `beginLoad` already clears both stacks per board.

## The shared ghost

`shouldRequest` permits one live ghost per board; N clients would fire N times and spend the
host's key N times. A **ghost lease** in the hub (TTL ~30s) fixes it: `/suggest` claims it,
losers get `{ proposal: null, reason: 'claimed' }` and stay silent — a refusal reason ranked
with the existing ones, not an error.

The winner broadcasts an ephemeral `ghost` frame so the room sees **one ghost together**, with
a `proposed`/`accepted`/`dismissed` lifecycle — ops alone retire nobody's ghost: if Alice
accepts, the diff builds her node everywhere, but Bob's `proposal` lingers without an
`accepted` frame. A dismissal lands in each client's `rejectedByBoard`: one person's "not that"
is the room's.

Clients `markRequested` *before* the POST (`Board.tsx:461`), so losers don't re-fire each tick.
The hole is a winner whose tab dies after claiming, so **a lease that expires undelivered
broadcasts `{type:'ghost', proposal:null}`**, releasing the fingerprint everywhere. The room
self-heals in one round.

## Presence

`POST /api/boards/[id]/presence`, throttled to ~10/sec:
`{ clientId, name, color, cursor, selectedIds, editingId }`, broadcast on the same SSE stream,
dropped on disconnect. Cursors are in **board coordinates**, so they land correctly under each
viewer's own pan and zoom.

Spends nothing: not persisted, not in `Board`, not in the fingerprint, never a token. Selection
tier — `beginLoad` clears it, `setPresenting(true)` hides it. The name lives in `localStorage`
and is **a label, not an identity**; the UI must say so. New tokens `--peer-ring` /
`--peer-label` with the three-theme answer; in Neon peers **glow like user content, because
that is what they are** — the ghost stays the only thing that doesn't glow.

---

## Sharing

**Sharing is a property of the run, not the install.** A share is minted in memory in
`lib/hub.ts` and **dies with the process** — v2.5's ruling about the LAN binding, applied
again. So: closing the app is the revocation story, a link is good for the session (the UI says
so), and the desktop's OS-assigned random port stops mattering. Nothing is persisted.

**Desktop can host, and the binding is wide while the token is the boundary.** A listening
server cannot rebind, so widening on demand would mean a new port and a window reload mid-
collaboration. Instead `desktop/main.js` forks with `HOSTNAME=0.0.0.0` and every route asks
`lib/access.ts` who is calling. Sharing is then instant and reversible with no restart.

### `lib/share.ts` — new, pure, node-free

```
http://<host-address>:<port>/b/<boardId>#s=<token>
```

**The token rides in the fragment on purpose:** a fragment is never sent to a server, so the
capability stays out of access logs, `Referer` headers and proxy history. The page reads it and
sends it as a header. `shareUrl(origin, boardId, token)` and `parseShareLink(str)` are the pure
half; minting is server-side (`crypto.randomUUID`), storage is the hub. Host-address detection
reuses the LAN-IP snippet at `start.sh:157` and offers every address it finds rather than
guessing.

### Two tiers of reach

**Tier 1 — "On this network." Default, free, always present.** The LAN address plus a tailnet
address when one exists, labelled plainly ("This network only" vs "Tailscale — works from
anywhere your teammates are"). No binary, no third party, no account. **Same Wi-Fi needs no
Tailscale at all**, and the dialog must not nag when no tailnet address is found.

**Tier 2 — "Beyond this network." An explicit second button.** Opens a `cloudflared` quick
tunnel → `https://<random>.trycloudflare.com/b/<id>#s=<token>`. No account, no login, no DNS,
no config, and the guest needs only a browser. A public hostname is fine because **a bare
tunnel URL with no `#s=…` reaches nothing** — the tunnel exposes a port, the gate keeps it to
one board.

Three caveats the dialog carries, not the README:

- **Cloudflare terminates TLS, so the board's text passes through their edge in readable form.**
  One plain sentence on the button, per share. Nothing is blocked — it's their board, their call.
- **Quick tunnels are not a production service** (no uptime guarantee, rate-limited,
  withdrawable), so a share can stop working and the UI should say so rather than look broken.
- **The tunnel is per install, not per board.** Only the gate makes it one board.

### `lib/tunnel.ts` — new, server-only

Sibling of `lib/hub.ts`: spawn `cloudflared`, parse the URL off its stderr, hold at most one
tunnel per install, **die with the process**. Driven by `POST /api/tunnel` so desktop and web
share one path.

> **Never fetch a binary at runtime.** Desktop bundles `cloudflared` at build time; the web
> install uses one on `PATH`. Absent → tier 2 greyed out with a one-line explanation, never a
> download prompt.

Bundling reuses the existing seam: `desktop/stage.js` step 3 already fetches a platform+arch
binary (the better-sqlite3 Electron prebuild) and records it in `staged.json` for
`verify-arch.js` to refuse a mismatched pack. `cloudflared` is a fourth step through the same
machinery. ~30–40 MB per installer, against an Electron app already past 150 MB.

---

## `lib/access.ts` — the security model

v2.5 ruled that `--lan` *is* the entire security model. A shareable link inverts that
assumption, and the answer is not auth — it is that the token becomes the boundary for anyone
not on the machine. Three tiers, decided per request:

```ts
type Access = 'local' | 'trusted' | { share: BoardId }
export function accessFor(req: Request): Access
```

- **`local`** — loopback. Everything, as today.
- **`trusted`** — non-loopback *and* `SMARTI_TRUST_LAN` (exported by `start.sh --lan`).
  Everything, so **v2.5 behaviour is preserved bit-for-bit**.
- **`{ share }`** — a token the hub recognises. Reaches that board's `sync`, `presence`,
  `suggest`, `ideas` and `GET`. **Nothing else** — not the library list, not `?full=1`, not
  another board, not `/api/settings`, not `PATCH`, not `DELETE`.

**The loopback trap.** `cloudflared` runs *on the host* and dials `127.0.0.1`, so every
tunneled request arrives looking local. Read naively, a tunnel doesn't weaken the strictest
tier — it inverts it into the most permissive one, for the whole internet.

> **A request carrying `CF-Connecting-IP` / `CF-Ray` is remote.** Never `local`, never
> `trusted`; share tier at best.

It fails safe: a local caller could forge those headers, but that only downgrades access they
already hold, while a remote caller cannot strip them. This is the single most important
assertion in `access.test.ts`.

**A helper at the top of each route, not middleware** — Next middleware is edge-runtime and
cannot see the hub. Untrusted callers are cross-origin, so share-scoped routes answer with
CORS; loopback and trusted routes get none.

- **A guest spends the host's API key** (the ghost fires for the room, ⌘. is live). Correct, but
  it belongs in the Share dialog, not a provider bill.
- **Privacy Mode is the guest-proof switch** — already checked server-side against the *stored*
  board, so it needs no change; it just also means "no guest spends my key here."
- `allowedDevOrigins` lacks Tailscale's `100.64.0.0/10`, so `next dev` over a tailnet serves a
  page that refuses its own API calls. Add the CGNAT range.

---

## The collab section — the guest side

The guest's install must remember what it joined: **a new `remotes` table**, the only new
storage in the plan.

```sql
CREATE TABLE IF NOT EXISTS remotes (
  id TEXT PRIMARY KEY, origin TEXT NOT NULL, board_id TEXT NOT NULL,
  token TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', last_seen INTEGER NOT NULL
);
```

Added in `lib/db.ts`'s existing `migrate()`. **`boards`, `settings` and the board JSON are
untouched**, so `parseBoard`, import and export are unaffected.

`BoardIndex.tsx` grows a separate **"Shared with me"** group: host address, title as last seen,
a live/offline dot, and a Leave that only forgets the row. **No minimap, archive, delete or
export** — there is no local copy, and a guest cannot destroy what they don't hold.

**The canvas needs an origin.** Fetches in `Board.tsx`, `useSync` and `IdeasPanel` assume
same-origin; a remote board prefixes them and adds the token header. The largest mechanical
change here, which is why it ships last.

---

## Build sequence

Five releases, each ending somewhere worth handing to someone, each carrying its own
`CLAUDE.md` / `AGENTS.md` / `README.md` entry written *with* the code.

**v3.6 — Ops. Ships alone, as a bug fix. ✅ Done.** `lib/sync.ts` + tests, the sync POST,
`useSync` in the autosave seam (`flushUnsaved` included). No UI, no networking, no security
surface; it fixes a bug that exists today, and everything later inherits a proven save path.
*Gate met: `sync.test.ts` green; two tabs no longer clobber.*

**v4.0 — Live updates and the shared ghost. ✅ Done.** The original v4.0's first two steps,
split out so that a release which changes no network binding ships without one that does:
1. Live updates — `lib/hub.ts`, SSE GET, `applyRemote`, stack rebasing.
2. Shared ghost — the lease. **Not deferrable:** the moment step 1 lands, two clients means two
   `/suggest` calls per change. It is a correctness requirement of step 1, and far cheaper
   written while already inside the hub.

Reach is unchanged — loopback, or the LAN if the operator passed `--lan`, which already
exposes everything. So this release has no security surface at all, and it is testable with
two tabs on one machine. Detailed in `v4.0-live-collaboration.md`. *Gate met: `hub.test.ts`
and the extended `store.test.ts` green; two tabs update each other live; one ghost per room,
not per tab.*

**v4.1 — Sharing on a network. ✅ Done.** The original v4.0's second two steps:
3. Access gate — `lib/access.ts` + tests, the tiers, `SMARTI_TRUST_LAN`.
4. Share tier 1 — `lib/share.ts` + tests, the token registry, the dialog, guest chrome,
   `desktop/main.js` binding wide, the CGNAT range.

> **Step 3 lands before step 4, and both land in one release.** There must never exist a build
> where desktop binds `0.0.0.0` and the gate isn't there — that is a build where the café
> Wi-Fi has the whole library.

Joining is browser-only, so this carried no guest-side refactor. Detailed in
`v4.1-sharing.md`. *Gate met: the `access.test.ts` refusal matrix green; the same matrix
re-run by hand against a wide-bound server from its real LAN address; and — the gate this
release actually set itself — **a real link working between two machines**, confirmed
against the desktop's gated binding, where the token and not the network is what admitted
the guest.*

**Three things this plan got wrong, corrected in that release:**

1. **`accessFor` cannot read the peer address** — Next's App Router does not expose the
   socket, and `Host` is forgeable from the LAN. `local` became something a request must
   **prove**, with a per-run `SMARTI_LOCAL_SECRET` the desktop injects into its own window,
   and a loopback binding standing in for the proof everywhere else. The tiers survived; how
   `local` is decided did not.
2. **The `CF-Connecting-IP` rule moved up to v4.1** from v4.2. The same reasoning that makes
   it necessary under a tunnel makes it cheap to write while `lib/access.ts` is being born,
   and impossible to forget later.
3. **CORS moved down to v4.3.** A v4.1 guest opens the *host's* page on the host's origin, so
   every call is same-origin; the headers this plan put in step 4 would have been untested
   surface guarding a case that does not exist until the guest's installed app fetches across
   origins. `apiFetch` in `lib/shareToken.ts` is where that lands, and moving every client
   call site onto it now is what makes v4.3 one line rather than three files.

Also: the link is `/board/<id>#s=…` on the page route the app already had, not a new `/b/`.

**v4.2 — Beyond this network. ⏸ Paused.** `lib/tunnel.ts`, `/api/tunnel`, the dialog's second
tier. (**The `CF-Connecting-IP` rule and its test shipped early, in v4.1** — see above.) A
release after the gate on purpose: the gate protects a network you chose to be on, this hands
the same port to the internet. Detailed in `v4.2-tunnel.md`. *The curl-driven half of the gate
held: a tunneled request was provably refused the library, `?full=1`, the settings, `/api/tunnel`
itself and every board but the shared one, while the shared one answered. The operator's half —
the link opened from a phone on cellular — was the remaining check flagged above, and it
**failed**: the shared board answered with an HTTP 500, not a board. Not yet reproduced outside
that phone. The dialog's tier-2 button is hidden pending a fix.*

**Two things this plan got wrong, corrected in that release — plus a third, unresolved:**

1. **A Cloudflare quick tunnel does not carry a stream.** It buffers a response body until it
   *ends* — measured against a probe route and confirmed against a raw Node server with no Next
   involved, unchanged by content-type, padding, compression, HTTP version or frame size. This
   plan assumed v4.0's SSE would simply travel. It does not, and a tunnel guest would have seen
   their edits merge invisibly. The fix is a long-poll delivery (`?since=<seq>`) the client falls
   back to **by silence**, plus a replay log and a sweep grace in `lib/hub.ts` — so
   `sync/route.ts`, `useSync.ts` and `lib/hub.ts` are modified by v4.2 where this plan expected
   none of them to be.
2. **`cloudflared` through `stage.js`/`verify-arch.js` is deferred**, not shipped here. The
   `SMARTI_CLOUDFLARED` seam exists and `resolveBinary` documents it; until that pass, a desktop
   build uses a `cloudflared` on `PATH` and greys the tier out otherwise, which is the designed
   fallback rather than a broken state. It is a ~30–40 MB fetch per installer and cannot be
   verified without producing one, so it earns its own release.
3. **A real browser through a real tunnel 500s on the shared board, and this plan had no way
   to catch it before shipping.** The verification matrix above was curl-only, by the repo's
   no-browser-testing rule, and curl against the same live tunnel does not reproduce the
   failure — so whatever's wrong is specific to the browser's request path. This is why the
   dialog's tier-2 button is currently hidden and why `v4.3` waits on this being fixed.

**v4.3 — Shared with me.** The `remotes` table, the "Shared with me" group, the origin-prefix
refactor — the link opens in the guest's **installed app**. Lands alone: largest diff, only
phase touching the guest's database.

**Deferred: presence.** Most visible, least load-bearing; built early it spends the polish
budget on cursor colours before the merge engine has been used in anger. It stayed out of
v4.0 for exactly that reason and is still unbuilt.

## Files

**v3.6** — *new* `lib/sync.ts`, `lib/sync.test.ts`, `app/api/boards/[id]/sync/route.ts`,
`components/canvas/useSync.ts`; *mod* `Board.tsx` (autosave seam).

**v4.0** — *new* `lib/hub.ts`(+test); *mod* `lib/store.ts` (`applyRemote`, rebasing),
`sync/route.ts` (SSE GET, broadcast), `suggest/route.ts` (lease), `useSync.ts` (the stream),
`Board.tsx` (the ghost's lifecycle frames), `store.test.ts`.

**v4.1** — *new* `lib/access.ts`(+test), `lib/share.ts`(+test), `lib/shareToken.ts`,
`app/api/boards/[id]/share/route.ts`, `components/ShareDialog.tsx`; *mod* `lib/hub.ts`(+test,
the registry), every API route (the guards), `components/BoardChrome.tsx` (Share, guest
chrome), `useSync.ts`/`Board.tsx`/`IdeasPanel.tsx` (`apiFetch`), `app/globals.css`,
`desktop/main.js`, `start.sh`, `next.config.ts`.

**v4.2** *(as built)* — *new* `lib/tunnel.ts`(+test), `app/api/tunnel/route.ts`; *mod*
`lib/hub.ts`(+test, the log and the grace), `sync/route.ts` (the `?since=` delivery),
`useSync.ts` (the fallback), `ShareDialog.tsx`, `app/globals.css`, `next.config.ts`.
`lib/access.ts` needed no change — the `CF-Connecting-IP` rule shipped in v4.1.
*Deferred:* `desktop/stage.js`, `desktop/verify-arch.js`, `desktop/main.js`.

**v4.3** — *mod* `lib/db.ts` (`remotes` only), `components/index/BoardIndex.tsx`, `Board.tsx`
and `IdeasPanel.tsx` (origin prefix).

**Presence** — *new* `presence/route.ts`, `PeerCursors.tsx`; *mod* `lib/store.ts`,
`app/globals.css`.

**Unchanged throughout:** `lib/graph.ts` (**no board-schema change**), the `boards` and
`settings` tables (**no migration**), `lib/transfer.ts` and import/export, `lib/ai/trigger.ts`,
`lib/ai/prompt.ts`.

## Verification

**No browsers, no screenshots** — visual checks are called out for the user.

- `npm test`:
  - `sync.test.ts` — `diffBoards` is minimal per mutation; `applyOps(prev, diffBoards(prev,
    next))` round-trips; malformed/unknown ops drop without throwing; **any batch applied twice
    leaves the board unchanged**; per-node merges resolve as specified.
  - `access.test.ts` — a token for board A refused on board B, the library list, `?full=1`,
    `/api/settings`, `PATCH`, `DELETE`; unknown/expired tokens refused; loopback unaffected;
    `SMARTI_TRUST_LAN` restores v2.5. **And: a loopback request carrying `CF-Connecting-IP` is
    not `local`** — the assertion standing between a tunnel and handing out the library.
  - `share.test.ts` — link round-trips, including no fragment and a junk fragment.
  - `store.test.ts` extended — `applyRemote`'s no-undo rule, stack rebasing, and the dirty-set
    skip (and that it stops skipping once the save acks).
- `npm run typecheck`, `npm run build`.
- Against `npm run dev`: hold the SSE stream with `curl -N`, POST ops from another shell,
  confirm the frame and `seq`. Two POSTs on **different** nodes both survive; two on the
  **same** node leave the later one, rest of board intact. Then the scoping matrix by hand from
  a non-loopback address: no token, wrong-board token, right token.
- `sqlite3 data/smarti.db` — merge landed with no field dropped; `remotes` is the only new table.
- Kill the SSE client mid-edit and reconnect: `hello` resyncs it. Then the harder half —
  reconnect **with a local edit unsaved**, and the host's other-card changes must land while
  the local edit survives and rides the next save.
- Quit the host: the share is dead on relaunch and `cloudflared` did not outlive the process.
- **v4.2, from a phone on cellular** (the only honest test): the link opens; the same hostname
  with the token removed reaches nothing; `curl` it at `/api/settings` and the library list and
  both refuse.
- **Visual:** cursors under pan/zoom, peer colors in three themes, one shared ghost, the two
  share tiers reading as different in kind, "Shared with me" reading as *not* your boards.
