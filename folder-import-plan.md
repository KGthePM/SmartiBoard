# Folder import — phase 1 (built) and phase 2 (the AI pass, built)

Status: **phase 1 built and user-tested** (Sep 2026) — `lib/folderboard.ts`
(+ `folderboard.test.ts`), `components/index/FolderImport.tsx`, the index tile
and `createFromBoard` in `BoardIndex.tsx`, `.fi-*` styles in `app/globals.css`,
`lib/webkit.d.ts` for the `webkitdirectory` attribute. `npm test` (601),
`typecheck`, and `build` green; layout visually passed on real folders.

**Phase 2 is built** (Sep 2026), backend and UI both — `npm test` 633,
`typecheck` clean, `npm run build` clean: `lib/importgraph.ts` (+tests, 17),
`lib/folderboard.ts`'s `enrich?` arg (+tests, 29 in that file),
`lib/ai/folder-prompt.ts` (+tests, 7), `app/api/folder-ai/route.ts`, the enrich
stage in `FolderImport.tsx` (consent → running → Apply/Discard), `.fie-*`
styles in `app/globals.css`, and the doc updates below. Exact state under
"Build state". **Not yet done: the visual check** — the consent copy and the
streaming staging list are Kyle's to look at (no browser launch by doctrine).

Building phase 2 was an explicit product decision: it adds a **second
user-invoked AI behavior** (the ideas panel had held the only slot), so
CLAUDE.md, AGENTS.md, and README.md's "exactly one user-invoked" wording has
been updated to reflect two.

## Phase 1 — structure only, no AI (as built)

Point Smarti Board at a project folder and get a board: file names as cards,
connected by folder structure. Deterministic — a directory tree → `Board` is a
pure function, exactly like the template registry: zero tokens, no provider
needed.

### Settled decisions

1. **Structure-only first.** No model anywhere in phase 1; the AI pass is
   phase 2 and its own decision.
2. **Input is browser picker + drag-drop** (`<input webkitdirectory>` plus
   directory drop via `webkitGetAsEntry`) — one code path (`/`-separated
   relative paths, `scanPaths`), works in Chrome, Firefox, and Safari; the
   desktop is Chromium. A desktop-only path-pick was rejected: it would need
   an Electron IPC bridge, which the desktop doctrine forbids.
3. **Folders are nodes** — an explicit tree (root 26 / folders 17 / files 12
   font rungs), laid out as an indented outline (Finder-list style): children
   stack below their folder card, one gutter right (`CHILD_DX = 280`). Chosen
   over a column-fan for determinism, short edges, and how it reads in the
   minimap. Code-point sort (never `localeCompare`) so the same folder is the
   same board on every machine.
4. **Scale is a folder checklist** — scan, then check folders before anything
   is built. Rulings settled at build time:
   - **Junk dirs are listed, pre-unchecked, re-includable** (`node_modules`,
     `.git`, `dist`, `build`, `.next`, `out`, `coverage`) — "skipped as
     clutter" note, tick to override; the file cap still guards the result.
   - **OS junk files are dropped at scan and not re-includable**
     (`.DS_Store`, `Thumbs.db`, `desktop.ini`), counted in the note.
   - **The checklist lists every folder**, depth-indented, each with its
     recursive file count; a checkbox carries its whole subtree, children of
     an unchecked folder render disabled.
   - Warn past `WARN_FILES = 300`; build disables past `MAX_FILES = 1500`.
     Client-side by doctrine: the server never refuses a create.

### Shipped

- `lib/folderboard.ts` — `scanPaths`, `defaultIncluded`, `countFiles`,
  `countIncludedFiles`, `findJunkDirs`, `buildFolderBoard`. Pure, node-free,
  total; reads **path strings only, never file contents**. The layout is
  overlap-free by construction (a test holds it, shallow and deep).
- `components/index/FolderImport.tsx` — the modal (pick or drop → checklist →
  Build). Reuses the `.tplib-*` shell; `.fi-*` body styles, tokens only.
- `BoardIndex.tsx` — the "Import folder" tile and `createFromBoard`, which
  POSTs `{ board }` to the existing full-board branch
  (`app/api/boards/route.ts`); the server mints the id, so an import can only
  add boards.
- `lib/folderboard.test.ts` (21 tests), `lib/webkit.d.ts`, CLAUDE.md map
  entries.

No schema, migration, store, route, or desktop change. Never a token; the
imported board is ordinary content on arrival.

## Phase 2 — the AI pass (planned; settled Sep 2026)

Two halves on top of a phase-1 import: **import links** (which file imports
which) and **per-file one-line summaries**. Three rulings settle the shape:

1. **It lives in the import modal.** Phase 1 discards the `File` objects and
   cards carry only base names (two `index.ts` are ambiguous), so a board-side
   button would need node provenance (schema) plus re-picking or held file
   handles. The modal has everything in hand; consent happens with real
   numbers on screen.
2. **Summaries + links both.** Links are near-free: contents read **locally**,
   import statements extracted client-side, only path-pairs — nothing ships,
   and they work with no provider. Summaries are the egress: file contents
   leave the machine on the user's key.
3. **One batch Apply.** Results stream into a staging list in the modal;
   one Apply folds the whole pass into the board it is about to create, one
   Discard creates nothing. A single accept/reject for the pass satisfies the
   trust rule without per-file buttons (unusable past ~20 files).

### Flow

`pick → review (checklist) → enrich → Apply → create → navigate`. The review
stage keeps **Build board** exactly as is — the zero-AI, keyless path is
permanent. An **"AI pass…"** button enters the enrich stage:

- **Consent screen** — the egress moment, in plain words: phase 1 read only
  names; this step sends file contents off this machine on your key. Shows N
  files / ~X KB after filtering, a rough token estimate (bytes ÷ 4), the
  provider name or "no provider — summaries need one (Settings); links still
  work", and Back to the checklist to shrink scope.
- **Links** — `lib/importgraph.ts` (pure): table-driven regexes for JS/TS
  (`import` / `require` / `export … from`; more languages are one entry),
  relative-only resolution (`./lib/foo` → `foo.ts`, `foo/index.ts`, …).
  Unresolvable, self, and package imports drop silently. Cost: zero tokens.
- **Summaries** — eligible files only (text-extension allowlist, < 100 KB
  each, skipped counted and shown), chunked (~20 files / ~60 K tokens per
  batch) and POSTed to a new install-scoped SSE route
  (`app/api/folder-ai/route.ts`, `guardManage`) that mirrors the ideas-route
  idiom: JSONL-in-SSE frames, plain-JSON refusals (`no_api_key`), both
  provider flavors, abort on disconnect. **`SUMMARY_MAX = 300`: past it,
  summaries are disabled outright with the message** — a partial
  "first 300" subset would be invisible after Apply. Links still run free.
- **Apply** — `buildFolderBoard(root, included, enrich?)`: summarized file
  cards get `name\nsummary` and h 64; import edges appended file→file, deduped
  against tree edges by `edgePair`. Omitted, the third arg changes nothing
  (phase 1 tests pass untouched). **Layer doctrine: everything `layer:
  'user'`** — the board is *born* with this content, like a template; the
  modal preview + Apply/Discard is the accept/reject moment. No schema, no
  store, no undo/autosave implications — it lands through the same create
  POST.

### Token honesty

The consent screen shows the real estimate before anything ships: ~50 files ≈
75–150 K input tokens (~$0.25–0.50 at Sonnet-class rates, less elsewhere);
~300 files ≈ $1.50–3; output negligible. Links: $0, always.

### What phase 2 touches

New: `lib/importgraph.ts` (+tests), `lib/ai/folder-prompt.ts`,
`app/api/folder-ai/route.ts`. Modified: `lib/folderboard.ts` (the `enrich?`
arg), `FolderImport.tsx` (the enrich stage; reuses the `useSync` SSE
frame-reading pattern), `app/globals.css` (`.fie-*`, tokens only), docs
(this file's status, CLAUDE.md map, **AGENTS.md's one-user-invoked count**).
Untouched: schema, migration, store, undo, autosave, desktop, env vars, the
template registry.

### Verification

`npm test`, `npm run typecheck`, `npm run build`. No browser launch; the
consent copy and streaming list are the user's visual check.

## Phase 2 — build state (updated mid-build, Sep 2026)

The design above is unchanged and still authoritative; this section tracks
what is built, what remains, and the decisions the build locked in.

### Built and green (`npm test` 633, `typecheck` clean)

- **`lib/importgraph.ts`** (+ `importgraph.test.ts`, 17 tests) — the pure,
  client-side half. Five JS/TS regex forms (import-from, side-effect,
  re-export, `require()`, dynamic `import()`; multiline braces covered);
  relative-only resolution with ext adds (`.ts .tsx .js .jsx .mjs .cjs .json
  .css`) then `/index.*`; `..` clamps at the drop root; undirected pair
  dedupe (a↔b cycle → one edge). `partitionSummaries` sorts every included
  file into eligible / secret / over-100 KB / non-text, and past
  `SUMMARY_MAX = 300` zeroes `eligible` and flags `overMax` (the run is
  links-only — no invisible partial set). `chunkSummaries` batches by
  ≤ 20 files / ≤ 60 K est. tokens (`estTokens` = bytes ÷ 4); a single
  over-budget file rides alone. **The secrets ruling is implemented here**:
  `.env`, `.env.*`, `*.pem|key|p12|pfx` never ship; links still read them.
- **`lib/folderboard.ts`** — `FolderEnrich` (`summaries: Map<path, string>`,
  `imports: Array<[from, to]>`), the `enrich?` third arg on
  `buildFolderBoard`, and `includedFilePaths(root, included)` — the canonical
  file list the pass reads and keys by. A summary is applied **as the card is
  created** (`name\nsummary`, h 64, whitespace collapsed) so the taller card
  is a fact of the layout walk, not an overlap; the overlap-free test covers
  an enriched board. Import edges append post-walk, undirected-deduped by
  `edgePair` against tree edges and within the batch; unknown paths, folder
  paths, and self-pairs drop in silence. Omitted/empty enrich is byte-equal
  to phase 1 (tested structurally — ids are fresh every build). **One
  phase-1 fix rode along**: `scanPaths`'s hoisted root now keeps
  `root.path = only.path`, so files directly under the root keep their
  original `proj/x` keys — required for enrich paths to match the modal's
  File map. One test expectation updated; every other phase-1 test untouched.
- **`lib/ai/folder-prompt.ts`** (+ test, 7) — system prompt, per-turn line
  contract, `folderInstruction` (one JSON line per file, content escaped
  *inside* the line so no file can impersonate a delimiter),
  `summaryFromLine` (path must be one of the batch's; first line per path
  wins; whitespace flattened to one line; 200-char cap; fence/prose-tolerant
  via `parseJsonObject`), `summaryMaxTokens` (250 + 70/file, ≤ 4000).
- **`app/api/folder-ai/route.ts`** — the ideas route's skeleton,
  install-scoped behind `guardManage` (no board exists; no privacy check is
  possible or wanted — the consent screen is the gate). Plain-JSON refusal
  `{summaries:null, reason:'no_api_key'}`; batch caps re-enforced server-side
  (≤ 32 files, ≤ 1 M content chars → 413); SSE frames `summary`/`done`/
  `error`; abort on disconnect both ways. Anthropic branch: adaptive thinking,
  effort `medium`, system prompt `cache_control: ephemeral` — caching matters
  most here (byte-identical system prompt across every batch of a long pass).
  Compat branch: thinking explicitly disabled (the GLM lesson). OpenAI flavor
  via `openaiStreamDeltas`.

### The UI half, built this session

1. **`components/index/FolderImport.tsx` — the enrich stage.** A
   `Map<path, File>` is captured at scan (picker: free off `e.target.files`;
   drop: `collect` extended to call `entry.file()` alongside the path walk —
   handles, not contents, until a pass actually reads one). Stage machine:
   `pick → review (+ "AI pass…" button beside Build board) → consent →
   running → Apply/Discard`, tracked as `enrichStage: 'consent' | 'running' |
   null` (`null` is the ordinary review/checklist view). Consent: one
   `GET /api/settings` for `{provider, hasKey}` (`PRESETS` labels are
   browser-importable), numbers from `partitionSummaries` over
   `includedFilePaths` + captured File sizes — N eligible files, ~KB, ~K
   tokens, ~$ at $3/MTok input, the code-file count for the links line, the
   never-sent secret/oversize/binary counts, the over-300 sentence when
   `overMax`, "no provider — links still work" when unconfigured — and Back
   to the checklist. Running: links first (`buildImportEdges` over every
   code-ext file's content against the full included-path set, $0, always),
   then — only when a provider is configured and files are eligible —
   sequential batch POSTs (`chunkSummaries`) read with the `IdeasPanel`-style
   fetch+reader SSE loop, streaming into a live staging list. A batch failure
   stops with **Retry** (resumes from the failed batch via a `{batches,
   index}` ref, not a restart), **"Continue with N so far"** when anything
   already streamed in, and **Discard**. One `AbortController`, aborted by an
   unmount-cleanup effect, covers close/Escape/backdrop-click alike — this
   modal fully unmounts on close (`BoardIndex.tsx`'s `{folderOpen ? … : null}`),
   so that one effect is the whole story. Apply enabled once the pass reaches
   `done`; calls `onCreate(buildFolderBoard(tree, included, { summaries,
   imports }))` through the existing prop. The phase-1 "contents are never
   read" notes are softened to "read only if you start an AI pass."
2. **`app/globals.css`** — `.fie-*` added after the `.fi-*` block: the
   secondary `.fie-ai` button (index-border recipe, `.fi-choose`'s twin, not
   `.fi-build`'s accent-border one), `.fie-buttons` wrapping it with Build
   board so the pair's own gap doesn't fight the row's `space-between`, the
   consent facts list, the streaming `.fie-list` (bounded height, path|summary
   rows), `.fie-status` (`.bad` → `--mark-amber`), and the Back/Retry/Start
   button trio.
3. **Docs** — this file, CLAUDE.md's file map (new entries for
   `lib/importgraph.ts`, `lib/ai/folder-prompt.ts`, `app/api/folder-ai/route.ts`;
   `lib/folderboard.ts` and `FolderImport.tsx`'s entries updated for the
   `enrich?` arg and the enrich stage) and its v1-scope paragraph, plus
   AGENTS.md's and README.md's matching "one user-invoked" → two.
4. **Verified**: `npm test` (633, unchanged — no test file for
   `FolderImport.tsx`, matching the rest of `components/index/`),
   `npm run typecheck`, `npm run build` all clean. **Not done here**: the
   consent copy and the streaming list are Kyle's visual check, by doctrine
   (no browser launch).

### Decisions locked during the build (do not re-derive)

- Summary application happens inside `place()` at card creation — geometry is
  overlap-free by construction, not by post-pass luck.
- `partitionSummaries` returning `overMax` means the run is links-only and
  the consent screen says so; the client never slices a partial 300.
- First line per path wins in the route (a model cannot revise itself).
- Server re-enforces every client ceiling — the client is courtesy, the route
  is the boundary.
- Retry resumes from the failed batch index (keep `{batches, index}` in a
  ref); "Continue with N so far" ends the pass with what arrived.
