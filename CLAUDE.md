# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

The v1 vertical slice is built. Docs:

- `smarti-board-project-brief.md` — the authoritative product spec. Read it in full before making architectural decisions.
- `AGENTS.md` — condensed agent-facing version of the same constraints.
- `README.md` — how to run it and how the trigger policy works.

Multiple boards ship as of v1.2 — `/` is the project library. Published at
https://github.com/KGthePM/SmartiBoard — installed by cloning it, so `.nvmrc`,
`.npmrc` (`engine-strict`), and `engines` are load-bearing: Node 22 or 24.

## Commands

```bash
./start.sh       # clone-and-run: provisions Node into .node/ if needed, installs, runs dev
npm install       # better-sqlite3 and esbuild need install scripts approved
npm run dev       # http://localhost:3000
npm test          # vitest: lib/**/*.test.ts
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

### Verification: no browsers

Verify with `npm test`, `npm run typecheck`, `npm run build`, and HTTP calls against
`npm run dev` (curl the API routes, check SQLite with `sqlite3 data/smarti.db`).

**Do not launch Chrome or any browser, and do not take screenshots, to test.** Not headless,
not via CDP, not to "just check how it looks." If a change needs a visual check, say so and
let the user look.

The model provider is configured in-app (⚙ / ⌘,) and stored in the database;
`ANTHROPIC_API_KEY` is a server-side fallback used only when nothing is saved. Keys are
server-side always. Unset is a supported configuration — the board works without AI
proposals. Board state and settings are one SQLite file at `SMARTI_DB_PATH`.

## Stack (decided, do not re-litigate)

| Decision | Choice |
|---|---|
| Canvas | Hand-rolled React + SVG/DOM. **Not** tldraw or Excalidraw. |
| License | AGPL-3.0-only |
| v1 wedge | Strategy / product ideation |
| LLM provider | Bring-your-own, chosen in-app (Anthropic / z.ai / z.ai Coding Plan / Ollama / custom OpenAI-compatible), stored in the local SQLite file. `ANTHROPIC_API_KEY` is the headless fallback. |
| Framework | Next.js App Router + TypeScript, single process |
| Persistence | SQLite via better-sqlite3, board stored as JSON |
| State | zustand (`lib/store.ts`) |
| Model | Default `claude-opus-5`: structured output, `effort: 'low'`, adaptive thinking. Anthropic-flavor third parties (z.ai Coding Plan) get plain Messages calls with a prompt-enforced JSON contract, same as OpenAI-flavor providers. |

## Where things live

- `lib/graph.ts` — the typed graph. Everything is downstream of this.
- `lib/boards.ts` — board identity: derived titles, graph minimaps, list summaries. Pure.
- `lib/richtext.ts` — inline text formatting (`**bold**`, `{{red|text}}`, …): parser, `stripMarks`, selection toggles. Pure.
- `lib/store.ts` — board state, proposal slice, undo stack.
- `lib/ai/providers.ts` — the provider presets and `resolveConfigFrom`. Pure, node-free;
  the settings UI and the tests both import it. Adding a provider is one entry here.
- `lib/ai/config.ts` — `resolveConfig()`: the db row, then the env var. The only db-aware
  piece of the provider layer.
- `lib/ai/openai.ts` — the OpenAI-compatible wire flavor (z.ai, Ollama, LM Studio, vLLM…).
- `lib/ai/upstream.ts` — `short`/`classify`: how an upstream failure becomes words. Pure, shared
  by the two user-invoked settings routes.
- `lib/ai/trigger.ts` — when the AI may speak. Pure functions; tune here first.
- `lib/ai/prompt.ts` — system prompt (wedge-tuned) and the response schema. `serializeBoardContent` is the shared model's-eye view of the board.
- `lib/ai/summary-prompt.ts` — the summary behavior's prompt and token budget (streamed prose, no schema).
- `lib/placement.ts` — where a ghost lands. Pure.
- `components/canvas/` — `Board` (pan/zoom/drag), `NodeCard`, `GhostCard`, `EdgeLayer`.
- `app/api/boards/route.ts` — the collection: list and create.
- `app/api/boards/[id]/` — `route.ts` (autosave, archive, delete), `suggest/route.ts` (the ghost call), `summarize/route.ts` (the streamed summary call).
- `app/api/settings/` — `route.ts` (GET masked / PUT / DELETE), `test/route.ts` (the connection
  check), `models/route.ts` (the provider's model list, for the Model dropdown).
- `components/SettingsPanel.tsx` — the provider modal (⚙ / ⌘,).
- `app/page.tsx` + `components/index/` — the project library and its minimaps.
- `components/BoardChrome.tsx`, `components/BoardSwitcher.tsx` — board name and ⌘K switcher.
- `components/SummaryPanel.tsx` — the summary drawer: SSE consumption, abort-on-close, fingerprint cache.

## Product in one line

A web idea board where an AI continuously co-authors the board — proposing gap-fills and connections as you work — rather than responding to prompts on demand. One deliberate exception: a read-only summary of the whole board, asked for explicitly (⌘.), streamed back, never merged.

## Hard constraints

These come from the brief and are not open to reinterpretation while implementing:

- **Structured graph, not a pixel canvas.** The board is typed nodes (idea text, type, position) and edges (relationships). Every feature, especially AI behavior, builds on that graph representation — this is what makes the AI reasoning tractable at all.
- **Three visually distinct layers on the board at all times:** user-placed content, AI proposals (muted "ghost" state), and jointly accepted content. AI output is never silently merged into user content — not in v1, not in later, more autonomous versions.
- **Every AI proposal is previewable and reversible in one action** (accept / reject / tweak).
- **Local interactions never block on inference.** Drag, type, and snap stay fully responsive while LLM reasoning runs in the background and streams back.
- **Function over flourish.** Skeuomorphic polish (marker cross-out animations, chalk textures, hand-drawn wobble) is explicitly rejected scope, not a nice-to-have — do not add it.

## v1 scope

Narrow by design. In scope: draggable text nodes on an infinite canvas, one relationship type, instant autosave (no save button), and exactly one *unsolicited* AI behavior — propose a gap-fill or connection as a ghost node with one-click accept/dismiss. v1.3 adds the one *user-invoked* behavior: the read-only board summary (see below).

Out of scope for v1: real-time multiplayer, freehand drawing/images/styling, cross-session personalization or long-term memory, any further AI behaviors. Do not build toward these speculatively.

## Intended architecture (once a stack is chosen)

React frontend over a canvas SDK with custom "idea node" shapes; a thin backend persisting board state as JSON (graph of nodes/edges) and making streamed LLM calls for the suggestion behavior. No real-time infrastructure in v1.

## Invariants added during v1 (hold these)

The brief left two things unspecified that turn out to decide whether the product feels
like a collaborator or a paperclip. Both are now settled:

- **Trigger policy** — the AI does not fire per keystroke. Debounce, a position-independent
  semantic fingerprint, a 3-idea floor, one live ghost at a time, and session memory of
  dismissals. All in `lib/ai/trigger.ts`.
- **Undo semantics** — a suggestion *appearing* is never in the user's undo stack;
  *accepting* one is. Reversed, the board feels haunted.
- **Per-board session state** — `store.beginLoad(id)` clears the undo stack, the live ghost,
  the selection, the viewport, and the trigger fingerprint before a board loads; dismissals
  live in `rejectedByBoard`, keyed by board id. Boards switch by client-side navigation
  inside one mounted canvas, so anything global leaks: ⌘Z would restore one board's snapshot
  into another and autosave would write it to the wrong id.
- **Multiple boards are persistence, not memory** — many named boards is not the
  "cross-session personalization" the brief rules out, and titles are derived from content
  in `lib/boards.ts`, never generated by a model. Still exactly one unsolicited AI behavior.
- **Text formatting** (v1.1, functional not flourish): bold/italic/underline/strike plus a fixed
  5-color palette, stored as inline markers inside `node.text` (see `lib/richtext.ts`). The AI
  paths always see `stripMarks()` output — formatting never changes the fingerprint, never
  reaches the prompt, and proposals are always plain text.
- **Provider config is install-level and the key is write-only** (v1.4). The user chooses
  a provider in Settings; it lands in the single `settings` row next to their boards, not
  in a board and not in the browser. The key enters via PUT and leaves only as a last-four
  hint — `GET /api/settings` must never return it, and no route may log it. A saved row is
  authoritative for its provider: someone who chose Ollama is never silently rescued onto
  an `ANTHROPIC_API_KEY` that happens to be exported, because that would send their ideas
  to a cloud API they had just declined. This is not the "model choice" the brief ruled
  out as speculative scope — the app is meant to be run locally by the person using it,
  and choosing who answers adds no AI behavior. Still exactly one unsolicited behavior.
- **Configuration failures are loud exactly once** (v1.4). The ghost and the summary keep
  failing quietly — an unsolicited collaborator that nags about setup is the paperclip.
  The settings panel's two user-invoked calls — `POST /api/settings/test` and
  `POST /api/settings/models` — are the only places that report upstream errors in words,
  and both fire on a button and nowhere else. Listing models on panel open, or on each
  keystroke of a key, would make the panel chatter at a provider unasked; it is one click,
  and the loaded list is discarded whenever the provider, key, or endpoint changes, because
  a catalogue belongs to the endpoint it came from. A model already typed or saved is never
  silently replaced by something from the list.
- **Board summary** (v1.3): user-invoked — the Summary button or ⌘. opens the panel, and the
  in-panel launch button is the only thing that fires the request. Streamed, read-only prose in
  a side panel — never a node, never the title, never undoable, never persisted. Session-only,
  cached by board fingerprint; `beginLoad` closes the panel, which aborts the stream, and an
  interrupted stream is cancelled back to idle. The panel never spends a token on its own — no
  fetch on mount (which also keeps it StrictMode-safe). Same 3-idea floor as the ghost.
- **Node resize** (v1.5, functional not flourish): drag a card's bottom-right corner to set
  width and height (`clampSize` minimums in `lib/graph.ts`; `resizeNode` in the store).
  Size follows the `moveNode` doctrine — presentation, not content: no undo snapshot, no
  `lastMutationAt` bump, never a token. Text still clips in a too-small card; the ghost
  stays default-sized, because a proposal is not content. `w`/`h` were already on every
  node and in the persisted JSON, so there was no schema change.

Also: the brief's pitch line about "reorganizing ideas as you add them" is **not** built and
should be cut from the pitch. Reorganizing means moving nodes the user placed — the most
trust-breaking action available, and outside the one-unsolicited-behavior rule.
