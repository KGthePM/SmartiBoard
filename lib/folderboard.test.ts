import { describe, expect, it } from 'vitest';
import { intersects, NODE_FONT_STEPS, OBJECTIVE_MAX, parseBoard, rectOf } from './graph';
import {
  buildFolderBoard,
  countFiles,
  countIncludedFiles,
  defaultIncluded,
  findJunkDirs,
  includedFilePaths,
  isJunkDir,
  isJunkFile,
  JUNK_DIRS,
  JUNK_FILES,
  MAX_FILES,
  scanPaths,
  WARN_FILES,
  type FolderTree,
} from './folderboard';

describe('scanPaths', () => {
  it('builds a sorted tree and hoists the single top-level folder as the root', () => {
    const { root } = scanPaths([
      'proj/src/a.ts',
      'proj/src/b.ts',
      'proj/lib/x.ts',
      'proj/README.md',
    ]);
    expect(root.name).toBe('proj');
    // The hoisted root keeps its original path key, so files directly under
    // it still key as 'proj/README.md' — the space the phase-2 pass speaks.
    expect(root.path).toBe('proj');
    expect(root.files).toEqual(['README.md']);
    expect(root.folders.map((f) => f.name)).toEqual(['lib', 'src']);
    expect(root.folders[1].files).toEqual(['a.ts', 'b.ts']);
    expect(root.folders[1].path).toBe('proj/src');
  });

  it('sorts by code point, not locale — the same folder is the same board everywhere', () => {
    const { root } = scanPaths(['p/B/z.ts', 'p/a/y.ts']);
    // 'B' (0x42) precedes 'a' (0x61); a locale-aware sort would flip them.
    expect(root.folders.map((f) => f.name)).toEqual(['B', 'a']);
  });

  it('drops OS junk files at scan and counts them', () => {
    const { root, skippedJunkFiles } = scanPaths(['p/.DS_Store', 'p/Thumbs.db', 'p/x.ts']);
    expect(root.files).toEqual(['x.ts']);
    expect(skippedJunkFiles).toBe(2);
  });

  it('tolerates junk input: empty segments and duplicate paths degrade, never throw', () => {
    const { root } = scanPaths(['', 'p//a.ts', 'p/b.ts', 'p/b.ts']);
    expect(root.name).toBe('p');
    expect(root.files).toEqual(['a.ts', 'b.ts']);
  });

  it('keeps a bare file at the root instead of hoisting nothing', () => {
    const { root } = scanPaths(['loose.md']);
    expect(root.name).toBe('');
    expect(root.files).toEqual(['loose.md']);
    expect(root.folders).toHaveLength(0);
  });

  it('tolerates several top-level folders — they become the root’s children', () => {
    const { root } = scanPaths(['a/x.ts', 'b/y.ts']);
    expect(root.name).toBe('');
    expect(root.folders.map((f) => f.name)).toEqual(['a', 'b']);
  });
});

describe('junk defaults', () => {
  it('excludes junk dirs and everything inside them; a normal folder stays in', () => {
    const { root } = scanPaths([
      'p/node_modules/z/x.js',
      'p/node_modules/inner/y.js',
      'p/src/a.ts',
      'p/dist/b.js',
    ]);
    const included = defaultIncluded(root);
    expect(included.has('p/src')).toBe(true);
    expect(included.has('p/node_modules')).toBe(false);
    expect(included.has('p/node_modules/z')).toBe(false);
    expect(included.has('p/node_modules/inner')).toBe(false);
    expect(included.has('p/dist')).toBe(false);
  });

  it('names the junk dirs that are actually present, for the modal’s note', () => {
    const { root } = scanPaths(['p/node_modules/a/b.js', 'p/dist/x.js', 'p/src/a.ts']);
    expect(findJunkDirs(root)).toEqual(['dist', 'node_modules']);
  });

  it('knows its own junk lists', () => {
    for (const n of JUNK_DIRS) expect(isJunkDir(n)).toBe(true);
    for (const n of JUNK_FILES) expect(isJunkFile(n)).toBe(true);
    expect(isJunkDir('src')).toBe(false);
    expect(isJunkFile('main.ts')).toBe(false);
  });
});

describe('counts', () => {
  const { root } = scanPaths(['proj/src/a.ts', 'proj/src/b.ts', 'proj/lib/x.ts', 'proj/README.md']);

  it('countFiles totals a subtree', () => {
    expect(countFiles(root)).toBe(4);
    expect(countFiles(root.folders[1])).toBe(2); // src
  });

  it('countIncludedFiles counts only checked folders; the root always counts', () => {
    expect(countIncludedFiles(root, defaultIncluded(root))).toBe(4);
    const less = defaultIncluded(root);
    less.delete('proj/lib');
    expect(countIncludedFiles(root, less)).toBe(3);
    expect(countIncludedFiles(root, new Set())).toBe(1); // the root’s README
  });
});

describe('buildFolderBoard', () => {
  const PATHS = ['proj/src/a.ts', 'proj/src/sub/b.ts', 'proj/lib/x.ts', 'proj/README.md'];
  const { root } = scanPaths(PATHS);
  const included = defaultIncluded(root);
  const board = buildFolderBoard(root, included);

  it('builds one card per included folder and file, one edge per non-root card', () => {
    // root + src + src/sub + lib folders, a.ts + b.ts + x.ts + README.md files.
    expect(board.nodes).toHaveLength(8);
    expect(board.edges).toHaveLength(7);
    const incoming = new Map<string, number>();
    for (const e of board.edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
    expect(incoming.has(board.nodes[0].id)).toBe(false);
    for (const n of board.nodes.slice(1)) expect(incoming.get(n.id)).toBe(1);
  });

  it('wires every edge out of a folder card, never out of a file card', () => {
    const byId = new Map(board.nodes.map((n) => [n.id, n]));
    for (const e of board.edges) {
      expect(byId.get(e.from)?.fontSize ?? 0).toBeGreaterThanOrEqual(17);
    }
  });

  it('uses the font ladder: root 26, folders 17, files 12', () => {
    for (const n of board.nodes) expect(NODE_FONT_STEPS).toContain(n.fontSize);
    expect(board.nodes[0].fontSize).toBe(26);
    const file = board.nodes.find((n) => n.text === 'README.md');
    expect(file?.fontSize).toBe(12);
  });

  it('names the board after the folder and ships a non-empty objective', () => {
    expect(board.title).toBe('proj');
    expect(board.objective.trim().length).toBeGreaterThan(0);
    expect(board.objective).toContain('proj');
    expect(board.objective.length).toBeLessThanOrEqual(OBJECTIVE_MAX);
    expect(board.privacy).toBe(false);
  });

  it('is deterministic: two builds agree on geometry and text, and never share ids', () => {
    const again = buildFolderBoard(root, included);
    const shape = (b: typeof board) =>
      b.nodes.map((n) => [n.text, n.x, n.y, n.w, n.h, n.fontSize]);
    expect(shape(again)).toEqual(shape(board));
    const ids = new Set(board.nodes.map((n) => n.id));
    expect(again.nodes.some((n) => ids.has(n.id))).toBe(false);
    const times = board.nodes.map((n) => n.createdAt);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
  });

  it('lays out without overlaps, shallow or deep', () => {
    for (const b of [board, bigBoard()]) {
      const cards = b.nodes.map(rectOf);
      for (let i = 0; i < cards.length; i++) {
        for (let j = i + 1; j < cards.length; j++) {
          expect(intersects(cards[i], cards[j])).toBe(false);
        }
      }
    }
  });

  it('builds just the hub and its own loose files when nothing else is checked', () => {
    const bare = buildFolderBoard(root, new Set());
    expect(bare.nodes.map((n) => n.text)).toEqual(['proj', 'README.md']);
    expect(bare.edges).toHaveLength(1);
  });

  it('gives a childless folder its card anyway — the builder is total', () => {
    const lone: FolderTree = { name: 'solo', path: 'solo', folders: [], files: [] };
    const tree: FolderTree = { name: 'r', path: '', folders: [lone], files: ['loose.txt'] };
    const b = buildFolderBoard(tree, new Set(['solo']));
    expect(b.nodes).toHaveLength(3);
    expect(b.edges).toHaveLength(2);
  });

  it('survives the round trip the create route will put it through', () => {
    const loaded = parseBoard('x1', JSON.parse(JSON.stringify(board)));
    expect(loaded.nodes).toHaveLength(board.nodes.length);
    expect(loaded.edges).toHaveLength(board.edges.length);
    expect(loaded.title).toBe('proj');
    expect(loaded.objective).toBe(board.objective);
  });
});

/** A wide-and-deep generated tree, for the overlap check. */
function bigBoard() {
  const paths: string[] = [];
  for (let i = 0; i < 40; i++) paths.push(`big/src/f${i}.ts`);
  for (let i = 0; i < 10; i++) paths.push(`big/a/b/c/d${i}.ts`);
  for (let i = 0; i < 10; i++) paths.push(`big/a/e${i}.ts`);
  const { root } = scanPaths(paths);
  return buildFolderBoard(root, defaultIncluded(root));
}

describe('includedFilePaths', () => {
  it('lists exactly the files a build would create, by their original paths', () => {
    const { root } = scanPaths(['proj/src/a.ts', 'proj/src/b.ts', 'proj/lib/x.ts', 'proj/README.md']);
    expect(includedFilePaths(root, defaultIncluded(root))).toEqual([
      'proj/README.md',
      'proj/lib/x.ts',
      'proj/src/a.ts',
      'proj/src/b.ts',
    ]);
    const less = defaultIncluded(root);
    less.delete('proj/src');
    expect(includedFilePaths(root, less)).toEqual(['proj/README.md', 'proj/lib/x.ts']);
  });
});

describe('buildFolderBoard with enrich (the AI pass)', () => {
  const PATHS = ['proj/src/a.ts', 'proj/src/b.ts', 'proj/lib/x.ts', 'proj/README.md'];
  const { root } = scanPaths(PATHS);
  const included = defaultIncluded(root);

  const summaries = new Map([
    ['proj/src/a.ts', 'Entry point: boots the app and wires the router.'],
    ['proj/README.md', 'Setup and usage notes.'],
  ]);
  const imports: Array<[string, string]> = [
    ['proj/src/a.ts', 'proj/src/b.ts'],
    ['proj/src/b.ts', 'proj/src/a.ts'], // cycle → one line
    ['proj/src/a.ts', 'proj/src/b.ts'], // duplicate pair → one line
    ['proj/src/a.ts', 'proj/src/a.ts'], // self → dropped
    ['proj/src/a.ts', 'proj/gone.ts'], // excluded/nonexistent → dropped in silence
    ['proj/src/a.ts', 'proj/lib'], // a folder path, not a file → dropped
  ];
  const board = buildFolderBoard(root, included, { summaries, imports });

  it('writes the summary as the card’s second line and makes the card taller', () => {
    const a = board.nodes.find((n) => n.text.startsWith('a.ts\n'));
    expect(a?.text).toBe('a.ts\nEntry point: boots the app and wires the router.');
    expect(a?.h).toBe(64);
    expect(a?.fontSize).toBe(12);
    const plain = board.nodes.find((n) => n.text === 'b.ts');
    expect(plain?.h).toBe(48);
  });

  it('collapses whitespace in a summary so one line is what arrives', () => {
    const noisy = buildFolderBoard(root, included, {
      summaries: new Map([['proj/src/a.ts', 'boots\n   the   app']]),
      imports: [],
    });
    expect(noisy.nodes.find((n) => n.text.startsWith('a.ts'))?.text).toBe('a.ts\nboots the app');
  });

  it('treats an empty summary as no summary', () => {
    const blank = buildFolderBoard(root, included, {
      summaries: new Map([['proj/src/a.ts', '   ']]),
      imports: [],
    });
    expect(blank.nodes.find((n) => n.text === 'a.ts')?.h).toBe(48);
  });

  it('adds import edges file→file, undirected-deduped, dropping junk pairs', () => {
    // Tree edges: 6 (one per non-root card of this 7-card fixture). The pass
    // adds exactly one a↔b line — the cycle, the duplicate, the self-pair,
    // the missing file and the folder path all collapse away.
    expect(board.edges).toHaveLength(7);
    const a = board.nodes.find((n) => n.text.startsWith('a.ts\n'))!.id;
    const b = board.nodes.find((n) => n.text === 'b.ts')!.id;
    const link = board.edges.filter((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
    expect(link).toHaveLength(1);
    expect(link[0].layer).toBe('user');
  });

  it('stays overlap-free with taller summarized cards in the column', () => {
    const cards = board.nodes.map(rectOf);
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        expect(intersects(cards[i], cards[j])).toBe(false);
      }
    }
  });

  it('an empty or omitted enrich changes nothing — the phase-1 board stands', () => {
    const plain = buildFolderBoard(root, included);
    const empty = buildFolderBoard(root, included, { summaries: new Map(), imports: [] });
    // Edges by their endpoints' *text* (ids are fresh every build — the
    // coexistence property, not a difference).
    const shape = (b: typeof board) => {
      const words = new Map(b.nodes.map((n) => [n.id, n.text]));
      return [
        b.nodes.map((n) => [n.text, n.x, n.y, n.w, n.h]),
        b.edges.map((e) => [words.get(e.from), words.get(e.to)]),
      ];
    };
    expect(shape(empty)).toEqual(shape(plain));
    expect(shape(buildFolderBoard(root, included, undefined))).toEqual(shape(plain));
  });

  it('survives the round trip with summaries and links aboard', () => {
    const loaded = parseBoard('x2', JSON.parse(JSON.stringify(board)));
    expect(loaded.nodes).toHaveLength(board.nodes.length);
    expect(loaded.edges).toHaveLength(board.edges.length);
    expect(loaded.nodes.some((n) => n.text.startsWith('a.ts\n'))).toBe(true);
  });
});

describe('caps', () => {
  it('warns below the hard cap', () => {
    expect(WARN_FILES).toBeLessThan(MAX_FILES);
    expect(JUNK_DIRS.length).toBeGreaterThan(0);
    expect(JUNK_FILES.length).toBeGreaterThan(0);
  });
});
