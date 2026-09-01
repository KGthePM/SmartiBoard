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

cd desktop && npm install   # the Electron shell — a SEPARATE package, not a workspace
cd desktop && npm run dev   # stage the Next bundle, then launch the desktop shell
cd desktop && npm run dist:win     # / dist:linux — installers into desktop/dist/
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
- `lib/gesture.ts` — touch as arithmetic: `zoomAround` (the wheel and the pinch alike),
  `pinchViewport`, and the long-press constants. Pure, node-free.
- `lib/placement.ts` — where a ghost lands. Pure.
- `lib/reactions.ts` — the five card reactions: the closed set, `normalizeReactions`,
  `toggleReaction`. Pure, node-free. The one per-node mark the model never sees.
- `lib/theme.ts` — the three themes and `normalizeTheme`. Pure, node-free; the layout, the
  settings UI, `lib/db.ts`, and the tests all import it.
- `lib/collapse.ts` — how a done card is drawn: `cardView`, `viewRect`, `isBinned`,
  `binnedNodes`, and the `collapse_done` row codec. Pure, node-free.
- `lib/tutorial.ts` — the tutorial board's content: `tutorialBoard(id)`, `TUTORIAL_TITLE`.
  Pure, node-free; `lib/db.ts` (the seed) and the boards route (the restore link) import it.
- `lib/kanban.ts` — the Kanban template's content: `kanbanBoard(id)`, `KANBAN_TITLE`. Pure,
  node-free, the mirror of `lib/tutorial.ts`.
- `lib/templates.ts` — the template registry: `TEMPLATE_IDS`, `TEMPLATES`, `buildTemplate`
  (null, never a throw). Adding a template is one entry here plus its own pure module.
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
- `components/DoneBinPanel.tsx` — the Done bin drawer: the derived list of binned cards, with
  the peek and the un-cross. No actions of its own.

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

- **LAN access is opt-in per run** (v2.5): `./start.sh --lan` (or `SMARTI_LAN=1`) binds the dev
  server to every interface and prints the machine's LAN address, so a phone or tablet on the
  same network can open the board; with no flag the server listens on `127.0.0.1` only.
  **That default is itself the change.** `next dev` and `next start` bind every interface on
  their own, so before this the board was already on the LAN of every machine it ran on, quietly
  and with no way to say otherwise — the flag would have been a banner over a door that was
  open either way. So the npm scripts pin `-H ${SMARTI_HOST:-127.0.0.1}`, which makes loopback
  the thing you get by doing nothing (`npm run dev` by hand included) and the flag the only
  thing that widens it. `start.sh --lan` exports `SMARTI_HOST=0.0.0.0` rather than appending a
  second `-H`: one place decides the host. **The flag is the entire security model, which is why it is a flag.**
  The app has no login, no session, no cookie, no middleware and no per-user scoping — one
  SQLite file, one settings row, and every `/api` route answers whoever asks. Anyone who can
  reach the port can read and write every board and spend the configured provider key. That is
  a fine trade on a home network and a bad one on a café network, and the app cannot tell the
  two apart, so the operator decides each run. Adding a passcode was the alternative and was
  declined: it would put a first auth concept into a codebase that has deliberately had none,
  and a shared secret in the settings row is not the same thing as the multi-user story the
  brief rules out.
  **Nothing about the choice is persisted** — not in the settings row, not in a board, not in
  an env file — because a network binding belongs to the invocation, not the install; contrast
  the theme and the provider config, which are properties of the install and therefore stored.
  `next.config.ts` carries `allowedDevOrigins` for the three RFC 1918 blocks and `*.local`,
  without which Next 15 serves the page over LAN and then refuses its own API calls; it is set
  unconditionally because it affects `next dev` and nothing else, and a config that differed
  between the bound run and the unbound one would be a second thing to get wrong. Public ranges
  are deliberately absent: a tunnel or a port forward is a different decision than this one.
  No AI behavior, no new state, no token: still exactly one unsolicited and one user-invoked.

- **Touch** (v2.6): the same board, reached with a finger — the other half of LAN access, since
  what a phone on the network opens is a canvas built for a mouse. **It adds no gesture that a
  keyboard and mouse did not already have**, and that is the design: a finger gets the wheel and
  the Shift key back, nothing more. **Pinch** is the wheel (`lib/gesture.ts` — `zoomAround` is now
  the app's one piece of viewport algebra, and the wheel goes through it too, so both zooms anchor
  identically); a pinch zooms *and* pans, because two fingers that spread while sliding are doing
  both, and it scales from the start rather than accumulating per-frame ratios so a pinch that
  returns to where it began returns the viewport with it. **A long press is the Shift key** —
  a sweep on empty canvas, a membership toggle on a card, computed against the selection as it
  stood at press time so holding an unselected card cannot toggle off the selection its own press
  just made. A touch-only *mode* was the alternative and was declined: there is one selection
  model, now reachable two ways.
  **`touch-action: none` on `.viewport` is the load-bearing line** — without it the browser's own
  pan, pinch and double-tap-zoom answer first and the canvas gets what is left, which is nothing.
  Its reach is why `.card.editing textarea` opts back into `pan-y`: the property runs to every
  descendant, and a card holding more text than it shows must still be scrollable. The layout
  export in `app/layout.tsx` pins `maximumScale: 1` for the same reason — the board owns a zoom,
  and the browser must not own a second one — and `viewportFit: 'cover'`, which is what makes the
  `env(safe-area-inset-*)` on the five fixed chrome elements resolve to anything.
  **Pointer bookkeeping, not touch events.** The canvas was already on Pointer Events, so a finger
  drags a card with no new code; what was missing is a map of live pointers (two entries is a
  pinch), `pointercancel` (an iOS system gesture takes the pointer without a `pointerup`, and the
  drag stayed latched), and explicit capture. Capture is *why* the connect drop now resolves with
  `document.elementFromPoint` instead of `e.target.closest` — touch captures implicitly to the
  element the press began in, so every connection resolved to its own source port and silently did
  nothing. That was a bug on touch before this, not a limitation.
  **The capture is taken on the first real movement, never on the press** (v2.71, fixing a v2.6
  regression). A capture retargets the compatibility mouse events too, so a captured press sends
  its `click` and `dblclick` to the surface instead of the card they landed on: the card could no
  longer be opened for editing, and the surface read the double-click as bare canvas and answered
  it with a new node. `DRAG_SLOP` is now the one threshold that says a press became a gesture —
  the same 3px that already told a card drag from a click — and nothing is captured below it.
  Cheap to get wrong again: the card's own controls were unaffected only because each of them
  stops `pointerdown`, so the surface never saw the press and never captured it; the card body is
  the one press that bubbles.
  **Hover-only affordances are a reachability bug, not a style choice.** A control you cannot see
  is a control that does not exist, so the card's `×` joins its siblings on `.selected` (it was the
  odd one out, and cards could not be deleted from a phone), the library's archive `×` and the
  ghost's rationale stay visible under `@media (hover: none)`, and the `?` directions get a real
  press-to-pin toggle. Hit areas grow under `@media (pointer: coarse)` via a transparent `::after`
  — the drawn controls do not change size, because a card's furniture that fits a fingertip is a
  worse card for everyone.
  **Not the "flourish" the brief rejects**, by the same reading that admitted themes: that rules
  out skeuomorphic decoration, and this is reaching the controls that already exist. It spends
  nothing — no undo snapshot, no `lastMutationAt` bump, not in the fingerprint, never a token, no
  store field and no persisted state — and adds no AI behavior: still exactly one unsolicited and
  one user-invoked.

- **Card reactions** (v2.7): a fixed set of five marks — ❤️ 🔥 ❗ 😂 👎 — several at once
  per card (`node.reactions`, `lib/reactions.ts`), toggled from a strip below the card or
  with `1`-`5` on a single selection. **It is the first feature in the app that is
  deliberately user↔board and not user↔AI**, and that is the whole design: the model never
  sees a reaction. It is absent from `fingerprint` and absent from `serializeBoardContent`,
  so reacting cannot wake the ghost, cannot change a proposal, and cannot spend a token.
  Still exactly one unsolicited AI behavior and one user-invoked one — this adds neither.
  **It takes the title's doctrine, which nothing else had needed yet**: one undo snapshot
  per toggle (a misclick on an 18px target must be recoverable, so unlike a drag it is
  undoable) and the redo stack spent, but **no `lastMutationAt` bump** — the exact inverse
  of `done`, which is the same kind of deliberate per-card mark but is content the model
  reads. The two combine without a special case: `undo` bumps `lastMutationAt`
  unconditionally, but a reaction-only undo leaves the fingerprint identical, so
  `shouldRequest` still answers `no_material_change` and nothing fires.
  **The set is closed, like `PALETTE` in `lib/richtext.ts`.** A free emoji picker would
  make every card a different alphabet and the board would stop being scannable.
  `normalizeReactions` is shared by `parseBoard` and the tests the way `normalizeTheme` is:
  unknown keys are dropped, duplicates collapse, and the result is always in `REACTIONS`
  order, so two cards with the same marks render identically whatever order they were
  clicked in. A bad mark costs the mark, never the idea — the row still loads. Boards saved
  before v2.7 load with `[]`, so there was no migration.
  **Upvote/downvote *counts* were the original ask and were declined**: counts imply
  multiple voters, multiplayer is out of scope, and a count that is always 1 is a priority
  flag wearing a costume. ❗ and 👎 carry that meaning directly.
  All five slots are always in the layout and only their opacity changes — the glyph you
  are aiming at never moves between the resting card and the hovered one — and a *chosen*
  mark holds at full strength on an untouched card, the way `.card.done .tick` does,
  because it is what the card says rather than an affordance. The strip sits below the card
  (a card at the 48px height floor has no room to give) and clears the A± pair. The glyphs
  are full-color emoji that ignore the palette, so **the themed part is the chip behind
  them** (`--react-bg`, `--react-ring`): the card's own surface in Light, the *raised*
  surface in Dark (the opposite end of the scale from the recessed ghost), and in Neon the
  user's green, blooming — the reverse of the find highlight's ruling, because a hit is a
  machine's answer to a query while a reaction is the user's own content. The ghost is
  still the only thing on the board that does not glow. Reactions are also the one control
  that cannot take the coarse-pointer `-13px` treatment (five targets in a row cannot each
  be 44px under a 120px card), so the strip itself grows instead. They print, because a
  mark the person placed is content; they are inert under Present for free; they are not on
  the ghost (a proposal is never a node) and not in the minimap (which carries no `done`
  either).

- **Folding done cards** (v2.8; the dot in v2.9): behind a setting, a card crossed off with ✓
  minimizes — to a one-line stub, or to a 28px dot wearing nothing but the ▸ that opens it
  again. **It is a view of `done`, not a second piece of state**, and that rule decides
  everything else: there is no `collapsed` field on `IdeaNode`, no board-JSON change, and no
  migration. How a card is drawn is `cardView(node, collapseMode, expandedIds)` (`lib/collapse.ts`)
  — an install setting, a fact the node already carried, and a session-only peek — returning
  `'line' | 'dot' | null`. So it spends nothing: no undo snapshot, no redo spend, no
  `lastMutationAt` bump, not in the fingerprint, not in `serializeBoardContent`, never a token.
  `toggleNodeDone` keeps its own doctrine untouched, because `done` *is* content the model
  reads. Still exactly one unsolicited AI behavior and one user-invoked one.
  **The two halves sit on opposite sides of `beginLoad`**: `collapseMode` is install-level and
  deliberately absent from it, exactly like `ghostDelayMs`; `expandedIds` is cleared by it,
  beside the selection, because a peek at one board's folded card means nothing on the next —
  and a reload re-folds, since `done` is the truth and an expansion is only a look at it.
  Un-crossing a card retires its peek, so ✓ folds it again rather than reusing a look taken at
  an earlier version of the idea. The default is `full`, for the same reason Light is the default
  theme; `normalizeCollapseMode` is shared by the PUT route and `loadSettings` exactly as
  `normalizeTheme` is. Unlike the theme it takes the *store* channel rather than the
  `data-theme` attribute one, because JS reads it: the canvas needs it to decide geometry.
  **The third mode cost no migration**: `settings.collapse_done` stays one INTEGER column and
  gains a third value (`0 = full, 1 = line, 2 = dot`), so every v2.8 row already reads as the
  fold it had. The encoding is `modeToRow`/`modeFromRow`, beside the rule rather than spelled
  out in `lib/db.ts`.
  **`viewRect` is the load-bearing piece** — the node's `w`/`h` are never written (so expanding
  restores the exact size, and `clampSize` is untouched; the 28px stub is below `NODE_MIN_H`
  because that floor guards a manual *resize*, which this is not), so everything that draws
  board geometry must read `viewRect` or it points at bare canvas: the card, `EdgeLayer`'s
  center-to-center endpoints and the `.edge-x` that rides their midpoint, the connect-drag
  start, `nodesInRect` for the rubber band, and `placeProposal` — the last two gained an
  optional `rectFor` defaulting to `rectOf`. `fitViewport` is deliberately left on the true
  rects (⌘0 fits a little loose) and the index minimap is untouched, since `ThumbNode` carries
  no `done` at all.
  **A stub keeps its width; the dot gives it up, and that reversal is the whole of v2.9.** The
  v2.8 ruling was that narrowing would shuffle the columns the person arranged — but reclaiming
  that width turned out to be exactly what people who turned folding on were asking for, and it
  costs less than the ruling assumed: a card is anchored at its top-left, so every column keeps
  its left edge and only the right edge pulls in, and `node.w` is still never written. So the
  setting is three-way rather than a boolean, because the stub is not wrong for the people who
  chose it.
  **Presentation folds; print never does.** Present is the same board on a projector, but paper
  is a document and a fold loses text nothing on the page can recover — `PrintSheets` passes an
  empty map. The fold control sits top-centre, the one card edge with no affordance on it (✓
  top-left, × top-right, port right, resize bottom-right, A± bottom-left), so it lands the same
  on a full card and on a stub; it stays visible while folded (the one control that undoes the
  fold cannot be hidden by it) and takes the v2.6 touch treatment — always shown under
  `@media (hover: none)`, coarse-pointer hit area via `::after`. Double-clicking a stub expands
  it instead of opening a textarea it has no room for, and the card's React key carries the
  fold state so a card crossed off mid-edit comes back in its read view.
  **On a dot the ▸ is not a pip on the edge — it is the card's face**, and therefore the one
  control on a card that does *not* swallow its own `pointerdown`: a 28px circle has no surface
  left over to be dragged by, so the press falls through to the card and select, drag, the
  marquee and the v2.6 long-press all work unchanged. The click it ends with is guarded by
  `DRAG_SLOP` (now exported from `lib/gesture.ts`, since it decides the same question three
  times), because a browser fires `click` after a press and release on one element however far
  it travelled — without the guard every dot the person merely moved would open. **Clicking a
  dot opens it; dragging it moves it.** The ✓, the ×, the A± pair and the resize bracket are
  all off a dot — three 18px circles cannot share a 28px edge, and there is no height to resize
  — so a dot's identity is its place plus the card's own `title`, the readable text via
  `stripMarks`. The port stays and so do the reactions, chosen-marks-only on either fold — the
  print sheet's rule, since "all five slots always" is about aiming at a hover target. **A
  search hit inside a dot takes the highlight on the dot itself** (`.dot-hit`), because a match
  the bar counts but the board never shows reads as a bug, which is the find bar's own ruling
  about a skipped match. No new color tokens: a fold is the same surface, the same border, the
  same strike, and the three-layer invariant is untouched because a proposal is never done and
  the ghost never folds.

- **The Done bin** (v3.0): a fourth `CollapseMode`, and the last one — a done card leaves the
  canvas entirely and is listed in a drawer instead. It is the same ruling as v2.8/v2.9 taken
  to its end: **a view of `done`, not a second piece of state**, so there is no `binned` field,
  no board-JSON change, and — because `modeToRow`/`modeFromRow` are index-based —
  `bin = 3` in the existing `settings.collapse_done` INTEGER, so no migration and no new
  column. (The codec's one demand on the future: append to `COLLAPSE_MODES`, never reorder
  it — the array *is* the wire format.) It spends nothing: no undo snapshot, no redo spend,
  no `lastMutationAt` bump, not in the fingerprint, not in `serializeBoardContent`, never a
  token. Still exactly one unsolicited AI behavior and one user-invoked one.
  **Hiding is not moving, and that distinction is the whole feature.** A binned card keeps
  its `x`/`y`, its size, its edges and its reactions; turning the setting back to `full` puts
  every one of them back untouched. Moving cards the user placed is the one action the brief
  rules out, and an archive that emptied the canvas into a second store would be that action
  wearing a drawer. So the bin is *derived*: `binnedNodes(nodes, mode, expanded)` in
  `lib/collapse.ts`, newest first, computed wherever it is needed the way search matches are —
  a card that changes underneath it has nothing to invalidate, and the chrome's count and the
  panel's rows cannot disagree.
  **`viewRect(node, 'bin')` is a zero-size rect at the node's own position**, which is the
  honest answer for something the canvas is not drawing and also the useful one: `placeProposal`
  sees no obstacle there (a ghost may have the reclaimed space) and `nodesInRect` cannot catch
  it in the rubber band, both with no edit. The two places that *do* need to know ask `isBinned`:
  `Board.tsx` filters the card out of the render, and `EdgeLayer`'s `center()` returns null for
  a binned endpoint — the same answer it already gave for a missing node. The edge is not
  deleted; peek the card back and its lines come with it.
  **The panel adds no way to change a board that the board did not already have.** Its two
  controls are the two that existed: `▸` is `toggleExpanded`, the same session-only peek that
  opens a folded dot (a reload re-bins it, because `done` is the truth and a peek is only a
  look), and `✓` is `toggleNodeDone`, which is how a card leaves for good and keeps its own
  doctrine — an undo snapshot and a `lastMutationAt` bump, exactly as pressing D on the card.
  `binOpen` is session UI on the find bar's tier: cleared by `beginLoad` (a look at one board's
  finished work means nothing on the next) and closed by `setPresenting(true)` (a room is shown
  the board, not the drawer). `collapseMode` stays install-level and absent from `beginLoad`,
  beside `ghostDelayMs`. **The chrome button exists only in `bin` mode** — the other three folds
  leave the card on the canvas, where it is its own way back.
  **A hit inside a binned card is shown in the panel**, via the shared `RichTextView`, because
  a match the find bar counts but the board never shows reads as a bug — the same ruling that
  puts the highlight on a folded dot. Print still never folds (`NEVER_COLLAPSED`), so a binned
  card prints in place: paper is a document. **`lib/db.ts`, the settings route and
  `SettingsPanel` needed no change at all** — the select maps over `COLLAPSE_MODES` and
  `normalizeCollapseMode` already guards both sides of the wire, which is the v2.8 seams
  proving they were cut in the right place. The panel takes the *card's* palette (`--surface`,
  `--user-border`, `--ink`), not the ideas drawer's ghost tokens: nothing in it is a proposal,
  and the three-layer invariant is untouched, since a proposal is never `done` and the ghost
  never bins.

- **The Kanban template, and templates as a registry** (v3.0): a second board you can start
  from, and the thing that turned the `=== 'tutorial'` ternary in `POST /api/boards` into a
  lookup. `lib/templates.ts` is the registry — `TEMPLATE_IDS`, `TEMPLATES`, and
  `buildTemplate(v, id): Board | null`, which **returns null rather than throwing** so that an
  absent, malformed or unknown name still falls through to a blank board: **creating a board
  must never be refusable.** `createBoard(board?)` already took a prebuilt board, so there is
  no db change, no second write path and no migration; `lib/kanban.ts` is pure and node-free
  like `lib/tutorial.ts`, generating fresh ids per call so two copies may coexist.
  **A column is a position and nothing else.** Smarti has no column concept and is not getting
  one: the template ships four header cards (Backlog · Doing · Blocked · Done) at four x
  coordinates with ordinary cards beneath them, and nothing snaps, nothing is enforced.
  **Dropping a card under "Done" deliberately does not cross it off** — `done` is content the
  model reads (it is in the fingerprint and in the prompt), so a rule that set it from an x
  coordinate would make a *drag* start spending tokens and would quietly turn moving a card
  into an edit. The ✓ stays the person's to press; the template demonstrates the mark on one
  card and implies no rule.
  **Edges run header → card**, which is the one piece of structure a Kanban actually has: an
  edgeless board renders as a blank minimap and reads to the model as a pile of unrelated
  sentences, whereas this way the graph says which column each item is in — the point of
  keeping a typed graph rather than a pixel canvas. Its objective is load-bearing exactly as
  the tutorial's is: non-empty, so `canGenerateIdeas` is satisfied and ⌘. is live before the
  board has enough cards for the ghost's 3-idea floor.
  **It is an ordinary board in every other way** — every node in the `user` layer, no accepted
  card and no ghost (a proposal is never a node), editable, archivable, deletable, autosaving,
  counted in the index, and nothing in the schema knows it exists. It is not a mode and not a
  board type. In the library it is a tile beside "New board", because a template is a project
  starter; the tutorial link stays a quiet line in the header, because it is a door. ⌘K's
  create is deliberately left blank-only. No AI behavior, no new state, no token: still exactly
  one unsolicited and one user-invoked.

- **The desktop app** (v3.1): the same install in a different room. `desktop/` wraps the Next
  server in Electron and CI publishes Windows and Linux installers to GitHub Releases, so the
  answer to "how do I get this" stops being "clone it". **It adds nothing.** No feature, no
  state, no field on `Board`, no store entry, no undo snapshot, no `lastMutationAt` bump, not in
  the fingerprint, never a token, and no AI behavior: still exactly one unsolicited and one
  user-invoked. Nothing in `lib/` or `app/` knows it exists — the entire surface is `desktop/`
  plus one env-gated line in `next.config.ts`.
  **`desktop/` is a separate package on purpose, not a workspace.** `./start.sh` runs
  `npm install`, so Electron in the root `package.json` would make every clone-and-run user
  download 150 MB to launch a web server. Taxing the flagship install path to serve a second one
  is the wrong direction, so a root install is untouched by anything in that folder.
  **`output: 'standalone'` is gated on `SMARTI_DESKTOP`** for the same reason: `npm run build`
  produces exactly what it always did, and only the desktop staging asks for the extra bundle.
  `serverExternalPackages: ['better-sqlite3']` was already there and is what keeps the native
  module a `require` rather than a bundled module — removing it breaks the desktop build silently.
  **The database moves to `app.getPath('userData')`, and only in the packaged app.** A
  double-clicked icon has no meaningful cwd, so the default relative `./data/smarti.db` would
  create a fresh empty database wherever the OS started us — which reads as "my boards vanished",
  the exact failure `lib/db.ts` already logs its absolute path to guard against. `main.js` sets
  `SMARTI_DB_PATH` before forking and **`lib/db.ts` is untouched**: it already read that variable,
  and that seam is the whole reason packaging needed no application change.
  **Loopback only, and there is no `--lan` here.** The shell takes an OS-assigned free port on
  `127.0.0.1`. The v2.5 ruling is that binding wider is a decision an operator makes each run,
  and a double-clicked icon has no such moment — a desktop app that quietly served every board
  to the café network would be that ruling inverted. The clone-and-run path still has the flag.
  **The menu must not claim ⌘Z / ⌘Y / ⌘A.** `components/canvas/Board.tsx` owns undo and redo
  itself, and a menu accelerator is handled before the page ever sees the key — Electron's
  default `editMenu` would silently break the board's undo stack, the one reversibility
  guarantee the brief names outright. `main.js` therefore ships a minimal menu with cut/copy/
  paste and no undo, redo or select-all; the browser still handles all three natively inside a
  focused text field, which is the only place they mean something else.
  **The Electron version is pinned, and the pin is load-bearing.** better-sqlite3 publishes
  prebuilds only up to a particular Electron ABI (42 → ABI 146 as of 12.11.x), and
  `desktop/stage.js` fetches the matching one and swaps it over the Node-ABI binary the standalone
  trace copied in. Bumping Electron past that turns every build into a `node-gyp` compile on
  every runner — the same trade `scripts/check-node.js` refuses for the Node floor. The version
  is read out of `desktop/package.json` so there is one number, not two.
  **Every `dist:*` passes `--publish never`.** electron-builder enables publishing implicitly the
  moment a git tag exists and then fails resolving where to publish, so the scripts pass on an
  untagged checkout and break on the exact commit being released — which is how this first went
  out. The workflow uploads artifacts itself and electron-builder must never publish. There is
  deliberately no `repository` in `desktop/package.json`: it would satisfy the resolver and let a
  tagged build quietly upload a release rather than erroring, the worse of the two failures.
  **macOS is signed locally and never in CI.** GitHub's macOS runners bill at ten times a Linux
  one and the Developer ID lives in a keychain on the machine that has it, so a `.p12` in CI
  secrets would buy only a second place for it to expire — `npm run dist:mac` picks the identity
  up on its own and the `.dmg` joins the same draft release. Notarization is a flag
  (`--config.mac.notarize=true`) over stored `notarytool` credentials, not a code path.
  **Each `dist:*` stages for exactly one platform-arch pair**, because the native binary is
  specific to both; `desktop/verify-arch.js` is an `afterPack` hook that refuses a mismatch at
  pack time rather than letting it surface as a failed database call in a window that already
  opened.
  **The Windows and Linux builds are unsigned, and the README says so in words rather than
  leaving the OS to.** Signing is a fact about a certificate, not about the app. Auto-update is deliberately absent: an
  unsigned self-updater is a worse story than a Releases page.

Also: the brief's pitch line about "reorganizing ideas as you add them" is **not** built and
should be cut from the pitch. Reorganizing means moving nodes the user placed — the most
trust-breaking action available, and outside the one-unsolicited-behavior rule.
