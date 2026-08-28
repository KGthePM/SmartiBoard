# AGENTS.md

## Repository state

Single Next.js App Router app — no monorepo, no CI. Git repo, published at
https://github.com/KGthePM/SmartiBoard. The v1 vertical
slice is built (hand-rolled canvas, SQLite, zustand). `smarti-board-project-brief.md` is
the authoritative product spec; `CLAUDE.md` has the stack table and file map; `README.md`
explains the trigger policy and layer model.

## Commands

```bash
npm install       # better-sqlite3 + esbuild have native install scripts — they must be allowed to run
npm run dev       # http://localhost:3000/board/demo
npm test          # vitest run (node env, only lib/**/*.test.ts)
npx vitest run lib/ai/trigger.test.ts   # single test file
npm run typecheck # tsc --noEmit
npm run build     # next build
```

There is **no lint script or lint config** — verify changes with `npm run typecheck` and
`npm test`.

**Never launch a browser or take screenshots to test.** Not Chrome, not headless, not CDP,
not "just to see how it looks." Verification is `npm test`, `npm run typecheck`,
`npm run build`, curl against `npm run dev`, and `sqlite3 data/smarti.db`. Visual checks are
the user's to make — say what needs looking at and stop there.

## Environment

- **Provider config lives in the database, not the environment.** The user picks a
  provider (Anthropic / z.ai / Ollama / custom OpenAI-compatible) in the Settings panel;
  it lands in the single `settings` row. `lib/ai/config.ts` resolves it, falling back to
  the env var only when no row exists. Unset is a supported configuration: the board must
  stay fully usable without any model. Never send a key to the browser — GET returns a
  last-four hint and nothing more.
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
- **Session state is per board** (v1.2): `store.beginLoad(id)` clears the undo stack, the live
  ghost, the selection, the viewport, and the trigger fingerprint before a board loads;
  dismissals are keyed by board id in `rejectedByBoard`. Global session state would let ⌘Z
  restore one board's snapshot into another, which autosave would then write to the wrong id.
- **Text formatting** (v1.1, functional not flourish): bold/italic/underline/strike plus a fixed
  5-color palette, stored as inline markers inside `node.text` (see `lib/richtext.ts`). The AI
  paths always see `stripMarks()` output — formatting never changes the fingerprint, never
  reaches the prompt, and proposals are always plain text.
- **Board summary** (v1.3): the second AI behavior — user-invoked (⌘. or the Summarize button),
  streamed, read-only prose in a side panel. It is not a proposal: it never becomes a node or
  edge, never touches the derived title, never enters the undo stack, and never persists —
  session-only, cached by board fingerprint so reopening costs nothing if the board hasn't
  changed. Opening the panel is the only automatic request; switching boards under an open panel
  shows a button instead of spending tokens, and `beginLoad` closes the panel, which aborts the
  stream. Same 3-idea floor as the ghost (`substantiveNodes` in `lib/ai/trigger.ts`).

The brief's "reorganizing ideas as you add them" is not built and should be cut from the
pitch — moving user-placed nodes is the most trust-breaking action available.
