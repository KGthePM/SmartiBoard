# "How it works" — a conceptual explanation board from a project folder

Design spec · 2026-09-26 · feature branch `how-it-works`

## The idea

The folder import builds a **map** (one card per file, wired by nesting and
imports) and can annotate it with per-file summaries. This adds a second output
shape from the same modal: a **"How it works" board** — a small conceptual board
(~5–15 cards) that explains how the project actually operates: its systems and
flows, for a builder trying to understand their own project. Major files only;
`AGENTS.md` / `CLAUDE.md` / `README` are treated as the author's own
architecture doc and lead the prompt when present.

Kyle's framing: "explains/demonstrates how the project works. How info moves,
this writes there."

## The one load-bearing trick

**The model writes only the cards. The edges are computed locally, for free,
from the real import graph.** A card claims files; when a file on card A
imports a file on card B, the board draws A→B. "How info moves" is therefore
grounded in actual code, deterministic, un-hallucinatable, and costs no tokens.
(Non-JS projects simply get an unconnected but still readable set of cards.)

This is the same philosophy as phase 2's links: structure is read locally,
only prose is bought.

## What it is, product-wise

A **fourth user-invoked AI behavior** (beside idea generator, folder summaries,
Ask). The unsolicited count stays at exactly one — this never fires on its own.
It lives entirely inside the folder-import modal's consent + staging + Apply/
Discard lifecycle: the board is *born* carrying the accepted result, exactly
like an enriched folder board. No ghost layer, no proposal, no undo moment —
Apply/Discard was the accept/reject.

## Pieces

### 1. `lib/majorfiles.ts` — which files are "major" (pure, free, no model)

- **Inbound-degree from `buildImportEdges`**: hubs like `store.ts` / `db.ts`
  bubble up automatically. This runs on the *included code files' contents,
  locally in the modal* — links already read contents on the client; this reuses
  that read.
- **Doc files always major when present**: `AGENTS.md`, `CLAUDE.md`, `README.md`
  (case-insensitive basename match, any depth — but only the first of each).
- **Entry-point signal**: `package.json`'s `main`/`module`/`bin` targets and
  top-level `scripts` referenced files, when they resolve against the build set.
- **Filters, re-used not re-written**: `isSecretFile` never ships;
  `SUMMARY_FILE_MAX` (100 KB) skips-and-counts giants; `SUMMARY_EXTS`-style
  text-extension rule applies.
- **Cap**: `MAJOR_MAX = 24` files shipping. Rank: docs → entry points →
  inbound-degree, tie-broken by code-point path order (the determinism rule).
- Output: `pickMajorFiles(files: Array<{path,size,content?}>, edges) →
  MajorPlan` — the ordered list plus the counts the consent screen shows
  (skipped secret / big / ext; how many were cut by the cap).
- If fewer than ~3 major files survive, the option is disabled with a sentence
  (same pattern as summaries' `overMax`).

### 2. `lib/ai/how-prompt.ts` — the prompt and wire contract (shape-mate of `folder-prompt.ts`)

- Input turn: one JSON line per major file `{"path":…, "content":…}` — same
  unambiguous JSONL-in as summaries — **preceded by an unlabeled tree listing
  and the local import pairs** so the model sees structure it wasn't sent
  contents for. Doc-file lines are marked with a `"note": "the author's own
  guide to this project"` field so the model treats them as authoritative
  framing, not just another file.
- System prompt: name the project's systems and flows as 5–12 cards; each card
  = `{"title": short, "body": 2–4 sentences explaining what it does and how
  info moves through it, "files": [major files that embody it]}`; use real
  paths from the input only; prefer naming major files in titles when natural
  ("Autosave loop — useSync + sync").
- Output validation `cardFromLine(line, validPaths)`: title non-empty, capped
  ~80 chars, flattened to one line; body non-empty, capped ~600 chars,
  whitespace-normalized; `files` filtered to the batch's own paths (unknown
  paths drop in silence — a model naming a file that was not sent gets that
  part dropped, not the card); 3–16 cards kept, extras dropped silently.
  Unparseable/fenced lines: silence, never error. `howMaxTokens(cardTarget)`:
  ~250 tokens a card plus overhead, capped 4000.
- One batch, one pass. Major files are ≤24 and ≤100 KB each; the route's
  existing batch ceilings (32 files / 1M chars) already cover this shape.

### 3. `app/api/folder-ai/route.ts` — extended with a `mode: 'how'`

Same route, same `guardManage` install-scope, same SSE frame idiom, same
no-api-key refusal, same abort wiring. `mode` defaults to the current
summaries behavior — **omitted `mode` is byte-identical to today's route**, the
`enrich`-omission rule. With `mode: 'how'`:

- Validates the same `{files}` array shape (paths + contents).
- System prompt / instruction / line validator swap to how-prompt's.
- Frames: `{"type":"card","title":…,"body":…,"files":[…]}` streamed as each
  JSONL line completes, then `done` / `error`, refusals plain JSON.
- A pass producing zero cards is an `error` frame (`empty`/`truncated`), not an
  empty board — same rule as summaries.

(One route rather than a second file: the SSE plumbing, abort ladder, and
provider branching are the whole route's body; a second copy would be the
driftable duplication this repo refuses.)

### 4. `lib/howboard.ts` — the pure builder (`buildHowBoard`)

- Input: accepted cards, the import pairs among major files (from the same
  `buildImportEdges` output already in the modal), project name.
- **Edges**: for each import pair (a, b), if a lives on card A and b on card B
  and A ≠ B, draw A→B (deduped; multi-file overlap still one line).
- **Layout**: deterministic. Cards sorted by aggregate inbound file-degree
  (hubs first), placed in a left-to-right layered arrangement off the edge
  graph (like the folder board's columns, shallowest layer leftmost; a card in
  a cycle joins its earliest layer). Card size ~300×110, `fontSize` 17 (body
  rung), body text as the card's second line under the title.
- Every node `layer: 'user'`, fresh ids — an ordinary board, editable,
  undoable from birth like any template. The board's `objective`:
  "How <name> works — the systems and info flows of the project, from its N
  major files. Ordinary board content." Non-empty objective keeps ⌘. live.

### 5. `components/index/FolderImport.tsx` — the modal's third choice

- After the checklist, where the AI pass is offered today, a second option:
  **"How it works"** (its own consent screen, real numbers as always: N files
  shipping, ~X tokens est., secrets never, skipped counts).
- Choosing one AI option disables the other (one pass per import; the shapes
  don't compose — a concept board is not a file map).
- Staging: cards stream into a list in the modal (title + body + the files each
  claims), reviewable before Apply, abortable mid-stream, Discard returns to
  the checklist.
- **Apply** builds the how-board and creates it via the existing
  `POST /api/boards` prebuilt path, then navigates — identical to the map's
  Apply. No second write path.

## What this does NOT do

- No changes to `lib/graph.ts`, store, sync, undo/redo, fingerprint, db schema,
  migration. The board is born fully-formed like a template.
- No ghost, no proposal, no per-file cards unless the model names files in a
  card's title/body/files — a concept card may reference a file without a
  matching file card existing, which is correct: this board is an explanation,
  not an index.
- No persistence of file contents — the modal already holds them in memory for
  the pass; Apply consumes them and the modal unmounts.
- No browser testing (repo rule): vitest on the three pure modules + typecheck
  + build + curl against the dev server.

## Testing

- `lib/majorfiles.test.ts`: docs always picked; degree ranking; entry-point
  resolution; secret/size/ext skips counted; cap behavior; determinism (same
  input → same output, code-point ties).
- `lib/ai/how-prompt.test.ts`: `cardFromLine` accepts good lines, drops
  fenced/preamble/unknown-path/empty lines silently, enforces caps; doc-note
  marking in the instruction; `howMaxTokens` bounds.
- `lib/howboard.test.ts`: edges derived only from real import pairs; dedupe;
  cycle handling; layout determinism; total-input (empty cards → still a valid
  empty board, never a throw); objective cap.
- Route: curl with `mode: 'how'` (SSE frames), omitted mode (unchanged
  behavior), no-key refusal, abort.
- Kyle's live look at a real board is the final gate, as with every import
  shape.

## Order of work (implementation plan follows separately)

1. `lib/majorfiles.ts` + tests
2. `lib/ai/how-prompt.ts` + tests
3. `lib/howboard.ts` + tests
4. route `mode: 'how'` + curl verification
5. `FolderImport.tsx` third choice + consent + staging + Apply
6. full gate (`npm test`, `typecheck`, `build`), docs update (AGENTS.md,
   CLAUDE.md file map), Kyle's review of the branch

## Open by design (settled in review if Kyle disagrees)

- `MAJOR_MAX = 24`, card target 5–12, caps 80/600 chars — all one-file knobs.
- The two AI options are mutually exclusive per import; re-importing the same
  folder for the other shape is the workaround and is cheap.
