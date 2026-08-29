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
  and summarize routes; third parties get plain Messages calls.
- `ANTHROPIC_API_KEY` — server-side only, optional, now the headless fallback.
- `SMARTI_DB_PATH` — SQLite file, default `./data/smarti.db`. `data/` is runtime state.

## Hard constraints from the brief

- **Function over flourish:** no skeuomorphic/decorative polish (marker cross-out animations, chalk textures, hand-drawn wobble). Do not add visual flourish; it is explicitly rejected scope.
- **Data model:** the board is a structured graph of typed nodes and edges, not a freeform pixel canvas. All features — especially AI behavior — build on the graph representation.
- **Trust model:** AI output lives in a visually distinct "ghost" layer; every AI proposal must be previewable and reversible via a single accept/reject action. Never silently merge AI edits into user content, even in later versions. Concretely: a proposal lives in `store.proposal`, never in `board.nodes`; accepting constructs a *new* node and discards the proposal object.
- **Latency:** local interactions (drag, type, snap) must never block on AI/LLM reasoning. LLM responses stream back asynchronously.
- **v1 scope is narrow by design:** draggable text nodes on an infinite canvas, one relationship type, instant autosave, and exactly one *unsolicited* AI behavior (gap-fill/connection ghost node). v1.3 adds one *user-invoked* behavior: the read-only board summary. Explicitly out of scope for v1: real-time multiplayer, freehand drawing/images/styling, cross-session personalization or long-term memory, any further AI behaviors. (Provider
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
- **Board summary** (v1.3): the second AI behavior — user-invoked (the Summary button or ⌘.
  opens the panel; the in-panel launch button fires the request), streamed, read-only prose in a
  side panel. It is not a proposal: it never becomes a node or edge, never touches the derived
  title, never enters the undo stack, and never persists — session-only, cached by board
  fingerprint so reopening costs nothing if the board hasn't changed. The panel never spends a
  token on its own — opening shows the cached summary or a launch button, nothing more (which
  also makes it StrictMode-safe: no fetch on mount). `beginLoad` closes the panel, which aborts
  the stream; an interrupted stream is cancelled back to idle, not left half-written.
  Same 3-idea floor as the ghost (`substantiveNodes` in `lib/ai/trigger.ts`).
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
  and a done-toggle invalidates the cached summary. Done nodes are still substantive and
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
  invite the model to fill it), and the summary prompt reads the board against it as its one
  forward-pointing observation. Still exactly one unsolicited AI behavior and one user-invoked.
  Not a node: it never satisfies the 3-idea floor and never becomes the derived title.
  `parseBoard` defaults it to `''`, so pre-v1.8 rows load unchanged — and `savePayload` in
  `components/canvas/Board.tsx` must carry it, since a PUT is a full replace.

- **Privacy Mode** (v1.9): `Board.privacy`, one boolean meaning the board's contents are
  never sent to a model. Toggled with ⌘⇧P or the Private button (never disabled — a board can
  be declared private before there is anything on it to keep private). It gates *both*
  behaviors: `shouldRequest` returns `{fire:false, reason:'privacy'}` as its first check, and
  `canSummarize` in `BoardChrome`/`SummaryPanel` drops the Summary button, because a summary
  ships the entire board upstream. That client-side half is politeness, not the promise:
  `app/api/boards/[id]/suggest/route.ts` and `.../summarize/route.ts` each refuse
  independently, testing `loadBoard(id).privacy` (the stored board is the authority — a stale
  tab or any non-canvas caller gets the same answer) *and* the posted `board.privacy` (which
  covers the up-to-`AUTOSAVE_MS` window where the browser is private and the row is not).
  `summarize` answers plain JSON `{summary:null, reason:'privacy'}`, the same non-SSE shape as
  `no_api_key`, which the panel renders as its own `'private'` status rather than an error.
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

The brief's "reorganizing ideas as you add them" is not built and should be cut from the
pitch — moving user-placed nodes is the most trust-breaking action available.
