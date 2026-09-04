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
- `lib/ai/ask.ts` — Ask's wire format (v5.4): `clampQuestion`/`QUESTION_MAX` (the first untrusted
  free-text string to reach a model turn), `splitAnswer`/`parseAnswer` (the `[[nodeId]]` citation
  markers), and `scopeBoard` (a selection narrowed to itself plus one hop). Pure, node-free.
- `lib/ai/ask-prompt.ts` — Ask's prompt, budgets (`ASK_MAX_TOKENS`, `ASK_MAX_CONTEXT_TOKENS`,
  `ASK_HISTORY_TURNS`), `fitHistory` (the client history re-fitted server-side), `fitMaxNodes`
  (the 40K walk that derives the serializer's `maxNodes`), and `askInstruction`. Mirrors
  `ideas-prompt.ts`. Pure, node-free; imports `estTokens` so the bytes÷4 heuristic stays one
  number in the codebase.
- `lib/search.ts` — find & replace: `findMatches`, `planReplaceAll`, `markMatches`. Pure.
- `lib/sync.ts` — the save path as a diff (v3.6): the `Op` union, `diffBoards`, `applyOps`.
  Pure, node-free; the hook and the sync route import the same functions. The node is the
  unit of merge and every op is idempotent — both are load-bearing, see the invariant below.
- `lib/hub.ts` — the room (v4.0): in-process pub/sub per board, pinned on `globalThis`, plus
  the ghost lease and, since v4.1, the share registry (a *sibling* map — `sweep` would revoke
  a token stored on `Room`). Since v4.2 also the replay log and `framesSince`, which is what
  the long poll resumes from, and the sweep grace that keeps a room alive across the gap
  between two polls. Server-only (timers, a process global) but node-free, so it tests
  directly.
- `lib/tunnel.ts` — the tunnel (v4.2): spawn `cloudflared`, parse the hostname off its output,
  hold at most one per install, die with the process. A sibling of `lib/hub.ts` and pinned on
  `globalThis` for the same reason, but it spawns, so it is **not** node-free; the two halves
  worth testing (`parseTunnelUrl`, `resolveBinary`) are pure and take their dependencies as
  arguments. Never fetches a binary.
- `lib/access.ts` — who is calling (v4.1): `decideAccess` (pure, node-free, the whole refusal
  matrix as a table) and the bound `accessFor` / `guardManage` / `guardBoard`. The
  `providers.ts`-vs-`config.ts` split again. **`local` is proved, never inferred** — see the
  invariant below.
- `lib/share.ts` — the share link (v4.1): `shareUrl`, `parseShareToken`. Pure, node-free; the
  token rides in the URL fragment, which no server ever receives.
- `lib/shareToken.ts` — the one DOM line for the above (`location.hash`, and `apiFetch`, which
  every client API call goes through). Kept out of `lib/share.ts` so that stays pure, exactly
  as `lib/download.ts` is kept out of `lib/transfer.ts`. Untested by design.
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
- `lib/swot.ts` — the SWOT template's content: `swotBoard(id)`, `SWOT_TITLE`. Pure, node-free,
  the mirror of `lib/kanban.ts` with quadrants in place of columns.
- `lib/mindmap.ts` — the Mind map template's content: `mindMapBoard(id)`, `MINDMAP_TITLE`.
  Pure, node-free; one hub, branches, one second-level branch.
- `lib/templates.ts` — the template registry: `TEMPLATE_IDS`, `TEMPLATES` (label, icon,
  blurb, build), `buildTemplate` (null, never a throw). Adding a template is one entry
  here plus its own pure module.
- `lib/folderboard.ts` — the folder import: `scanPaths`, `defaultIncluded`,
  `countIncludedFiles`, `includedFilePaths`, `buildFolderBoard` (phase 1's structure-only
  build, plus phase 2's optional third `enrich?: FolderEnrich` arg — summaries and import
  edges folded in as the board is born). Pure, node-free, deterministic (code-point sort);
  reads path strings only, never file contents itself — the AI pass reads contents in the
  modal and hands back the enrich payload, so an omitted `enrich` is byte-equal to phase 1.
  `lib/webkit.d.ts` holds the one ambient (`webkitdirectory`) the picker needs.
- `lib/importgraph.ts` — the folder import's AI pass, client-side half (phase 2): import
  links extracted and resolved **locally, for free** (`extractImports`, `resolveImport`,
  `buildImportEdges`), and summary eligibility (`partitionSummaries`, `chunkSummaries`,
  `estTokens`) — the numbers the consent screen shows before anything ships. Pure,
  node-free; also owns the secrets ruling (`isSecretFile`: `.env*`, `.pem`/`.key`/`.p12`/
  `.pfx` never ship, consent or no consent — links still read them, locally).
- `lib/ai/folder-prompt.ts` — the AI pass's system prompt and JSONL wire contract
  (`folderInstruction`, `summaryFromLine`, `summaryMaxTokens`), the idea generator's
  shape-mate: no structured output, one path-keyed line per file, everything unusable
  dropped in silence. See `app/api/folder-ai/route.ts`.
- `lib/transfer.ts` — boards as files: `fileNameFor`, `boardToFile`, `looksLikeBoard`,
  `readTransfer`, `declaredNodeCount`. Pure, node-free; the index and the tests import it.
- `lib/download.ts` — the one DOM line (`downloadJson`), kept out of `lib/transfer.ts` so
  that stays pure. Untested by design: the filename is where the logic is.
- `components/canvas/` — `Board` (pan/zoom/drag), `NodeCard`, `GhostCard`, `EdgeLayer`,
  `PresentOverlay` (the v1.13 presentation chrome), `useSync` (the autosave seam: debounce,
  indicator, retry, flush — sending ops since v3.6, holding the room's stream since v4.0, and
  since v4.2 falling back to the long poll when that stream proves to be buffered).
- `app/api/boards/route.ts` — the collection: list (`?full=1` for the export bundle),
  create, and import.
- `app/api/boards/[id]/` — `route.ts` (whole-board GET/PUT, archive, delete),
  `sync/route.ts` (the canvas's write path: POST a batch of ops, merged per node; GET the
  room's SSE stream — `hello`, `ops`, `ghost`, `ping` — or, with `?since=`, the same frames as
  a long poll, which is the delivery a Cloudflare tunnel can carry),
  `suggest/route.ts` (the ghost call), `ideas/route.ts` (the streamed idea generator),
  `ask/route.ts` (the v5.4 Ask call — the ideas route's refusal ladder and dual abort, prose
  `delta`/`done`/`error` frames, and a `done` frame carrying the card counts it actually sent),
  `share/route.ts` (mint / revoke / list the board's link and this machine's addresses).
- `app/api/tunnel/route.ts` — the tunnel (v4.2): GET state / POST open / DELETE close, all
  three install-scoped behind `guardManage`.
- `app/api/folder-ai/route.ts` — the folder import's AI pass (phase 2): the ideas route's
  idiom, install-scoped (no board exists yet, so no privacy check — the modal's consent
  screen is the gate). One batch of file contents in, streamed SSE `summary`/`done`/`error`
  frames out, or a plain-JSON `no_api_key` refusal.
- `app/api/settings/` — `route.ts` (GET masked / PUT / DELETE), `test/route.ts` (the connection
  check), `models/route.ts` (the provider's model list, for the Model dropdown).
- `components/SettingsPanel.tsx` — the provider modal (⚙ / ⌘,).
- `components/ShareDialog.tsx` — the share modal (the Share button): start/stop, one link per
  address, and the three caveats that are true the moment you press it.
- `app/page.tsx` + `components/index/` — the project library, its minimaps, the
  Template library modal (`TemplateLibrary.tsx`), and the folder import
  (`FolderImport.tsx`: pick or drop a folder, checklist with junk dirs
  pre-unchecked, warn past 300 files / stop past 1500 — client-side by doctrine;
  an optional AI pass on top — consent screen with real numbers, links then
  streamed summaries staged in the modal, Apply/Discard as the one accept/reject).
- `components/BoardChrome.tsx`, `components/BoardSwitcher.tsx` — board name, the Home button (to the index), and ⌘K switcher.
- `components/IdeasPanel.tsx` — the ideas drawer: SSE consumption, abort-on-close, fingerprint cache, per-idea Add.
- `components/AskPanel.tsx` — the Ask drawer (v5.4): the ideas drawer's whole lifecycle, plus a
  question input, a streaming multi-turn thread, and citation chips that reveal (and, if needed,
  peek) the card they point at. Deliberately no bridge onto the board.
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

Narrow by design. In scope: draggable text nodes on an infinite canvas, one relationship type, instant autosave (no save button), and exactly one *unsolicited* AI behavior — propose a gap-fill or connection as a ghost node with one-click accept/dismiss. Three *user-invoked* behaviors sit beside it: the idea generator (v2.0, replacing the read-only board summary that held the slot from v1.3 — see below), the folder import's AI pass (phase 2, see `private/folder-import-plan.md`) — import links (read locally, free) and per-file summaries (egress, on the user's key), offered only inside the folder-import modal and gated by its own consent screen rather than Privacy Mode, since it runs before any board exists — and Ask (v5.4, see the invariant below and `private/ask-plan.md`): questions about a board, answered read-only, which folder-import boards made honest — a board holding 300+ cards the person has never read is exactly the board worth asking about.

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
  8-color palette (five at v1.1; orange, rose and teal appended after v3.4), stored as inline
  markers inside `node.text` (see `lib/richtext.ts`). The AI
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
  mount (which also keeps it StrictMode-safe). Still exactly one unsolicited behavior and three
  user-invoked ones.
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
  *at* it — still exactly one unsolicited behavior and three user-invoked ones. Not a node,
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
  rides the board JSON like `title`. Still exactly one unsolicited behavior and three
  user-invoked ones.

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
  lighting. Still exactly one unsolicited AI behavior and three user-invoked ones.
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
  behavior: still exactly one unsolicited and three user-invoked.

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
  exactly one unsolicited AI behavior and three user-invoked ones.

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
  No AI behavior, no new state, no token: still exactly one unsolicited and three user-invoked.

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
  three user-invoked.

- **Card reactions** (v2.7): a fixed set of five marks — ❤️ 🔥 ❗ 😂 👎 — several at once
  per card (`node.reactions`, `lib/reactions.ts`), toggled from a strip below the card or
  with `1`-`5` on a single selection. **It is the first feature in the app that is
  deliberately user↔board and not user↔AI**, and that is the whole design: the model never
  sees a reaction. It is absent from `fingerprint` and absent from `serializeBoardContent`,
  so reacting cannot wake the ghost, cannot change a proposal, and cannot spend a token.
  Still exactly one unsolicited AI behavior and three user-invoked ones — this adds neither.
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
  reads. Still exactly one unsolicited AI behavior and three user-invoked ones.
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
  token. Still exactly one unsolicited AI behavior and three user-invoked ones.
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
  board type. In the index it was a tile beside "New board", because a template is a project
  starter (v3.4 moved that tile into the Template library modal); the tutorial link stays a
  quiet line in the header, because it is a door. ⌘K's
  create is deliberately left blank-only. No AI behavior, no new state, no token: still exactly
  one unsolicited and three user-invoked.

- **The SWOT and Mind map templates** (v3.2): the third and fourth boards you can start from,
  both `lib/kanban.ts`'s doctrine exactly — pure `(id) => Board` modules registered in
  `lib/templates.ts`, ordinary content, no schema, no db, and nothing snapped or enforced.
  **The SWOT's quadrants are positions, same as the Kanban's columns**: internal row on top
  (Strengths · Weaknesses), external below (Opportunities · Threats), header → card edges within
  each quadrant, and *no done card ships* because nothing in a SWOT is finished — the ✓ already
  has two demos and a crossed-off strength would imply a rule the board does not have. **The
  Mind map is the tree demo**: one hub (top font rung, dead center), four branches, and one
  branch with a child of its own, because a mind map that stops at one ring is a list — the
  child is the connect-dot lesson made visible, the whole board is a single tree (one root,
  every node parented once, so the minimap renders a star and the model reads a hierarchy), and
  the hub is not special: delete it and the spokes survive, like any card. Neither ships a done
  card; both ship a non-empty objective like the others, so ⌘. is live from the first second.
  In the index they were tiles beside the Kanban's, because templates are project starters —
  until v3.4's Template library gathered them.

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
  **`"publish": null` is in the build config, and no `GH_TOKEN` goes into a build's
  environment.** electron-builder reads that variable as intent to publish: it resolves a publish
  target in order to write an `app-update.yml` during `afterPack`, and fails the build outright
  when it cannot work out the repository. **`--publish never` does not prevent this** — the flag
  governs the upload, not the resolution — which is why the first release failed on CI while the
  identical command passed locally, where no token is set. `"publish": null` states the truth
  instead: there is no publish target, because there is no auto-update and the workflow uploads
  the artifacts itself. There is deliberately no `repository` field in `desktop/package.json`
  either — it would satisfy the resolver and let a tagged build quietly upload a release rather
  than erroring, the worse of the two failures. The `.deb` target additionally needs `homepage`
  and a `Name <email>` `linux.maintainer`; both are packaging metadata, not app configuration.
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

- **Import and export** (v3.3): a board leaves as a file and comes back as one. The app is
  loopback-only by design — no auth, no sync, no account — so a file is not one option among
  several, it is the only path a board has off the machine it was made on, and the machinery
  was almost entirely already there: `parseBoard` is a full untrusted-JSON validator,
  `createBoard(board?)` already took a prebuilt board (templates ride it), and
  `GET /api/boards/[id]` already returns the whole thing. **No schema change, no migration,
  no store field, no new board type, no undo/redo/`lastMutationAt`/fingerprint impact** — an
  import happens before that board's first `beginLoad` and an export is a read — and **no
  model is ever involved**: still exactly one unsolicited AI behavior and three user-invoked ones.
  **The format has no envelope, and the shape is the whole grammar: an object is a board, an
  array is boards.** `parseBoard`'s per-era tolerance *is* the versioning strategy — a file
  written today opens in a future version exactly the way an old row does — so a
  `{version, …}` wrapper would only be a second thing to keep true, and a bare file stays
  hand-editable and round-trippable through the existing PUT. The file is the board minus
  `id`; `privacy` and `updatedAt` travel, node ids are **preserved rather than reminted**
  (nothing keys globally on one — the store is per-board and `rejectedByBoard` is keyed by
  board id — and reminting would make two exports of one board undiffable), and settings and
  the API key are install-level and never in it.
  **The server always mints the id, and that is the one real safety requirement in the
  feature.** `saveBoard` upserts on id, so honouring a file's id would make import the only
  action in the app that can destroy a board. `boardToFile` therefore strips it rather than
  letting it ride along ignored: a field that is unconditionally discarded invites someone to
  believe overwrite-by-id works. **An import can only ever add.**
  **The refusal lives in the client, not the route.** "Creating a board must never be
  refusable" still holds — `POST {board: {"a":1}}` is a blank board, not a 400 — but the trap
  is that `parseBoard` turns *any* object into a blank board, so a plain is-it-an-object check
  would report success while importing nothing. `looksLikeBoard` (an object carrying `nodes`,
  `edges`, `title` or `objective`) is what says "not a Smarti Board file", and it says it in
  the library, where there is a person to say it to. It answers only that question; "this
  board is malformed" stays `parseBoard`'s, and `parseBoard` answers by dropping the bad part.
  **What was dropped is said out loud** — `declaredNodeCount` against the returned board's
  count — because silence is right for a database row nobody is watching and wrong for a file
  someone just chose. The find bar's own ruling: content the app counted but never showed
  reads as a bug. A clean single import redirects to the board like creating one does; a
  lossy one deliberately stays in the library, because the note is the point of it.
  **The bundle carries the working library, not the archive.** `allBoards()` excludes archived
  rows: imported boards arrive unarchived, so a bundle carrying them would resurrect on the
  new machine exactly what someone filed away on the old one. `?full=1` is opt-in on the
  existing GET because the ⌘K switcher wants summaries, and shipping every board's nodes to
  satisfy a dropdown would be the wrong default for the sake of one button.
  Nothing in `desktop/` — a blob download lands in Electron's standard save flow, and
  `main.js` installs no `will-download` handler. No new color tokens: the ⇩ is `.bcard-x`'s
  twin and Export is Print's sibling (both take the board out of the app unchanged, one to
  paper and one to a file), both taking the v2.6 touch treatment. Declined: a version
  envelope, reminting node ids, a route-level 400, drag-and-drop as a second ingestion path,
  and importing *into* an existing board — the upsert-on-id hazard for a case nobody asked for.

- **The Template library** (v3.4): every board you can start from, in one modal. The index's
  starter row had grown a tile per template — New, Kanban, SWOT, Mind map, Import — and the
  registry is append-only, so every new template would push the person's own boards further
  down their own home page. One "Template library" tile now opens a modal
  (`components/index/TemplateLibrary.tsx`) that renders `TEMPLATES` itself, so a template
  remains one registry entry and nothing else. **The registry carries its own copy**: `icon`
  and `blurb` live in `lib/templates.ts` beside `label` and `build`, because the descriptions
  used to be `title` tooltips on the index tiles — invisible to a finger, against the v2.6
  reachability rule — and hardcoded glyphs in the component would have made "one entry" two.
  The library's contract is tested: every entry must arrive with a non-empty icon and blurb.
  **The tutorial is in it and keeps its header line** — both are doors to the same ordinary
  board, and the quiet line stays for the person who already knows it's there. Same shell as
  every panel (backdrop, ×, Escape; the settings panel's geometry and material, just wider)
  and the same creation path: it calls the index's existing `create(template)` closure, so a
  successful pick navigates (unmounting the modal for free) and a failed one leaves it open
  with `busy` cleared. Pure index presentation — no route, db, store, schema, or undo/redo
  impact, no AI behavior, never a token.

- **Ops: the save path stops clobbering** (v3.6): the canvas autosaves **what changed**, not
  the document. Until this, `Board.tsx` PUT the whole board and `saveBoard` upserted on id
  with no version check, so **two browser tabs on one board destroyed each other's work,
  silently** — last writer wins, whole document. That is a single-user bug (a second tab, a
  second monitor) before it is a multiplayer blocker, which is why it ships alone as a fix
  and not as a feature. No UI, no networking, no security surface, no AI behavior, never a
  token: still exactly one unsolicited and three user-invoked.
  **`lib/graph.ts` is untouched and so are the tables** — the ops are a wire format, not a
  schema, which is the whole reason there is no migration and `parseBoard`, import and export
  are unaffected.
  **The node is the unit of merge** (`lib/sync.ts`, pure and node-free like `lib/search.ts`):
  one `node.put` is a whole-node replace, so a single op covers text, position, size, font
  step, `done` and reactions at once. Two people on *different* cards both win; two on the
  *same* card resolve LWW **on that card alone**, and nothing else on the board is in the
  blast radius. Field-level ops would cost a large op set and test surface to settle a
  collision nobody has.
  **`applyOps` takes `parseBoard`'s doctrine — total and tolerant.** An unknown `t` (an op
  from a newer version), a malformed node, a `node.del` for a gone id, a non-array batch are
  each dropped in silence and the rest of the batch lands: a bad op costs that change, never
  the batch and never a 500. It re-uses the existing guards rather than writing second ones —
  `createNode` + `snapFontSize` + `normalizeReactions` for a node, `removeNodes` for a
  delete (so a deleted card's edges leave with it), `TITLE_MAX`/`OBJECTIVE_MAX` and
  `privacy === true` for `board.set`, and no edges to nowhere.
  **Delivery is at-least-once, so every op must be idempotent.** All are for free except one:
  **`edge.add` upserts by id**, or a lost ack quietly doubles the line. The property is a
  test — any batch applied twice leaves the board exactly as applying it once did — and it is
  what lets the client re-send rather than reconcile.
  **`POST /api/boards/[id]/sync` is the only new write path**, and it needs no revision clock
  because better-sqlite3 is synchronous and this is one process: load, apply, save inside one
  handler tick cannot interleave, so **arrival order at a single process *is* the total
  order**. It caps the batch by op count and by bytes (a misbehaving peer costs a 413, not
  memory), treats an empty batch as a no-op that does not churn `updated_at`, and accepts a
  `clientId` it ignores, so the request shape survives a later live-update layer.
  **`PUT /api/boards/[id]` is deliberately unchanged** — import, hand-editing and whole-board
  writes still need a full replace, and it stays the honest fallback. It simply stops being
  what the canvas uses.
  **`components/canvas/useSync.ts` is a swap inside the existing autosave seam, not a new
  lifecycle.** The debounce, the monotonic send id, the saving/saved/error indicator, the
  `SAVE_RETRY_MS` self-heal and `flushUnsaved` all moved out of `Board.tsx` unchanged; only
  the body is different. **`flushUnsaved` swaps too** — it is the one save nobody is watching
  (board switch, canvas unmount), and a whole-board PUT there would have put the clobber back
  on every board switch.
  **The basis is the last board the server *acked*, and it advances only on ack.** The old
  code stamped it optimistically and reset it to `''` on failure, resending the document;
  now a failure leaves it alone and the retry re-diffs from the same basis, so the merge holds
  on the retry path too — which is only safe because the ops are idempotent. **A null basis is
  never dirty**, which is how opening a board stays not-a-write: the load effect calls
  `beginBoard()` on the switch and `seedBasis(b)` on arrival, replacing the `savePayload`
  string compare (that function is gone with its last caller).
  **What this does not do: live updates.** A second tab still needs a reload to *see* the
  other's edits — it only stops them destroying each other. `lib/store.ts` is untouched, both
  undo stacks are untouched, and nothing here knows a second person exists.

- **Live updates and the shared ghost** (v4.0): the second half of v3.6. Ops stopped two
  windows destroying each other's work; this tells them. A client subscribes to its board and
  the edits it is not making arrive as they land — **and because two clients on one board
  would otherwise fire two `/suggest` calls per change and spend the host's key twice, the
  ghost becomes a room-wide object with a lease.** That is a correctness requirement of live
  updates, not a feature beside it, which is why the two ship together.
  **Nothing here widens the network.** Reach is exactly what it was: loopback, or the LAN if
  the operator passed `--lan`, which already exposes every board. `lib/access.ts`,
  `lib/share.ts`, the share dialog and the desktop binding are v4.1 and are untouched — there
  must never exist a build where something binds wide and the gate isn't there.
  **Unchanged:** `lib/graph.ts` (no board-schema change), both tables (no migration), the `Op`
  union, `PUT /api/boards/[id]`, `lib/transfer.ts`, `lib/ai/trigger.ts`, `lib/ai/prompt.ts`.
  Still exactly one unsolicited AI behavior and three user-invoked ones — and *fewer* calls per
  change than before, not more.
  **`lib/hub.ts` is in-process pub/sub and there is no broker**, because one process is
  already a given: `sync/route.ts` leans on the same fact for its merge, and arrival order at
  a single process *is* the total order. The `Map<boardId, Room>` is pinned on `globalThis`
  for the reason `lib/db.ts` keeps a module singleton — `next dev` reloads a route module on
  edit, and a fresh map there would orphan every open stream. **`seq` is ordering information,
  not a revision clock**: per room, session-only, never persisted, nothing merges by it.
  **The GET is the ideas route's idiom with two differences**, both because this stream is
  idle by design rather than bounded by one model call: it opens with `hello` carrying the
  whole stored board — **so an offline client resyncs by reconnecting rather than by replaying
  a log the hub would have to keep** — and it needs a heartbeat, which is also how a dead
  subscriber is noticed and dropped. **The POST broadcasts the ops as received, not as
  applied**: every receiver runs them back through `applyOps`, which is total, so an op the
  server dropped is dropped identically everywhere. One serialization path, not two.
  **Echo suppression is a client rule** — the hub sends every frame to everyone, including the
  sender, and each client drops frames carrying its own `clientId`. The alternative is the hub
  knowing which subscriber belongs to which client, which buys nothing and goes wrong the
  first time one client holds two streams.
  **`applyRemote(boardId, ops, dirty)` in `lib/store.ts` has four rules and each is a visible
  bug if missed.** (1) **Another person's edit is never in your undo stack** — no snapshot, no
  redo spend — but it *does* bump `lastMutationAt`, since the board now says something
  different; the descendant of v1's rule that a ghost appearing is not undoable but accepting
  one is. (2) **Never clobber a node with unsaved local edits**: the textarea is controlled
  over `node.text` and commits per keystroke, so a remote `node.put` mid-burst yanks the card
  out from under the typist. Anything in `dirty` (what the hook's diff against its last acked
  basis touched) is dropped; LWW already decided ours wins, and the skip retires itself when
  the save acks. One rule covering live streaming, the reconnect resync and the open textarea
  at once. (3) **Rebase both stacks** — they hold whole-board snapshots, so a stale one
  resurrects the card a teammate deleted; running the kept ops over every snapshot means ⌘Z
  only ever undoes *your* edits. The consequence to accept: undo can restore their wording of
  a card you both edited. That is LWW applied to history, and the alternative is the per-field
  merge engine this design exists to not need. (4) **Prune what points at what is gone**, and
  clear a live ghost if a remote `board.set` turns privacy **on** — not through
  `dismissProposal`, because nobody turned that idea down, the same distinction `setPrivacy`
  makes. An all-skipped batch changes nothing and therefore must not bump the clock, and
  `lastTextEditId` is deliberately untouched: a teammate's edit must not end your typing burst.
  **`useSync` gained the stream, not a new lifecycle** — the debounce, the send id, the
  indicator, the retry, `flushUnsaved`, `beginBoard` and `seedBasis` are all v3.6's, unchanged.
  It is read with `fetch` and a reader rather than `EventSource`, which is the choice that
  survives v4.1: a share token must ride in a header, and `EventSource` cannot set one.
  **The reconnect rule is the hardest merge here**: what the room did while we were away is
  `diffBoards(basis, hello)` — **never** `diffBoards(board, hello)`, which would compute ops
  that wipe our own unsaved work. **And an `ops` frame does two things, the second easy to
  miss: it applies to the board *and* advances the basis** (`applyOps(basis, ops)`), or every
  remote change reads as local dirt and is echoed straight back. A node skipped as dirty stays
  dirty against the new basis, which is exactly right — our version re-sends and wins.
  **The ghost lease is one holder per room, TTL 30s, claimed before a provider is resolved and
  before anything is spent.** A loser is told `claimed` — a refusal ranked with `privacy` and
  `no_api_key`, not an error — and goes quiet, because `markRequested` fired *before* the POST
  and the fingerprint is already stamped. **A lease that expires undelivered broadcasts
  `released`, and that needs a real timer rather than a lazy check on the next claim**: the
  losers are all sitting behind `no_material_change` and will never ask again on their own, so
  without the announcement a winner whose tab died deadlocks the room's ghost until somebody
  happens to edit something. `releaseRequest` answers it and is deliberately **not**
  `failRequest`, which also buys a 30s cooldown a lease nobody used has not earned.
  **The lifecycle frames exist because ops alone retire nobody's ghost**: if one person
  accepts, the diff builds their node on every screen, but everyone else's `proposal` is still
  sitting there. So an accept/dismiss rides the *same* sync POST as its ops — one request, so
  no client can see "the ghost is gone" before "the node arrived", or the reverse — and a
  remote dismissal lands in each client's `rejectedByBoard`, because **one person's "not that"
  is the room's**. **Placement stays per-client**: `receiveProposal` runs `placeProposal`
  against the local `viewRectFor`, which reads install-level `collapseMode` and session-level
  `expandedIds`, so two clients with different fold settings may place the same ghost a little
  differently. Same idea, same layer, same id; converging the coordinate would mean the server
  doing geometry, which it has never done. **The three-layer invariant is untouched** — a
  proposal is still never a node, still never persisted, and now one per *room* rather than
  one per tab, which is strictly closer to the rule.
  **What this does not do: presence.** No cursors, no names, no selection. Most visible, least
  load-bearing, and built now it would spend the polish budget on cursor colours before the
  merge engine has been used in anger.

- **Sharing on a network** (v4.1): a board you can hand someone with a link. They open it in a
  browser, on your machine's own page, and edit it with you live — the thing v3.6's merge and
  v4.0's stream were built for. **No AI behavior, no new state, no board-schema change, no
  migration, never a token: still exactly one unsolicited and three user-invoked.**
  **`local` is proved, never inferred, and that is the ruling the whole release turns on.**
  `private/collaboration-plan.md` drafted the gate as reading the peer address; **Next's App Router
  does not expose the socket**, and the `Host` header is not a substitute — a machine on the
  LAN can send `Host: localhost`, and read naively that inverts the strictest tier into the
  most permissive one. So `local` became something a request must carry a **per-run secret**
  to claim (`SMARTI_LOCAL_SECRET`, minted by `desktop/main.js` and injected into its own
  window's headers). The order in `decideAccess` is: a Cloudflare header means never local and
  never trusted; the secret means `local`; **a server that is not bound wide means `local`
  regardless**, because there the operating system is the boundary and no header needs
  believing; `SMARTI_TRUST_LAN` means `trusted`; a token that resolves to *this* board means
  `{ share }`; otherwise denied.
  **Which is why a clone-and-run install is unchanged in every observable way.** The npm
  scripts pin `-H ${SMARTI_HOST:-127.0.0.1}`, so nothing non-local can arrive, so rule 3
  answers every request `local`. And `./start.sh --lan` now exports `SMARTI_TRUST_LAN=1`, so
  **v2.5 is preserved bit-for-bit** — that flag still means "this whole install, to this whole
  network", warning block and all. **The gate therefore bites in exactly one configuration:
  bound wide *without* trust, which is the desktop's new mode.** Said plainly in the dialog
  rather than papered over: under `--lan` the token puts a guest on the right board and is
  **not** a boundary, because the flag already gave the network everything.
  **The `CF-Connecting-IP` rule ships here rather than with the v4.2 tunnel it protects.**
  `cloudflared` runs *on the host* and dials loopback, so a tunneled request would otherwise
  arrive looking like the most trusted caller there is. It was cheaper to write while the file
  was being born than to remember later, and it is the assertion `access.test.ts` guards hardest.
  **The token authorises a board, never a person** — there is still no login, no session, no
  cookie and no identity concept anywhere in this codebase, which is what keeps the brief's
  ruling against multi-user scope intact. It is **minted in `lib/hub.ts` and dies with the
  process**: v2.5's "a network decision belongs to the invocation, not the install" applied to
  the capability, so closing the app is the revocation story and **there is no table, no column
  and no migration**. The registry is a *sibling* map rather than a field on `Room`, because
  `sweep` deletes a room the moment nobody is subscribed and nothing is leased — a token stored
  there would be revoked by the host closing their tab. Minting is **idempotent per board**, or
  reopening the dialog would invalidate a link already sent.
  **The link is `/board/<id>#s=<token>` — the page route the app already had, and the fragment
  on purpose:** a fragment is never sent to a server, so the capability stays out of access
  logs, `Referer` headers and proxy history. That is also the reason v4.0 chose `fetch` and a
  reader over `EventSource`, which cannot set a header; the alternative was the token in a
  query string, the one place it must never be.
  **Refusals are 404 board-scoped and 403 install-scoped**, and in `/suggest` and `/ideas` the
  gate goes **above** the privacy check, so a stranger cannot tell "privacy is on" from "no such
  board". A guest reaches that board's `GET`, `sync` and the two AI routes and **nothing else** —
  not the library, not `?full=1`, not another board, not the settings, not `PUT`/`PATCH`/`DELETE`,
  and **not minting a further share**: hosting is the install's to offer, or the first person you
  invited could invite the network. **A guest does spend the host's provider key** (the ghost
  fires for the room, ⌘. is live), which is correct and belongs in the dialog rather than in a
  bill — **and Privacy Mode is the guest-proof switch**, already enforced server-side against
  the stored board, so it needed no change.
  **Guest chrome removes what the token cannot reach, and its shortcuts with it** — Home, ⌘K, ⚙,
  Export — because a control you cannot see but that still fires on ⌘K is the v2.6 reachability
  rule inverted. `isGuest()` is read in an **effect, not during render**: the token lives in the
  fragment, which the server by definition never receives, so an inline read would hydrate
  mismatched. `Board.tsx`'s `/api/settings` GET already fell back to defaults on failure, so a
  guest's 403 there cost nothing — a seam cut right three versions early.
  **`apiFetch` in `lib/shareToken.ts` is the one place a client API call is built.** Nothing in
  v4.1 needs it (a guest is same-origin, so **no CORS in this release** — permissive headers
  would be untested surface guarding a case that does not exist yet); v4.3's "Shared with me"
  does, and this makes that release one line here instead of the same threading exercise in
  three files. The token must stay a **module read, never a prop or a dep**, or `useSync`'s
  `[boardId]`-only memo reopens the stream on every keystroke.
  **The desktop binds `0.0.0.0` from launch**, because a listening server cannot rebind and
  widening on a button press would mean a new port and a window reload mid-collaboration.
  **Written down because it is the one genuinely new exposure in this release:** the app now
  holds an open port on the LAN at every launch where before it held none, and raises a firewall
  prompt the first time. Gated is not the same as absent.

- **Beyond this network** (v4.2, **⏸ paused pending re-evaluation** — see `private/v4.2-tunnel.md`):
  the second tier of sharing. v4.1's link reaches somebody who can already reach the machine;
  this opens a `cloudflared` quick tunnel and gives the install a public
  `https://<random>.trycloudflare.com` address a phone on cellular can open. Built and passing
  its automated (curl-driven) verification, but the one real test — a guest opening the public
  link in an actual browser — failed: the shared board answered HTTP 500, not a board, and the
  cause is not yet isolated (a curl repro against the same live tunnel does not reproduce it).
  `components/ShareDialog.tsx` no longer offers the button for this tier; `lib/tunnel.ts` and
  `/api/tunnel` are untouched and still reachable directly. Everything below describes the
  design and the (still-believed-correct) transport fix as built. **No AI
  behavior, no new persisted state, no board-schema change, no migration, never a token: still
  exactly one unsolicited and three user-invoked.**
  **A tunnel forwards bytes and holds nothing**, which is the whole reason one is admitted here
  where a hosted service is not: lose Cloudflare and only *reach* is lost, and nothing about the
  board leaves the host's SQLite file. **The tunnel is per install; the token is per board** —
  `lib/tunnel.ts` never hears about a board, `/api/tunnel` is install-scoped behind
  `guardManage`, and what keeps a guest to one board is `lib/access.ts` exactly as on the LAN.
  **A bare tunnel URL with no `#s=…` reaches nothing.** `guardManage` also refuses every proxied
  request for free (rule 1 of `decideAccess`), so **you cannot open a tunnel through a tunnel**.
  **It dies with the process** — v2.5's "a network decision belongs to the invocation, not the
  install" applied a third time, so there is no setting, no column and no migration, and quitting
  is how a tunnel is closed. **And never a download**: `resolveBinary` reads `SMARTI_CLOUDFLARED`
  then `PATH` with a filesystem look (not a spawn — running somebody else's executable to decide
  whether a button is greyed out is the wrong trade), and absent means the tier greys out with
  one sentence, never a download prompt. An idea board does not fetch executables on a button
  press.
  **The finding that shaped the release: a quick tunnel buffers a response body until it ends.**
  Measured against a probe route and confirmed against a raw Node server with no Next involved —
  frames 1.5s apart arrive together after a minute, and no content-type, padding, compression
  setting, HTTP version or frame size (64KB each, ~590KB total) changes it. It is Cloudflare's
  edge, not our code. The same rig measured the other half: a request that *ends* is delivered at
  once, ~47ms of overhead on a warm connection. **So the answer is not to make the stream survive,
  it is to stop needing one.** `GET …/sync?since=<seq>` returns `{frames}` the moment the room
  speaks, or `[]` after `LONGPOLL_MS` (20s), which is that transport's heartbeat.
  **It is a second delivery, not a second feature** — the room, the `Frame` union and `handle()`
  are the stream's, unchanged, so a polling client hears `ops`, `hello`, `ghost` and `ping`
  identically and the shared ghost needs no special case. Two rules inside it: the batch **flushes
  a tick after the first frame**, because one POST can publish ops *and* the ghost frame riding it
  and v4.0 forbids any client seeing "the ghost is gone" before "the node arrived"; and the poll
  **subscribes before it decides what to answer**, because joining first creates the room, so a
  frame published while we look lands in the log and a room is left behind for the *next* poll —
  without it a lone poller finds no room every time, is told `null`, and is answered with the whole
  board on a loop. That spin was real, and caught by hand.
  **`lib/hub.ts` gained a log and a grace, both about the gap a poll has and a stream does not.**
  `framesSince` answers `[]` for "nothing happened" and `null` for "I cannot account for the gap"
  (no room, a `seq` from a previous process, or more than `LOG_MAX = 256` frames missed), and the
  route answers `null` with `hello` — the same whole-board resync a reconnecting stream already
  got, which is why **losing the log is safe** and it is a plain capped array. `ROOM_GRACE_MS`
  (60s) makes `sweep` defer rather than delete, because a room swept between two polls takes its
  log and its counter with it and the next poll resyncs the whole board and finds an empty room
  again — a full board per remote edit, forever.
  **The client falls back by silence, not by error** (`useSync`): a buffered stream opens, is
  accepted, and delivers nothing, so `STREAM_PROBE_MS` (5s) of *nothing at all* is the signal —
  `hello` lands the instant the route subscribes, so the probe never fires on loopback or the LAN,
  and both keep the transport they shipped with. The fallback is **per board and one-way**, since
  retrying a stream already proved buffered would spend 5s blind each time and nothing about a
  tunnel changes while a board is open. `POLL_MIN_MS` floors an *empty* answer only, so a server
  answering "nothing" instantly cannot become a spin while a real frame still reconnects at once.
  **The dialog carries the three caveats rather than the README**, because they are true the
  moment the button is pressed: Cloudflare terminates TLS so the board's text crosses their edge
  in readable form (nothing is blocked — it is their board, their call); a quick tunnel is not a
  paid service and can slow or stop, which is their doing rather than a fault here; and the tunnel
  is open for the whole app, with the link being what keeps a guest to one board. Tier 2 renders
  only once tier 1 is live, because a public address carrying no token is a link to a refusal, and
  the public URL is composed **client-side** from an install-scoped origin and a board-scoped token
  through the pure `shareUrl`, which is what keeps `/api/tunnel` from ever hearing about a board.
  `*.trycloudflare.com` joins `allowedDevOrigins` — public space, unlike everything else in that
  list, but the entry means nothing unless a tunnel *this install opened* is running.
  **Deferred to its own pass:** bundling `cloudflared` into the Electron installers. The seam
  (`SMARTI_CLOUDFLARED`) exists and is documented; until then a desktop build uses one on `PATH`
  and greys the tier out otherwise, which is the designed fallback rather than a broken state.

- **Ask — questions about a board, answered read-only** (v5.4, see `private/ask-plan.md`): the
  third *user-invoked* behavior, and the one the folder import earned — until v5.0 every board
  held cards the person wrote themselves, which is precisely why v2.0 cut the v1.3 board summary
  ("describing a board you had just written was the weaker half"). A folder-import board arrives
  holding 300+ cards the person has never read, and "where does auth happen?" becomes an honest
  question. ⌘/ or the Ask button opens the drawer; answers stream in prose with the cards they
  drew on cited inline as clickable chips. **Read-only is the invariant**: nothing is proposed,
  nothing is accepted, nothing lands on the canvas — no "add as card" bridge (Ideas owns putting
  things on a board), no store action that writes, not in the undo stack, not in the fingerprint,
  `boards.updated_at` untouched by a run. The model is told the same rule in its own prompt:
  answer only from what is on the board, say so plainly when it doesn't say, cite as `[[nodeId]]`,
  and never propose a change.
  **The question is the first untrusted free-text string to reach a model turn**, so it is capped
  (`QUESTION_MAX = 500`, `clampQuestion`) on both sides of the wire, and the posted history and
  scope are re-fitted server-side (`fitHistory`, `parseScope`) because a client is only a client.
  The context is the whole board capped by `ASK_MAX_CONTEXT_TOKENS` (40K) via `fitMaxNodes` —
  which exists only because the serializer gained `edgesById`/`maxNodes` first (v5.3); edges
  rendered by id are what make a folder map's import graph affordable to send — and a live
  selection narrows it (`scopeBoard`: the selected cards plus one hop), the ideas branch gesture
  applied to reading. The route is the ideas route's refusal ladder in order (`guardBoard` →
  privacy, stored then posted → `no_api_key` → `canAsk` → empty question), with `canAsk`
  deliberately *not* `canGenerateIdeas`: a question about a board with no cards has no answer, so
  the objective alone doesn't open the door. Privacy Mode gates it like the others, server-side
  against the stored board; a guest may ask, exactly as they may use ⌘., and spends the host's
  key under the same warning.
  Session-only, per board: `beginLoad` clears the thread, `setPresenting(true)` closes the drawer,
  opening spends no token. The three fixed right-edge drawers (Ideas, the Done bin, Ask) close
  each other on open — they share one z-index and one edge, and Ideas and the bin could already
  overlap, which this fixes rather than compounds. A `done` frame carries the counts actually
  sent, so the panel can say "answered from N of M cards" without re-deriving a budget it was
  never the authority on; the route holds back a trailing partial `[[…` marker (`splitAnswer`) so
  the panel never renders half a citation, the same holdback `splitLines` gives half a JSON line.

Also: the brief's pitch line about "reorganizing ideas as you add them" is **not** built and
should be cut from the pitch. Reorganizing means moving nodes the user placed — the most
trust-breaking action available, and outside the one-unsolicited-behavior rule.

