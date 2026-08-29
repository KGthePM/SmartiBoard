# AGENTS.md

## Repository state

Single Next.js App Router app — no monorepo, no CI. Git repo, published at
https://github.com/KGthePM/SmartiBoard. The v1 vertical
slice is built (hand-rolled canvas, SQLite, zustand). `smarti-board-project-brief.md` is
the authoritative product spec; `CLAUDE.md` has the stack table and file map; `README.md`
explains the trigger policy and layer model.

## Commands

```bash
./start.sh       # clone-and-run: provisions Node into .node/ if needed, installs, runs dev
npm install       # better-sqlite3 + esbuild have native install scripts — they must be allowed to run
npm run dev       # http://localhost:3000/board/demo
npm test          # vitest run (node env, only lib/**/*.test.ts)
npx vitest run lib/ai/trigger.test.ts   # single test file
npm run typecheck # tsc --noEmit
npm run build     # next build
```

**Node 22-26 only.** `.npmrc` sets `engine-strict=true`, so `npm install` on anything else
aborts before touching `node_modules` — deliberate: better-sqlite3 publishes prebuilds for
those versions only, and older Node silently falls back to a node-gyp compile that fails on
stock Debian/Ubuntu. `scripts/check-node.js` (`preinstall`) repeats the check with a
friendlier message, but it is a second net, not the gate: npm runs root lifecycle scripts
*after* reifying dependencies, so by then the native build has already been attempted.
`./start.sh` is the user-facing entry point and sidesteps all of it by fetching its own Node
into `.node/` when the system one is unsuitable.

There is **no lint script or lint config** — verify changes with `npm run typecheck` and
`npm test`.

**Never launch a browser or take screenshots to test.** Not Chrome, not headless, not CDP,
not "just to see how it looks." Verification is `npm test`, `npm run typecheck`,
`npm run build`, curl against `npm run dev`, and `sqlite3 data/smarti.db`. Visual checks are
the user's to make — say what needs looking at and stop there.

## Environment

- **Provider config lives in the database, not the environment.** The user picks a
  provider (Anthropic / z.ai / z.ai Coding Plan / Ollama / custom OpenAI-compatible) in the
  Settings panel; it lands in the single `settings` row. `lib/ai/config.ts` resolves it,
  falling back to the env var only when no row exists. Unset is a supported configuration:
  the board must stay fully usable without any model. Never send a key to the browser — GET
  returns a last-four hint and nothing more. The Coding Plan preset speaks the *anthropic*
  wire flavor to `https://api.z.ai/api/anthropic` — a plan key has no balance on the general
  z.ai API, which is why it is a separate preset. SDK extras (adaptive thinking,
  `output_config`, prompt caching) are gated to `provider === 'anthropic'` in the suggest
  and ideas routes; third parties get plain Messages calls.
- `ANTHROPIC_API_KEY` — server-side only, optional, now the headless fallback.
- `SMARTI_DB_PATH` — SQLite file, default `./data/smarti.db`. `data/` is runtime state.

## Hard constraints from the brief

- **Function over flourish:** no skeuomorphic/decorative polish (marker cross-out animations, chalk textures, hand-drawn wobble). Do not add visual flourish; it is explicitly rejected scope.
- **Data model:** the board is a structured graph of typed nodes and edges, not a freeform pixel canvas. All features — especially AI behavior — build on the graph representation.
- **Trust model:** AI output lives in a visually distinct "ghost" layer; every AI proposal must be previewable and reversible via a single accept/reject action. Never silently merge AI edits into user content, even in later versions. Concretely: a proposal lives in `store.proposal`, never in `board.nodes`; accepting constructs a *new* node and discards the proposal object.
- **Latency:** local interactions (drag, type, snap) must never block on AI/LLM reasoning. LLM responses stream back asynchronously.
- **v1 scope is narrow by design:** draggable text nodes on an infinite canvas, one relationship type, instant autosave, and exactly one *unsolicited* AI behavior (gap-fill/connection ghost node). v2.0 holds the one *user-invoked* slot: the idea generator (it replaced the read-only board summary that held it from v1.3). Explicitly out of scope for v1: real-time multiplayer, freehand drawing/images/styling, cross-session personalization or long-term memory, any further AI behaviors. (Provider
  choice is now in — see Environment. It adds no AI behavior; it only says who answers.)

## Settled decisions — do not re-litigate

1. License: **AGPL-3.0-only**.
2. Canvas: **hand-rolled** React + SVG/DOM. Not tldraw, not Excalidraw.
3. Wedge for v1: **strategy / product ideation**.
4. LLM key: **bring-your-own**, server-side env var. Unset must keep the board usable.

## Two invariants added during v1

- **Trigger policy** (`lib/ai/trigger.ts`): the AI never fires per keystroke. Debounce, a
  position-independent fingerprint (dragging must not spend a token), a 3-idea floor, one
  live ghost at a time, session memory of dismissals.
- **Undo**: a suggestion *appearing* is never undoable; *accepting* one is.
- **Redo** (v1.7): ⌘⇧Z / ⌘Y or the chrome button walks an undone edit back in. Any change to
  the board spends the redo stack — moves and resizes included, because a redo snapshot is
  the whole board and redoing after a drag would snap the card back. Ghost arrival and
  dismissal spend nothing (they are not edits); accepting spends it (it is one). Undo and
  redo both end the typing burst (`lastTextEditId` reset), so the first keystroke after
  either gets a snapshot of its own.
- **Session state is per board** (v1.2): `store.beginLoad(id)` clears the undo and redo
  stacks, the live ghost, the selection, the viewport, and the trigger fingerprint before a
  board loads; dismissals are keyed by board id in `rejectedByBoard`. Global session state
  would let ⌘Z restore one board's snapshot into another, which autosave would then write
  to the wrong id.
- **Text formatting** (v1.1, functional not flourish): bold/italic/underline/strike plus a fixed
  5-color palette, stored as inline markers inside `node.text` (see `lib/richtext.ts`). The AI
  paths always see `stripMarks()` output — formatting never changes the fingerprint, never
  reaches the prompt, and proposals are always plain text.
- **Idea generator** (v2.0, replacing the v1.3 board summary): the second AI behavior —
  user-invoked (the Ideas button or ⌘. opens the panel; the in-panel launch button fires the
  request), streamed, staged in a side panel. Up to `IDEAS_MAX` candidate ideas, each with a
  rationale, generated for the whole board or — when a card is selected at launch — branching
  off that card, anchored to it. **The panel is a staging area, not a canvas layer:** ideas
  never render on the board, so `MAX_LIVE_PROPOSALS = 1` is untouched, and `store.addIdea` is
  the only bridge — it constructs a *fresh* node (`layer: 'accepted'`) plus edges to surviving
  anchors, pushes one undo snapshot, and bumps `lastMutationAt`, exactly like `acceptProposal`.
  An added item stays in the list marked `added` rather than being removed, and `addIdea`
  re-stamps `ideasFingerprint` so your own Add does not read as stale.
  The wire format is **JSONL — one JSON object per line** (`lib/ai/ideas.ts`), which is what
  lets the panel fill in progressively; it is why no branch asks for schema-constrained output,
  and the contract rides in the message for every provider. Unparseable lines are dropped in
  silence, never surfaced. The panel never spends a token on its own — opening shows the cached
  list or a launch button, nothing more (which also makes it StrictMode-safe: no fetch on
  mount). `beginLoad` closes the panel, which aborts the stream; an interrupted run is
  cancelled back to idle, not left half-listed.
  **Its floor is deliberately lower than the ghost's:** `canGenerateIdeas` in
  `lib/ai/trigger.ts` needs a non-empty objective *or* one substantive node, not `MIN_NODES`.
  The ghost needs structure because nobody asked it to speak; this was asked, and an objective
  on a blank board is the moment it is worth most. The route enforces it too
  (`reason: 'too_thin'`).
- **Node resize** (v1.5, functional not flourish): drag a card's bottom-right corner to set
  its width and height, clamped to minimums (`clampSize` in `lib/graph.ts`). Size is
  presentation, not content — it follows the `moveNode` doctrine exactly: no undo snapshot,
  no `lastMutationAt` bump, never a token, and the fingerprint (text + topology only) is
  untouched by construction. Text clips inside a too-small card exactly as it always has;
  the ghost stays default-sized, because a proposal is not content. No schema change: `w`/`h`
  already lived on every node and in the persisted board JSON.
- **Done marking** (v1.6, functional not flourish): a node-level `done` flag — the
  whiteboard's crossed-off idea, rendered as a plain CSS strike plus muted text (no marker
  texture, no animation; the inline `~~strike~~` marker is per-selection emphasis and a
  different thing). Done is the deliberate exception to resize/move doctrine: the model is
  told which ideas are finished (`[user, done]` in `serializeBoardContent`, with a one-line
  legend) and the fingerprint includes it, so crossing an idea off is undoable (one
  snapshot per toggle) and *token-spending* — the ghost may wake once the debounce settles,
  and a done-toggle invalidates the cached idea list. Done nodes are still substantive and
  still connectable; a done idea is completed, not deleted. The toggle is a ✓ at the card's
  top-left corner (the ×'s mirror, always visible once done) or `D` on the selected card.
  `parseBoard` defaults absent/non-boolean `done` to false, so pre-v1.6 rows load unchanged.
- **Smarti Objectives** (v1.8): `Board.objective`, one freeform string capped at
  `OBJECTIVE_MAX = 400`, saying what the board is for. Opened with ⌘J or the Objective button
  (never disabled — writing it before there are ideas is the point); one textarea bound
  straight to the board, persisted by the same autosave a node edit uses, no Save button.
  It is the title's inverse: a rename is presentation and spends nothing, while the objective
  leads both prompts, so `setObjective` snapshots for undo, bumps `lastMutationAt`, and joins
  the fingerprint. Strictly user-written — no model call writes, condenses, or summarizes it,
  and the ghost is told not to propose it back as an idea; the cap is what keeps it short, not
  a model. `serializeBoardContent` leads with it only when non-empty (an empty header would
  invite the model to fill it), and the idea generator aims at it — which is what makes an
  otherwise empty board a board it can work from. Still exactly one unsolicited AI behavior and one user-invoked.
  Not a node: it never satisfies the 3-idea floor and never becomes the derived title.
  `parseBoard` defaults it to `''`, so pre-v1.8 rows load unchanged — and `savePayload` in
  `components/canvas/Board.tsx` must carry it, since a PUT is a full replace.

- **Privacy Mode** (v1.9): `Board.privacy`, one boolean meaning the board's contents are
  never sent to a model. Toggled with ⌘⇧P or the Private button (never disabled — a board can
  be declared private before there is anything on it to keep private). It gates *both*
  behaviors: `shouldRequest` returns `{fire:false, reason:'privacy'}` as its first check, and
  `canGenerateIdeas` (privacy first, as in `shouldRequest`) drops the Ideas button in
  `BoardChrome`/`IdeasPanel`, because generating ships the entire board upstream. That
  client-side half is politeness, not the promise:
  `app/api/boards/[id]/suggest/route.ts` and `.../ideas/route.ts` each refuse
  independently, testing `loadBoard(id).privacy` (the stored board is the authority — a stale
  tab or any non-canvas caller gets the same answer) *and* the posted `board.privacy` (which
  covers the up-to-`AUTOSAVE_MS` window where the browser is private and the row is not).
  `ideas` answers plain JSON `{ideas:null, reason:'privacy'}`, the same non-SSE shape as
  `no_api_key` and `too_thin`, which the panel renders as its own status rather than an error.
  `setPrivacy` spends nothing — no `pushUndo`, no redo-stack spend, no `lastMutationAt` bump —
  and `privacy` is deliberately absent from `fingerprint`, since the model never sees it; the
  cost is that turning it off does not itself wake the ghost, which the next edit does.
  `undo` and `redo` restore `{ ...snapshot, privacy: s.board.privacy }`: Privacy Mode is never
  in the undo stack in either direction, because a ⌘Z that re-enabled egress is invisible and
  unrecoverable. Turning it on nulls a live `proposal` directly rather than calling
  `dismissProposal`, which would poison `rejectedByBoard` with an idea nobody rejected.
  `parseBoard` defaults it to `false` via a strict `obj.privacy === true`, so pre-v1.9 rows
  load unchanged — and `savePayload` in `components/canvas/Board.tsx` carries it, since a PUT
  is a full replace.

- **Text size** (v1.10, functional not flourish): a node-level `fontSize`, one rung of the
  fixed ladder `NODE_FONT_STEPS = [12, 14, 17, 21, 26]` in `lib/graph.ts` (14 is the body
  font, so an untouched card renders exactly as it always did). Adjusted with the A− / A+
  pair at the card's bottom-left corner — the one corner without an affordance — revealed on
  hover/selection like the port and the ×; the ends of the ladder hold. It follows the
  resize/move doctrine exactly, because a card's font is presentation the model never sees:
  no undo snapshot, no `lastMutationAt` bump, never a token, and `fingerprint` is untouched
  by construction — a size change cannot wake the ghost or invalidate the cached idea list.
  It still spends the redo stack, because a redo snapshot is the whole board, font sizes
  included. The inline rich-text markers are per-selection emphasis and a different thing;
  per-phrase emphasis is already served by bold/underline/color, so size stays per-card.
  The ghost and every AI-constructed node (`acceptProposal`, `addIdea`) stay default-sized,
  because a proposal is not content. The card style sets `fontSize` inline and the textarea
  (`font: inherit`) and `.rt` read view inherit it, so the edit/read metrics mirror stays
  intact; text clips in a too-small card exactly as it always has. `parseBoard` snaps
  off-ladder numbers to the nearest rung and defaults junk (`snapFontSize`), so pre-v1.10
  rows load unchanged. No `savePayload` change: nodes ride along whole, like `done`.

- **Autosave indicator** (v1.11, functional not flourish): the save loop in
  `components/canvas/Board.tsx` now reports itself in the bottom-right status row — `Saved`
  (persistent, muted), `Saving…` (dirty through debounce and flight alike), and `Not saved —
  retrying…` (amber, the existing `--mark-amber`). A save is a 2xx or it is a failure: `!r.ok`
  takes the failure path, so an HTTP error no longer counted as saved sits unretried forever.
  Failures self-recover — while in error, a `SAVE_RETRY_MS` timer bumps a `retryNonce` that
  re-arms the autosave effect (`savedRef` is `''` in that state, so it always finds the board
  dirty); no keystroke is required. A monotonic `saveSeqRef` makes a late response from a
  superseded save a no-op, so typing over an in-flight save cannot be marked saved prematurely.
  Leaving a board no longer drops its tail edit: both exits (board switch, unmount to the
  index) kill the debounce timer with the effect cleanup, so `flushUnsaved` fires the pending
  PUT fire-and-forget — unsupervised, because no board is on screen to receive its outcome.
  `arrive` resets the indicator per board. `beforeunload` warns while unsaved (native prompt
  only, armed by `saveState !== 'saved'`). All presentation and reliability: component-local
  state beside the loop it reports on, no store change, no undo/redo impact, never a token.

- **Multi-select** (v1.12, functional not flourish): `selectedIds: NodeId[]` replaces the
  single `selectedId` — one source of truth for one card or many, mutually exclusive with
  `selectedEdgeId` as before, cleared by `beginLoad`, `undo`, and `redo`, and set to the new
  card by `addNode`/`addIdea`. Shift+click toggles a card into the selection; Shift+drag on
  empty canvas sweeps a marquee (`nodesInRect` in `lib/graph.ts`), and the plain drag still
  pans, exactly as it always has. Grabbing a card already in a multi-selection drags the
  whole set, with a click-vs-drag rule doing the splitting: a pointer that never carries
  beyond 3px of jitter collapses to that card on release, one that carries moves the set —
  without the rule a multi-selection could never be dragged. Selection is pure UI state: no
  undo snapshot, no redo spend, no `lastMutationAt` bump, never a token, absent from the
  fingerprint by construction. Two batch actions carry the doctrine: `moveNodes` is the
  `moveNode` doctrine batched — one `set()` per pointer event for the whole set, positions
  are presentation so no snapshot and no bump, but the redo stack is spent because a redo
  snapshot holds positions too (`moveNode` itself is gone; the one-card drag is a one-item
  call) — and `deleteNodes` is the multi-delete as **one** deliberate edit: one undo snapshot
  for the whole batch (one action, one undo step), one `lastMutationAt` bump, edges cascade
  via `removeNodes`, and only the deleted ids leave the selection. The card's × routes
  through it as the batch of one. Backspace/Delete deletes the whole selection; `D` stays
  single-card by decision — done is per-idea and fires only when exactly one card is
  selected. The marquee *replaces* the selection (an empty sweep clears, the same thing a
  plain click on empty canvas does); the ideas panel seeds a branch only from a lone
  selection, since a multi-selection has no single branch point. Persistent groups were
  considered and deliberately not built — a Group entity is schema and scope this version
  does not need. `sole` on `NodeCard` gates the empty-card auto-edit to a lone selection, so
  shift-clicking an empty card into a set does not jump it into editing, and double-click
  collapses the selection to the card being edited.

The brief's "reorganizing ideas as you add them" is not built and should be cut from the
pitch — moving user-placed nodes is the most trust-breaking action available.
