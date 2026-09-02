# Import / Export boards — plan

Move a board between devices as a file. The app is loopback-only by design (no
auth, no network sync), so files are the correct answer for device migration —
there is no other path. Not yet implemented; this document is the agreed plan.

## Why it is cheap here

Almost all the machinery already exists:

- **`parseBoard` (`lib/graph.ts`)** is already a full untrusted-JSON validator —
  it drops malformed nodes, drops dangling edges, clamps title/objective, snaps
  font sizes, and carries `done`/`privacy`/`objective` with per-era defaults.
  It is the exact ingestion point an import needs, and the board PUT route
  already trusts it for the same job.
- **`createBoard(board?)` (`lib/db.ts`)** already accepts a prebuilt board —
  templates are built on it, so an import is "a template that comes from a
  file."
- **`GET /api/boards/[id]`** already returns the full board JSON — export needs
  no new endpoint, only a client-side file download.

## Format

One board per file, **bare board JSON** — exactly the `GET /api/boards/[id]`
payload: `title`, `objective`, `privacy`, `nodes`, `edges`, `id`, `updatedAt`.

- No `{version, board}` envelope: `parseBoard`'s per-era tolerance *is* the
  versioning strategy (a v3.x file opens in any future version the same way old
  rows do), and a bare file is hand-editable and round-trips through the
  existing PUT.
- Settings and the API key are install-level and **never** in the file.
- `privacy` travels — a private board stays private on arrival.
- `updatedAt` travels so the library sorts honestly; the file's `id` rides
  along harmlessly and is ignored on import.

## Changes

### 1. `lib/export.ts` (new, small)

- `fileNameFor(title, id)` → sanitized `<board title>.json` — pure, unit-tested
  in `lib/export.test.ts` (weird characters, empty title → id fallback, length
  cap).
- A DOM one-liner `downloadBoard(board)` (blob + temporary anchor) shared by
  both export buttons. Untested DOM, tested filename — the house split.

### 2. `app/api/boards/route.ts`

POST accepts `{ board }` alongside `{ template }`:

- Only when `body.board` is a non-null object:
  `createBoard(parseBoard(newId('b'), body.board))`. Anything else falls
  through to today's template/blank path — "creating a board must never be
  refusable" stands.
- **The server always mints the id; the file's `id` is never trusted.**
  `saveBoard` upserts on id, so this is the one real safety requirement: an
  import can only ever *add* a board, never overwrite one.
- `parseBoard` handles everything else: drops malformed nodes and dangling
  edges, clamps title/objective, snaps font sizes, defaults every per-era
  field.

### 3. `components/index/BoardIndex.tsx` + `globals.css`

- **Import:** an "Import board" card in the grid beside the template cards.
  Hidden `<input type="file" accept=".json">` → `file.text()` → `JSON.parse` →
  client pre-check that it is an object (inline "Not a Smarti Board file"
  error otherwise; no POST) → `POST /api/boards {board}` → redirect to the new
  board.
- **Export:** a small ⇩ button on each board card beside the archive `×`
  (hover-revealed like the `×`, always visible under `@media (hover: none)`
  per the touch rule). Fetches the board, downloads it. The same button joins
  the archived cards' action row.

### 4. `components/BoardChrome.tsx` + `globals.css`

An `Export` button in the chrome row after `Print`. Exports straight from the
store board — WYSIWYG, so an edit still inside the autosave debounce is in the
file. No shortcut assigned (the row is getting full). Presentation mode needs
no gating: the chrome unmounts there.

## Doctrines (so it cannot drift)

- No schema change, no migration, no store field.
- No undo/redo/`lastMutationAt`/fingerprint impact — import happens before the
  first `beginLoad`; export is a read.
- Nothing in `desktop/`; the feature works there for free.
- Token colors only in CSS; every theme gets its answer.
- No model ever involved — never a token.

## Verification

- `npm test`, `npm run typecheck`, `npm run build`.
- curl round-trip: `GET /api/boards/<id> > b.json` → `POST /api/boards` with
  `{board: <b.json>}` → 201 with a **different** id → `GET` the new id and
  diff nodes/edges.
- Visual check (user's): both export buttons, the import card flow.
