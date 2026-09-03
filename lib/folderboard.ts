/**
 * Folder import, phase 1 (structure only) + the phase-2 enrich hook — see
 * folder-import-plan.md.
 *
 * A directory tree → `Board` is a pure function, exactly like the template
 * registry: zero tokens, no provider, no schema, no store, no route. This
 * module reads a file's *path*, never its contents — the AI pass reads
 * contents in the modal and hands back summaries and import pairs, so the
 * egress question never arises here and the zero-AI path stays zero-AI
 * (an omitted `enrich` changes nothing).
 *
 * The tree comes in as `/`-separated relative paths, which is the one shape
 * both input methods produce: the directory picker (`webkitRelativePath`) and
 * the directory drop (`webkitGetAsEntry().fullPath`).
 *
 * Determinism is a property, not an accident: children sort by plain
 * code-point comparison — never `localeCompare`, which varies with the ICU the
 * host was built with — so the same folder is the same board on every machine,
 * and two imports of it differ only in ids.
 */

import { createNode, edgePair, newId, OBJECTIVE_MAX, type Board, type Edge, type IdeaNode, type Rect } from './graph';

/**
 * Known build and VCS clutter, pre-excluded from the checklist's defaults.
 * These are *skipped*, not hidden: a folder in this list shows up unchecked
 * and can be ticked back in (the file cap still guards the result).
 */
export const JUNK_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage'] as const;

/** OS metadata files nobody wants as cards. Dropped at scan, not re-includable. */
export const JUNK_FILES = ['.DS_Store', 'Thumbs.db', 'desktop.ini'] as const;

/** Past this the modal says the board will be dense — but builds it anyway. */
export const WARN_FILES = 300;
/** Past this the modal refuses to build: the person is watching, the cap lives here. */
export const MAX_FILES = 1500;

/** A folder as scanned: its name, its path key, its subfolders and its direct files. */
export type FolderTree = {
  name: string;
  /** `/`-joined relative path; the root's is `''`. The checklist's key. */
  path: string;
  folders: FolderTree[];
  files: string[];
};

export function isJunkDir(name: string): boolean {
  return (JUNK_DIRS as readonly string[]).includes(name);
}

export function isJunkFile(name: string): boolean {
  return (JUNK_FILES as readonly string[]).includes(name);
}

/**
 * `/`-separated relative paths → a folder tree. Junk files are dropped here
 * and counted (they are not re-includable); junk *dirs* stay in the tree —
 * their pre-exclusion is a checklist default, so the person can override it.
 *
 * A single top-level folder — the normal case for both the picker and a drop —
 * is hoisted: the tree root *is* the project, not a nameless wrapper around
 * it, so the root card carries the folder's name. Descendant path keys keep
 * their full form (`proj/src`), which stays unique; only the root is special
 * and the root is never excludable.
 *
 * Total: junk input (empty strings, stray slashes, duplicates) degrades to a
 * smaller tree, never a throw.
 */
export function scanPaths(paths: string[]): { root: FolderTree; skippedJunkFiles: number } {
  const root: FolderTree = { name: '', path: '', folders: [], files: [] };
  let skippedJunkFiles = 0;

  for (const p of paths) {
    if (typeof p !== 'string') continue;
    const parts = p.split('/').filter((s) => s.length > 0);
    if (parts.length === 0) continue;

    const fileName = parts[parts.length - 1];
    if (isJunkFile(fileName)) {
      skippedJunkFiles += 1;
      continue;
    }

    // A bare file name lands at the root; anything deeper walks the folders.
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      let next = dir.folders.find((f) => f.name === name);
      if (!next) {
        next = { name, path: parts.slice(0, i + 1).join('/'), folders: [], files: [] };
        dir.folders.push(next);
      }
      dir = next;
    }
    if (!dir.files.includes(fileName)) dir.files.push(fileName);
  }

  sortTree(root);

  if (root.folders.length === 1 && root.files.length === 0) {
    const only = root.folders[0];
    root.name = only.name;
    // The hoist must not change what the paths mean: the root keeps its
    // original relative path ('proj'), so files directly under it still key
    // as 'proj/README.md' — the path space the modal's File map (and phase
    // 2's enrich data) is keyed by. Nothing else reads the root's path.
    root.path = only.path;
    root.folders = only.folders;
    root.files = only.files;
  }

  return { root, skippedJunkFiles };
}

/** Code-point sort, recursive — the determinism rule, applied in one place. */
function sortTree(node: FolderTree): void {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  node.folders.sort((a, b) => cmp(a.name, b.name));
  node.files.sort(cmp);
  for (const f of node.folders) sortTree(f);
}

/** Total files anywhere under `node` — what ticking its checkbox would add. */
export function countFiles(node: FolderTree): number {
  return node.files.length + node.folders.reduce((n, f) => n + countFiles(f), 0);
}

/**
 * The checklist's default: every folder checked except junk dirs and
 * everything inside them (a checked child inside an unchecked parent is not a
 * state the defaults should hand the modal).
 */
export function defaultIncluded(root: FolderTree): Set<string> {
  const set = new Set<string>();
  const walk = (node: FolderTree, junkAncestor: boolean) => {
    for (const f of node.folders) {
      const junk = junkAncestor || isJunkDir(f.name);
      if (!junk) set.add(f.path);
      walk(f, junk);
    }
  };
  walk(root, false);
  return set;
}

/**
 * Files that would be built: a folder's own files count iff its path is in
 * the set, and an unchecked folder switches its whole subtree off. The root
 * is never excludable — it is the hub the board hangs from.
 */
export function countIncludedFiles(root: FolderTree, included: Set<string>): number {
  const count = (node: FolderTree, on: boolean): number => {
    let n = on ? node.files.length : 0;
    for (const f of node.folders) n += count(f, on && included.has(f.path));
    return n;
  };
  return count(root, true);
}

/** Which junk dirs are actually present, for the modal's "skipped" note. */
export function findJunkDirs(root: FolderTree): string[] {
  const names = new Set<string>();
  const walk = (node: FolderTree) => {
    for (const f of node.folders) {
      if (isJunkDir(f.name)) names.add(f.name);
      walk(f);
    }
  };
  walk(root);
  return [...names].sort();
}

/** A file's original `/`-separated relative path — the key the modal's File
 *  map and every enrich payload is keyed by. The one place it is computed. */
function filePath(folder: FolderTree, name: string): string {
  return folder.path ? `${folder.path}/${name}` : name;
}

/**
 * The files a build would create, as their original relative paths, in the
 * order they will be laid out. Phase 2's AI pass reads exactly these files —
 * links resolve against this set, summaries are keyed by it — so the pass and
 * the build cannot disagree about what is on the board.
 */
export function includedFilePaths(root: FolderTree, included: Set<string>): string[] {
  const out: string[] = [];
  const walk = (node: FolderTree, on: boolean) => {
    if (on) for (const name of node.files) out.push(filePath(node, name));
    for (const f of node.folders) walk(f, on && included.has(f.path));
  };
  walk(root, true);
  return out;
}

/* ---------- the AI pass's payload ---------- */

/**
 * What one AI pass adds to the board it is about to be born with (phase 2 —
 * see folder-import-plan.md). Everything here was staged in the import modal
 * and accepted with one Apply: the board is *born* carrying it, exactly like a
 * template, so there is no ghost layer, no proposal, and no undo moment —
 * Apply/Discard was the accept/reject.
 *
 * Paths are original relative paths and are dropped in silence when they do
 * not name a built file: an excluded folder's contents are not on the board,
 * and the builder is total.
 */
export type FolderEnrich = {
  /** File path → one-line summary. Becomes the card's second line. */
  summaries: Map<string, string>;
  /** Resolved import pairs, [importer, imported], file → file. */
  imports: Array<[string, string]>;
};

/** A summarized card is a line taller than a bare name. */
const SUMMARY_H = 64;

/* ---------- layout ---------- */

const ROOT_CARD = { w: 260, h: 72, fontSize: 26 };
const FOLDER_CARD = { w: 220, h: 56, fontSize: 17 };
const FILE_CARD = { w: 176, h: 48, fontSize: 12 };
/** How far a child column sits right of its folder card: clears the widest
 * card plus a gutter, so no descendant can sit under its ancestor's card. */
const CHILD_DX = 280;
const GAP_Y = 12;

/**
 * The tree as a board: a folder card (root at the top font rung, mindmap-hub
 * precedent) with each subfolder's subtree and each file's card stacked below
 * and one gutter right of it — an indented outline, Finder-list style. Every
 * card is ordinary content: `layer: 'user'`, fresh ids, `createdAt` in
 * written order, so two imports coexist and the minimap reads the tree in the
 * order it grew.
 *
 * The returned `id` is a throwaway — the create route re-mints the board id
 * while keeping the node ids, which is exactly the coexistence property.
 *
 * `enrich` is the phase-2 AI pass's accepted payload, folded in as the board
 * is born (see FolderEnrich); omitted, the board is exactly phase 1's.
 */
export function buildFolderBoard(
  root: FolderTree,
  included: Set<string>,
  enrich?: FolderEnrich,
): Board {
  const t = Date.now();
  let seq = 0;
  const nodes: IdeaNode[] = [];
  const edges: Edge[] = [];
  // Every built file by its original relative path — the bridge the enrich
  // payload crosses. Folders are absent by design: summaries and import edges
  // are file→file things.
  const byPath = new Map<string, string>();

  const place = (node: FolderTree, x: number, y: number, kind: 'root' | 'folder'): { id: string; box: Rect } => {
    const size = kind === 'root' ? ROOT_CARD : FOLDER_CARD;
    const self = createNode({
      x,
      y,
      w: size.w,
      h: size.h,
      fontSize: size.fontSize,
      // A nameless root only happens on input the UI never produces; the
      // builder still owes it readable text.
      text: node.name || (kind === 'root' ? 'Dropped folders' : node.path),
      createdAt: t + seq++,
    });
    nodes.push(self);

    // Children stack downward in one column; each subtree reports its own
    // bounding box, which is taller than its folder card whenever it has
    // children of its own.
    let bottom = y + size.h;
    let right = x + size.w;
    let cursorY = y + size.h + GAP_Y;

    for (const sub of node.folders) {
      if (!included.has(sub.path)) continue;
      const { id, box } = place(sub, x + CHILD_DX, cursorY, 'folder');
      edges.push({ id: newId('e'), from: self.id, to: id, layer: 'user' });
      bottom = Math.max(bottom, box.y + box.h);
      right = Math.max(right, x + CHILD_DX + box.w);
      cursorY = box.y + box.h + GAP_Y;
    }

    for (const name of node.files) {
      const path = filePath(node, name);
      // A summary is applied as the card is created — not after — so the
      // taller card is a fact of the layout, not an overlap waiting to
      // happen. Whitespace is collapsed so one line is what "one-line
      // summary" promised, whatever the route let through.
      const summary = enrich?.summaries.get(path)?.replace(/\s+/g, ' ').trim();
      const h = summary ? SUMMARY_H : FILE_CARD.h;
      const file = createNode({
        x: x + CHILD_DX,
        y: cursorY,
        w: FILE_CARD.w,
        h,
        fontSize: FILE_CARD.fontSize,
        text: summary ? `${name}\n${summary}` : name,
        createdAt: t + seq++,
      });
      nodes.push(file);
      byPath.set(path, file.id);
      edges.push({ id: newId('e'), from: self.id, to: file.id, layer: 'user' });
      bottom = Math.max(bottom, file.y + h);
      right = Math.max(right, x + CHILD_DX + FILE_CARD.w);
      cursorY = file.y + h + GAP_Y;
    }

    return { id: self.id, box: { x, y, w: right - x, h: bottom - y } };
  };

  place(root, 0, 0, 'root');

  // Import links, file → file, over the cards that exist. Undirected by
  // edgePair — an a↔b cycle is one line — and deduped against the tree's own
  // edges, which is free insurance rather than an expected collision (tree
  // edges always involve a folder). Unknown paths, folders, and self-pairs
  // drop in silence: the builder is total.
  if (enrich) {
    const seen = new Set(edges.map((e) => edgePair(e.from, e.to).join('\0')));
    for (const [from, to] of enrich.imports) {
      const a = byPath.get(from);
      const b = byPath.get(to);
      if (!a || !b || a === b) continue;
      const key = edgePair(a, b).join('\0');
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ id: newId('e'), from: a, to: b, layer: 'user' });
    }
  }

  const name = root.name.trim();
  const objective = `Folder map${name ? ` “${name}”` : ''}: every card is a file or directory from disk, wired the way they nest. Ordinary board content — move, rename, delete, or mark things done.`;

  return {
    id: newId('b'),
    title: root.name,
    objective: objective.slice(0, OBJECTIVE_MAX),
    privacy: false,
    nodes,
    edges,
    updatedAt: t,
  };
}
