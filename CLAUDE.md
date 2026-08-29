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
- `lib/store.ts` — board state, proposal slice, undo/redo stacks.
- `lib/ai/providers.ts` — the provider presets and `resolveConfigFrom`. Pure, node-free;
  the settings UI and the tests both import it. Adding a provider is one entry here.
- `lib/ai/config.ts` — `resolveConfig()`: the db row, then the env var. The only db-aware
  piece of the provider layer.
- `lib/ai/openai.ts` — the OpenAI-compatible wire flavor (z.ai, Ollama, LM Studio, vLLM…).
- `lib/ai/upstream.ts` — `short`/`classify`: how an upstream failure becomes words. Pure, shared
  by the two user-invoked settings routes.
- `lib/ai/trigger.ts` — when the AI may speak. Pure functions; tune here first.
- `lib/ai/prompt.ts` — system prompt (wedge-tuned) and the response schema. `serializeBoardContent` is the shared model's-eye view of the board.
- `lib/ai/ideas.ts` — the idea generator's JSONL wire format: `ideaFromLine`, `splitLines`, `ideaKey`. Pure.
- `lib/ai/ideas-prompt.ts` — the generator's prompt, token budget, and JSONL contract (no schema, by design).
- `lib/search.ts` — find & replace: `findMatches`, `planReplaceAll`, `markMatches`. Pure.
- `lib/placement.ts` — where a ghost lands. Pure.
- `lib/theme.ts` — the three themes and `normalizeTheme`. Pure, node-free; the layout, the
  settings UI, `lib/db.ts`, and the tests all import it.
- `lib/tutorial.ts` — the tutorial board's content: `tutorialBoard(id)`, `TUTORIAL_TITLE`.
  Pure, node-free; `lib/db.ts` (the seed) and the boards route (the restore link) import it.
- `components/canvas/` — `Board` (pan/zoom/drag), `NodeCard`, `GhostCard`, `EdgeLayer`, `PresentOverlay` (the v1.13 presentation chrome).
- `app/api/boards/route.ts` — the collection: list and create.
- `app/api/boards/[id]/` — `route.ts` (autosave, archive, delete), `suggest/route.ts` (the ghost call), `ideas/route.ts` (the streamed idea generator).
- `app/api/settings/` — `route.ts` (GET masked / PUT / DELETE), `test/route.ts` (the connection
  check), `models/route.ts` (the provider's model list, for the Model dropdown).
- `components/SettingsPanel.tsx` — the provider modal (⚙ / ⌘,).
- `app/page.tsx` + `components/index/` — the project library and its minimaps.
- `components/BoardChrome.tsx`, `components/BoardSwitcher.tsx` — board name, the Home button (to the index), and ⌘K switcher.
- `components/IdeasPanel.tsx` — the ideas drawer: SSE consumption, abort-on-close, fingerprint cache, per-idea Add.
- `components/ObjectivePanel.tsx` — the objective popover (⌘J): one textarea bound to `board.objective`.
- `components/SearchPanel.tsx` — the find bar (⌘F), plus `useSearchMatches`, which the canvas
  also reads to tint the hits.

## Product in one line

A web idea board where an AI continuously co-authors the board — proposing gap-fills and connections as you work — rather than responding to prompts on demand. One deliberate exception: a handful of candidate ideas, asked for explicitly (⌘.), streamed into a side panel and staged there until the user adds the ones that land.

## Hard constraints

These come from the brief and are not open to reinterpretation while implementing:

- **Structured graph, not a pixel canvas.** The board is typed nodes (idea text, type, position) and edges (relationships). Every feature, especially AI behavior, builds on that graph representation — this is what makes the AI reasoning tractable at all.
- **Three visually distinct layers on the board at all times:** user-placed content, AI proposals (muted "ghost" state), and jointly accepted content. AI output is never silently merged into user content — not in v1, not in later, more autonomous versions.
- **Every AI proposal is previewable and reversible in one action** (accept / reject / tweak).
- **Local interactions never block on inference.** Drag, type, and snap stay fully responsive while LLM reasoning runs in the background and streams back.
- **Function over flourish.** Skeuomorphic polish (marker cross-out animations, chalk textures, hand-drawn wobble) is explicitly rejected scope, not a nice-to-have — do not add it.

## v1 scope

Narrow by design. In scope: draggable text nodes on an infinite canvas, one relationship type, instant autosave (no save button), and exactly one *unsolicited* AI behavior — propose a gap-fill or connection as a ghost node with one-click accept/dismiss. The one *user-invoked* behavior is the idea generator (v2.0, replacing the read-only board summary that held the slot from v1.3 — see below).

Out of scope for v1: real-time multiplayer, freehand drawing/images/styling, cross-session personalization or long-term memory, any further AI behaviors. Do not build toward these speculatively.

## Intended architecture (once a stack is chosen)

React frontend over a canvas SDK with custom "idea node" shapes; a thin backend persisting board state as JSON (graph of nodes/edges) and making streamed LLM calls for the suggestion behavior. No real-time infrastructure in v1.

## Invariants added during v1 (hold these)

The brief left two things unspecified that turn out to decide whether the product feels
like a collaborator or a paperclip. Both are now settled:

- **Trigger policy** — the AI does not fire per keystroke. Debounce, a position-independent
  semantic fingerprint, a 3-idea floor, one live ghost at a time, and session memory of
  dismissals. All in `lib/ai/trigger.ts`.
- **Ghost frequency** (v2.1) — the debounce window is user-settable in Settings (4s default /
  10s / 30s / 1 min / Off), globally, stored as `ghost_delay_ms` in the settings row and
  delivered through `store.ghostDelayMs` (install-level: survives `beginLoad`, spends
  nothing). `Off` blocks with `reason: 'disabled'`, ranked after `privacy` in
  `shouldRequest`; it is not Privacy Mode — Ideas still works. Junk snaps to the default via
  `normalizeGhostDelay`, shared by the PUT route and `loadSettings`.
- **Undo semantics** — a suggestion *appearing* is never in the user's undo stack;
  *accepting* one is. Reversed, the board feels haunted.
- **Redo** (v1.7) — the mirror of undo, on ⌘⇧Z / ⌘Y. Any board mutation spends the redo
  stack, move/resize included (a redo snapshot is the whole board, so redoing after a drag
  would snap the card back); a board switch clears it; ghost arrival/dismissal spends
  nothing. Undo and redo both end the typing burst, so the first post-undo keystroke gets
  a snapshot of its own.
- **Per-board session state** — `store.beginLoad(id)` clears the undo and redo stacks, the
  live ghost, the selection, the viewport, and the trigger fingerprint before a board loads;
  dismissals live in `rejectedByBoard`, keyed by board id. Boards switch by client-side
  navigation inside one mounted canvas, so anything global leaks: ⌘Z would restore one
  board's snapshot into another and autosave would write it to the wrong id.
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
- **Configuration failures are loud exactly once** (v1.4). The ghost and the ideas panel keep
  failing quietly — an unsolicited collaborator that nags about setup is the paperclip.
  The settings panel's two user-invoked calls — `POST /api/settings/test` and
  `POST /api/settings/models` — are the only places that report upstream errors in words,
  and both fire on a button and nowhere else. Listing models on panel open, or on each
  keystroke of a key, would make the panel chatter at a provider unasked; it is one click,
  and the loaded list is discarded whenever the provider, key, or endpoint changes, because
  a catalogue belongs to the endpoint it came from. A model already typed or saved is never
  silently replaced by something from the list.
- **Idea generator** (v2.0, replacing the v1.3 board summary): user-invoked — the Ideas
  button or ⌘. opens the panel, and the in-panel launch button is the only thing that fires the
  request. It streams up to `IDEAS_MAX` candidate ideas with rationales, generated for the whole
  board, or — when a card is selected at launch — branching off that card. The summary was the
  weaker half of the pair: it described a board you had just written, behind the same 3-idea
  floor as the ghost, so a fresh board with an objective on it left the entire AI layer silent.
  Generating is what that moment wants.
  **The panel is a staging area, not a canvas layer.** Ideas never render on the board, so the
  one-live-ghost ceiling is untouched, and `addIdea` is the only bridge — the mirror of
  `acceptProposal`: it constructs a fresh node in the `accepted` layer with edges to its
  surviving anchors, pushes one undo snapshot, and bumps `lastMutationAt`. Ideas *arriving* is
  never in the undo stack; adding one is, exactly as with the ghost. An added item stays in the
  list marked `added` rather than vanishing — a list that reshuffles under the cursor makes the
  next click a gamble — and `addIdea` re-stamps `ideasFingerprint` so your own Add does not
  instantly read as stale.
  **The wire format is JSONL, one object per line** (`lib/ai/ideas.ts`), which is the whole
  reason the panel fills in progressively; it is also why no branch asks for schema-constrained
  output, and why the contract rides in the message for every provider. A line that doesn't
  parse is dropped in silence, never surfaced as an error.
  **Its floor is lower than the ghost's, and it is the only place the two policies differ:**
  `canGenerateIdeas` wants a non-empty objective *or* one substantive node, not `MIN_NODES`.
  The ghost needs structure because nobody asked it to speak; this was asked. This is also what
  finally makes the objective load-bearing rather than decorative. The route enforces the floor
  too (`too_thin`), as it enforces privacy.
  Everything else is the summary's discipline, kept: session-only and never persisted, cached
  by board fingerprint, `beginLoad` closes the panel which aborts the stream, an interrupted
  run is cancelled back to idle, and the panel never spends a token on its own — no fetch on
  mount (which also keeps it StrictMode-safe). Still exactly one unsolicited behavior and one
  user-invoked one.
- **Node resize** (v1.5, functional not flourish): drag a card's bottom-right corner to set
  width and height (`clampSize` minimums in `lib/graph.ts`; `resizeNode` in the store).
  Size follows the `moveNode` doctrine — presentation, not content: no undo snapshot, no
  `lastMutationAt` bump, never a token. Text still clips in a too-small card; the ghost
  stays default-sized, because a proposal is not content. `w`/`h` were already on every
  node and in the persisted JSON, so there was no schema change.
- **Smarti Objectives** (v1.8): one freeform 400-char string on the board (`Board.objective`,
  `OBJECTIVE_MAX` in `lib/graph.ts`) saying what this board is for, opened with ⌘J or the
  Objective button. It is the inverse of the title: the title is a name the model never sees,
  so `setTitle` spends nothing; the objective leads both prompts, so `setObjective` snapshots
  for undo, bumps `lastMutationAt`, and joins the fingerprint — rewriting it lets the ghost
  answer the new framing on an otherwise unchanged board. It is user-written and stays that
  way: no model call ever writes, condenses, or restates it, and the ghost is told never to
  propose it back as an idea. The cap is the whole "keep it short for the AI's sake"
  mechanism; a condense-button would have been a third AI behavior. What the AI gains is that
  `serializeBoardContent` leads with it (only when non-empty) and the idea generator aims
  *at* it — still exactly one unsolicited behavior and one user-invoked one. Not a node,
  so it never counts toward the 3-idea floor and never becomes the derived title; it rides in
  the board JSON like `title`, and `parseBoard` defaults it to `''` so older rows load fine.

- **Privacy Mode** (v1.9): one boolean on the board (`Board.privacy`) meaning "nothing on
  this board is sent to a model", toggled with ⌘⇧P or the Private button. It disables *both*
  AI behaviors, the user-invoked generator included — a toggle that silenced the ghost while ⌘.
  still shipped the whole board upstream would be a privacy control that isn't one. It is
  per-board, not install-level, and deliberately so: privacy is a property of the content, and
  un-configuring the provider is the blunt instrument this replaces — you keep your key and
  silence one board. **The client is a convenience; the routes are the guarantee.**
  `shouldRequest` and `canGenerateIdeas` both return privacy first, ahead of every other
  reason, but `/suggest` and `/ideas` each refuse on their own, checking the *stored* board
  (the caller is not the authority) as well as the posted one (autosave lags the toggle, and that window must not
  leak). It spends nothing — no undo snapshot, no `lastMutationAt` bump, and it is not in the
  fingerprint, because the model never sees it; turning it off therefore does not itself wake
  the ghost, the next real edit does. **And it is never in the undo stack, in either
  direction:** `undo`/`redo` pin the live flag over the snapshot's, because a ⌘Z that silently
  put a board back on speaking terms with a model is the one undo nobody can see. Turning it
  on clears a live ghost without routing it through `rejectedByBoard` — the user silenced the
  board, they did not turn that idea down. `parseBoard` defaults it to `false` (strictly
  `=== true`, so junk off the wire never reads as private) so older rows load fine, and it
  rides the board JSON like `title`. Still exactly one unsolicited behavior and one
  user-invoked one.

- **Themes** (v2.2): three appearances — Light (default), Dark, and Neon — chosen in
  Settings and stored as `theme` in the settings row. **Install-level, like the provider
  config and unlike Privacy Mode**, and for the mirror-image reason: privacy is a property
  of the *content*, so it lives on the board; appearance is a property of the *room*, so it
  lives on the install. It is the cheapest thing in the app: no undo snapshot, no
  `lastMutationAt` bump, not in the fingerprint, never in a prompt, no model call, and no
  entry in `lib/store.ts` at all — nothing in JS reads it, CSS does. The default is Light and
  deliberately does *not* follow `prefers-color-scheme`: repainting every existing board the
  first time the app opens on a dark-set machine is an appearance change nobody asked for.
  `normalizeTheme` (`lib/theme.ts`) is shared by the PUT route and `loadSettings` exactly as
  `normalizeGhostDelay` is, because an unknown value means a `data-theme` no stylesheet
  answers to — an unstyled board, which is worse than a wrong one.
  **The root layout stamps `data-theme` on `<html>` server-side** from `loadSettings()`
  (`app/layout.tsx`, `force-dynamic`), so a dark install never flashes light while a client
  fetch resolves; `SettingsPanel` writes the attribute directly after a save so the change
  lands without a reload. That attribute is the entire client-side surface of the feature.
  **This is not the "flourish" the brief rejects** — that rules out skeuomorphic decoration
  (marker animations, chalk texture, wobble), and a theme is legibility under different
  lighting. Still exactly one unsolicited AI behavior and one user-invoked one.
  **Every color in `app/globals.css` now lives in a token block**, which is the only reason
  a palette override is enough — a new hardcoded `#fff` is a hole in two themes at once, so
  add a token instead. **And each theme owes an explicit answer to the three-layer
  invariant**, since a palette can quietly break the brief's one hard visual constraint:
  Light tints the proposal blue on white and speaks through a dark tooltip; Dark raises user
  cards out of the canvas and *recesses* the ghost into it, flipping the tooltip to the
  lightest surface in the theme (the doctrine was never "dark", it was "the tonal opposite
  of the board"); Neon makes it a rule instead of a shade — solid content blooms and **the
  ghost is the only thing on the board that does not glow** — and gives the AI cyan among
  greens so a proposal never reads as a dimmer copy of the user's own work.

- **Tutorial board** (v2.3): onboarding as *content, not chrome*. A first run seeded an empty
  library and one sentence, and the app's entire help was a hover tip on a `?` nobody had a
  reason to hover. Rather than a coach-mark layer over the canvas — a state machine, a panel,
  something to dismiss — the tutorial is an ordinary board whose cards each teach one gesture
  and are positioned so that reading them *is* performing the gesture: the resize lesson ships
  at the size floor with more text than it can show, the connect lesson ships the board's one
  deliberately unlinked card, the create lesson has empty canvas beside it. The board is the
  interactive medium already; a second one would have been the paperclip.
  **It is an ordinary board in every other way** — editable, archivable, deletable, autosaving,
  counted in the index — and wrecking it is allowed, because editing is the lesson. It is
  therefore not a mode, not a template type, and not a field on `Board`: nothing in the schema
  knows it exists. `tutorialBoard(id)` is pure and generates fresh ids per call, so two copies
  may coexist and no id is ever hardcoded.
  **It seeds on an empty file and nowhere else.** `seedIfEmpty()` guards on `COUNT(*) = 0` over
  `boards` — a row count, not a flag, so there is no column and no migration; archived boards
  are still rows, so archiving everything does not re-seed, while deleting everything does,
  which is the right reading of a library someone emptied. `createBoard` took an optional
  prebuilt board rather than growing a second write path. The library's quiet "Open the
  tutorial board" link (`template: 'tutorial'` on `POST /api/boards`) is the door back; an
  absent, malformed, or unknown body falls through to a blank board, because creating a board
  must never be refusable.
  **No ghost is seeded, and none can be** — `Layer` is `'user' | 'accepted'` and a proposal is
  never a node. The board *describes* the ghost and *shows* the accepted layer with one card,
  which is also what teaches the three-layer invariant. It is **not** private: a ghost arriving
  here unasked is the best demonstration the product has, and one card says so. Its objective
  is load-bearing rather than decorative — a non-empty one is what satisfies `canGenerateIdeas`,
  so ⌘. is live on it from the first second. It spends no tokens on its own and adds no AI
  behavior: still exactly one unsolicited and one user-invoked.

- **Search and Replace** (v2.4): ⌘F opens a find bar over the board — every card and the
  objective, never the title. **Finding spends nothing**: no undo snapshot, no redo spend, no
  `lastMutationAt` bump, never a token, and deliberately absent from the fingerprint, because
  looking for a word you already wrote says nothing new about the board. It is the selection's
  doctrine, not the objective's. **Replacing is an ordinary content edit** and takes the
  ordinary doctrine: `replaceText` is the one action for both Replace and Replace All (a single
  replace is the batch of one, exactly as `deleteNode` delegates to `deleteNodes`), with **one**
  undo snapshot and **one** `lastMutationAt` bump for the whole batch — a board-wide rename is a
  single ⌘Z, and it is allowed to wake the ghost afterwards because the board now says something
  different. Looping `setNodeText` would give one undo step per card: its coalescing is keyed on
  node identity with no timer.
  **It searches what the reader sees, not what is stored.** Card text carries inline markers, so
  matching runs on `stripMarks` output and every offset in `lib/search.ts` is an offset into
  that; `stripMarksWithMap` (`lib/richtext.ts`) is the way back, and `sourceRange` is the rule
  that decides whether a match can be written to at all. **A match that straddles a marker pair
  is found, tinted, and never replaced** — `he**llo**` reads as one word but splicing it would
  delete half the pair and restyle the rest of the card — and the panel *says* it skipped one,
  because a match still sitting there after you pressed the button reads as a bug. The
  replacement itself goes in literally; this format has no escape mechanism, and inventing one
  is a bigger change than this feature.
  The objective is searched as plain text (it is typed into a bare textarea and never parsed),
  and its matches are shown **in the bar**, not by throwing ⌘J over the board you are searching.
  The title is deliberately not searchable: it is the one field the model never sees and
  `setTitle` spends nothing, so replacing in it would need a third doctrine. The ghost is not
  searchable either, because a proposal is never a node. Matches are **derived, never stored**,
  so there is nothing to invalidate when a card changes underneath them; `beginLoad` clears the
  whole slice and entering presentation closes the bar, for the same reason there is no
  selection ring on a projector. Two new tokens (`--find-bg`, `--find-active-bg`) with the usual
  three-theme answer: amber against Light's blue ghost, amber on the raised card in Dark where
  the ghost is recessed, and in Neon a flat magenta **fill** — never a bloom, because glow is
  the one property that marks a proposal as provisional. No model call anywhere in it: still
  exactly one unsolicited AI behavior and one user-invoked one.

Also: the brief's pitch line about "reorganizing ideas as you add them" is **not** built and
should be cut from the pitch. Reorganizing means moving nodes the user placed — the most
trust-breaking action available, and outside the one-unsolicited-behavior rule.
