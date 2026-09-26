import { describe, expect, it } from 'vitest';
import { OBJECTIVE_MAX, parseBoard } from './graph';
import { buildHowBoard } from './howboard';
import type { HowCard } from './ai/how-prompt';

const CARDS: HowCard[] = [
  { title: 'Entry', body: 'boots the app', files: ['src/a.ts'] },
  { title: 'Helpers', body: 'shared utils', files: ['lib/u.ts', 'lib/v.ts'] },
  { title: 'Data', body: 'the store', files: ['lib/store.ts'] },
];

describe('buildHowBoard — edges from real imports only', () => {
  const board = buildHowBoard(
    CARDS,
    [
      ['src/a.ts', 'lib/u.ts'], // Entry → Helpers
      ['src/a.ts', 'lib/u.ts'], // duplicate pair → one line
      ['src/a.ts', 'lib/store.ts'], // Entry → Data
      ['lib/u.ts', 'lib/v.ts'], // both files on Helpers → self pair, dropped
      ['src/gone.ts', 'lib/u.ts'], // importer claimed by no card → dropped
      ['src/a.ts', 'src/nowhere.ts'], // imported file claimed by no card → dropped
    ],
    'proj',
  );

  const words = new Map(board.nodes.map((n) => [n.id, n.text.split('\n')[0]]));

  it('draws importer card → imported card, one per pair, nothing else', () => {
    expect(board.edges).toHaveLength(2);
    const pairs = board.edges.map((e) => [words.get(e.from), words.get(e.to)]).sort();
    expect(pairs).toEqual([
      ['Entry', 'Data'],
      ['Entry', 'Helpers'],
    ]);
    for (const e of board.edges) expect(e.layer).toBe('user');
  });

  it('collapses a multi-file overlap between two cards into one edge', () => {
    const b = buildHowBoard(
      [
        { title: 'A', body: 'x', files: ['a1.ts', 'a2.ts'] },
        { title: 'B', body: 'y', files: ['b1.ts', 'b2.ts'] },
      ],
      [
        ['a1.ts', 'b1.ts'],
        ['a1.ts', 'b2.ts'],
        ['a2.ts', 'b1.ts'],
        ['a2.ts', 'b2.ts'],
      ],
      'proj',
    );
    expect(b.edges).toHaveLength(1);
  });

  it('draws no edge at all when no import pair crosses cards', () => {
    const b = buildHowBoard(CARDS, [], 'proj');
    expect(b.edges).toHaveLength(0);
  });
});

describe('buildHowBoard — file claims', () => {
  it('gives a doubly-claimed file to the first card and never duplicates it', () => {
    const b = buildHowBoard(
      [
        { title: 'First', body: 'x', files: ['shared.ts', 'one.ts'] },
        { title: 'Second', body: 'y', files: ['shared.ts', 'two.ts'] },
      ],
      [
        ['two.ts', 'shared.ts'], // Second → First (shared.ts belongs to First)
        ['shared.ts', 'one.ts'], // self pair on First, dropped
      ],
      'proj',
    );
    expect(b.nodes).toHaveLength(2);
    const words = new Map(b.nodes.map((n) => [n.id, n.text.split('\n')[0]]));
    expect(b.edges).toHaveLength(1);
    expect(words.get(b.edges[0].from)).toBe('Second');
    expect(words.get(b.edges[0].to)).toBe('First');
  });
});

describe('buildHowBoard — layered layout', () => {
  it('layers along the import direction: Entry one step right of what it imports', () => {
    // The Step 3 layerer puts each imported card left of its importer
    // (depth grows along import edges), so Entry sits at x 360.
    const board = buildHowBoard(CARDS, [['src/a.ts', 'lib/u.ts']], 'proj');
    const x = new Map(board.nodes.map((n) => [n.text.split('\n')[0], n.x]));
    expect(x.get('Entry')).toBe(360);
    expect(x.get('Helpers')).toBe(0);
    expect(x.get('Data')).toBe(0);
  });

  it('with no edges, all cards share layer 0 in one column, sorted by title', () => {
    const board = buildHowBoard(CARDS, [], 'proj');
    expect(board.nodes.every((n) => n.x === 0)).toBe(true);
    expect(board.nodes.map((n) => n.text.split('\n')[0])).toEqual(['Data', 'Entry', 'Helpers']);
    for (let i = 1; i < board.nodes.length; i++) {
      expect(board.nodes[i].y).toBeGreaterThan(board.nodes[i - 1].y);
    }
  });

  it('survives an import cycle: recursion terminates and the cycle closes', () => {
    const cyc: HowCard[] = [
      { title: 'P', body: 'x', files: ['p.ts'] },
      { title: 'Q', body: 'y', files: ['q.ts'] },
      { title: 'R', body: 'z', files: ['r.ts'] },
    ];
    // p → q → r → p, plus a card downstream of R.
    const withTail: HowCard[] = [...cyc, { title: 'Tail', body: 't', files: ['t.ts'] }];
    const board = buildHowBoard(
      withTail,
      [
        ['p.ts', 'q.ts'],
        ['q.ts', 'r.ts'],
        ['r.ts', 'p.ts'],
        ['r.ts', 't.ts'],
      ],
      'proj',
    );
    // No throw and all four cards present is the contract. The seen-guard
    // terminates the loop: each cycle member lands one step deeper than the
    // next (R < Q < P), while Tail — first reached *inside* the cycle walk —
    // is memoized at layer 0 before R's depth is known. Deterministic and
    // bounded; noted as a quirk in the task report.
    expect(board.nodes).toHaveLength(4);
    for (const n of board.nodes) {
      expect(n.x).toBeLessThan(4 * 360);
      expect(Number.isInteger(n.x / 360)).toBe(true);
    }
    const x = new Map(board.nodes.map((n) => [n.text.split('\n')[0], n.x]));
    expect(x.get('Tail')).toBe(0);
    expect(x.get('R')!).toBeLessThan(x.get('Q')!);
    expect(x.get('Q')!).toBeLessThan(x.get('P')!);
    expect(board.edges).toHaveLength(4);
  });
});

describe('buildHowBoard — the board itself', () => {
  const board = buildHowBoard(CARDS, [['src/a.ts', 'lib/u.ts']], '  My Project  ');

  it('writes the card as title newline body, layer user, sized per the brief', () => {
    for (const n of board.nodes) {
      expect(n.layer).toBe('user');
      expect(n.fontSize).toBe(17);
      expect([n.w, n.h]).toEqual([300, 120]);
    }
    const entry = board.nodes.find((n) => n.text.startsWith('Entry\n'));
    expect(entry?.text).toBe('Entry\nboots the app');
  });

  it('names the board and ships a non-empty objective within the cap', () => {
    expect(board.title).toBe('My Project — how it works');
    expect(board.objective.trim().length).toBeGreaterThan(0);
    expect(board.objective.length).toBeLessThanOrEqual(OBJECTIVE_MAX);
    expect(board.objective).toContain('My Project');
    expect(board.privacy).toBe(false);
  });

  it('falls back to the nameless title and objective when the project name is blank', () => {
    const b = buildHowBoard(CARDS, [], '   ');
    expect(b.title).toBe('How it works');
    expect(b.objective).toContain('this project');
  });

  it('is deterministic in shape but mints fresh ids on every call', () => {
    const again = buildHowBoard(CARDS, [['src/a.ts', 'lib/u.ts']], 'proj');
    const shape = (b: typeof board) => [
      b.nodes.map((n) => [n.text, n.x, n.y, n.w, n.h, n.fontSize]),
      b.edges.map((e) => [e.layer]),
    ];
    expect(shape(again)).toEqual(shape(board));
    const ids = new Set(board.nodes.map((n) => n.id));
    expect(again.nodes.some((n) => ids.has(n.id))).toBe(false);
  });

  it('is total: an empty card list is a valid empty board, never a throw', () => {
    const empty = buildHowBoard([], [['a.ts', 'b.ts']], 'proj');
    expect(empty.nodes).toEqual([]);
    expect(empty.edges).toEqual([]);
    expect(empty.title).toBe('proj — how it works');
    expect(empty.objective.trim().length).toBeGreaterThan(0);
  });

  it('survives the round trip the create route will put it through', () => {
    const loaded = parseBoard('how1', JSON.parse(JSON.stringify(board)));
    expect(loaded.nodes).toHaveLength(board.nodes.length);
    expect(loaded.edges).toHaveLength(board.edges.length);
    expect(loaded.title).toBe(board.title);
    expect(loaded.objective).toBe(board.objective);
  });
});
