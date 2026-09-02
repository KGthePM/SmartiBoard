# Folder import — phase 1 plan (structure only, no AI)

Status: planned, not built. Settled in brainstorming, Sep 2026.

## Summary

Point Smarti Board at a project folder and get a board: file names as cards,
connected by folder structure. Phase 1 is **deterministic** — a directory tree
→ `Board` is a pure function, exactly like the template registry, so it costs
zero tokens and works with no provider configured. The AI pass (import graph,
per-file summaries) is deliberately parked as a separate product decision.

## Settled decisions

1. **Structure-only first.** The folder tree → board needs no model at all; the
   AI pass is a later, explicit decision (it would be a third AI behavior, and
   it ships source code upstream on the user's key).
2. **Input is browser picker + drag-drop** (`<input webkitdirectory>` plus
   directory drop via `webkitGetAsEntry`) — one code path, works in Chrome,
   Firefox, and Safari; Electron is Chromium, so the desktop gets it for free.
   A desktop-only path-pick was rejected: it would need an Electron IPC bridge,
   which the desktop doctrine ("it adds nothing") forbids.
3. **Folders are nodes** — an explicit tree (folder cards at a bigger font rung,
   file cards connected beneath). Mind map precedent.
4. **Scale is handled by a folder checklist** — scan, then check which folders
   to include before anything is built. Junk dirs (`node_modules`, `.git`,
   `dist`, `build`, `.next`, `out`, `coverage`) pre-excluded with a note.
   Warn past ~300 files; build disables past a hard cap (~1500) and the
   message explains itself. Client-side by doctrine: the server never refuses
   a create, so the cap must live where the person is watching
   (`BoardIndex.tsx:142-151` states this exact rule for import).

## What gets built

- **`lib/folderboard.ts`** (new; pure, node-free, like the templates):
  - `scanPaths(paths)` → folder tree from `/`-separated relative paths (both
    input methods produce this shape).
  - `buildFolderBoard(tree, included)` → `Board`: folder cards (bigger font
    rung — mindmap-hub precedent), file cards, edges folder→subfolder and
    folder→file; tidy column layout with per-subtree bounding boxes; fresh
    node/edge ids + ordered `createdAt` so two imports coexist; title = root
    folder name; non-empty objective so ⌘. is live on arrival.
  - Caps as named constants: `WARN_FILES = 300`, `MAX_FILES = 1500`.
- **`components/index/FolderImport.tsx`** (new modal, sibling of
  `TemplateLibrary.tsx` — same lifecycle: local `useState` open flag,
  Escape/backdrop/× to close, navigate away on success, `busy` gating).
  POSTs `{ board }` — the exact shape the import flow already uses
  (`BoardIndex.tsx:168`), served by the existing full-board branch at
  `app/api/boards/route.ts:76`, which mints the board id server-side so an
  import can only add boards, never overwrite one. Client-side throughout;
  reads **path strings only, never file contents** — the phase-2 privacy
  question cannot arise.
- **`components/index/BoardIndex.tsx`**: one new tile beside the Template
  library tile, plus a small `create-from-board` closure mirroring
  `importFile`'s single-board path (minus the file reading).
- **Tests** (`lib/folderboard.test.ts`): tree building, junk filtering, layout
  determinism, `parseBoard` round-trip via the persisted-board check
  (template-test precedent), cap constants.

## Doctrine compliance

No schema, migration, store, route, or desktop change. The template registry is
untouched — the input is user-supplied, not a static id, so this is a sibling
affordance, not a sixth template. Never a token; autosave and undo treat the
imported board as an ordinary board. The builder itself is total; every
refusal-shaped thing (cap, empty selection) is UI state in the modal.

## Verification

`npm test`, `npm run typecheck`, `npm run build`. No browser launch — the
visual check of the layout is the user's to make.

## Parked: phase 2 (AI pass)

Import-graph edges (which file imports which) and/or per-file one-line
summaries, streamed JSONL like the ideas route. Requires: an explicit consent
moment (source code leaves the machine on the user's key, a bigger egress than
any board), and a product decision to add a third AI behavior — the brief
currently holds exactly one unsolicited (ghost) + one user-invoked (ideas).
