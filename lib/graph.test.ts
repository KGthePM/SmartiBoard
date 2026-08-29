import { describe, expect, it } from 'vitest';
import {
  clampSize,
  createNode,
  emptyBoard,
  fitViewport,
  NODE_FONT_DEFAULT,
  NODE_MIN_H,
  NODE_MIN_W,
  NODE_FONT_STEPS,
  nodesInRect,
  OBJECTIVE_MAX,
  parseBoard,
  removeNodes,
  snapFontSize,
  stepFontSize,
  VIEW_MAX_SCALE,
  VIEW_MIN_SCALE,
  type Edge,
} from './graph';

describe('clampSize', () => {
  it('rounds to whole pixels and leaves room-sized values alone', () => {
    expect(clampSize(240.4, 120.6)).toEqual({ w: 240, h: 121 });
    expect(clampSize(NODE_MIN_W + 60, NODE_MIN_H + 40)).toEqual({
      w: NODE_MIN_W + 60,
      h: NODE_MIN_H + 40,
    });
  });

  it('clamps at the minimums, whatever comes in', () => {
    expect(clampSize(12, -40)).toEqual({ w: NODE_MIN_W, h: NODE_MIN_H });
    expect(clampSize(NaN, NaN)).toEqual({ w: NODE_MIN_W, h: NODE_MIN_H });
  });
});

describe('done', () => {
  it('starts false on a fresh node', () => {
    expect(createNode({ x: 0, y: 0 }).done).toBe(false);
  });

  it('survives a round trip through persistence', () => {
    const board = emptyBoard('b');
    board.nodes = [createNode({ id: 'n0', x: 0, y: 0, text: 'ship it', done: true })];
    const parsed = parseBoard('b', JSON.parse(JSON.stringify(board)));
    expect(parsed.nodes[0].done).toBe(true);
  });

  it('loads boards saved before done existed as not done', () => {
    const parsed = parseBoard('b', {
      nodes: [{ id: 'n0', x: 0, y: 0, text: 'an old idea' }],
      edges: [],
    });
    expect(parsed.nodes[0].done).toBe(false);
  });

  it('drops a done flag that is not strictly true', () => {
    const parsed = parseBoard('b', {
      nodes: [
        { id: 'n0', x: 0, y: 0, text: 'junk', done: 'yes' },
        { id: 'n1', x: 0, y: 0, text: 'junk', done: 1 },
      ],
      edges: [],
    });
    expect(parsed.nodes.map((n) => n.done)).toEqual([false, false]);
  });
});

describe('fontSize', () => {
  it('starts at the body font on a fresh node — untouched cards render as they always did', () => {
    expect(createNode({ x: 0, y: 0 }).fontSize).toBe(NODE_FONT_DEFAULT);
  });

  it('survives a round trip through persistence', () => {
    const board = emptyBoard('b');
    board.nodes = [createNode({ id: 'n0', x: 0, y: 0, text: 'headline', fontSize: 26 })];
    const parsed = parseBoard('b', JSON.parse(JSON.stringify(board)));
    expect(parsed.nodes[0].fontSize).toBe(26);
  });

  it('loads boards saved before text sizes existed at the default', () => {
    const parsed = parseBoard('b', {
      nodes: [{ id: 'n0', x: 0, y: 0, text: 'an old idea' }],
      edges: [],
    });
    expect(parsed.nodes[0].fontSize).toBe(NODE_FONT_DEFAULT);
  });

  it('snaps off-ladder numbers onto the nearest rung and drops junk', () => {
    // A hand-edited row lands on a real size; anything else is not a size.
    expect(snapFontSize(15)).toBe(14);
    expect(snapFontSize(23)).toBe(21);
    expect(snapFontSize(0)).toBe(12);
    expect(snapFontSize(999)).toBe(26);
    expect(snapFontSize('big')).toBe(NODE_FONT_DEFAULT);
    expect(snapFontSize(null)).toBe(NODE_FONT_DEFAULT);
    expect(snapFontSize(NaN)).toBe(NODE_FONT_DEFAULT);
  });

  it('steps one rung at a time and holds at the ends', () => {
    expect(stepFontSize(14, 1)).toBe(17);
    expect(stepFontSize(17, -1)).toBe(14);
    expect(stepFontSize(NODE_FONT_STEPS[0], -1)).toBe(NODE_FONT_STEPS[0]);
    expect(stepFontSize(NODE_FONT_STEPS[NODE_FONT_STEPS.length - 1], 1)).toBe(
      NODE_FONT_STEPS[NODE_FONT_STEPS.length - 1],
    );
    // A value that is not on the ladder (a stale board mid-migration, say)
    // restarts from the default rather than throwing.
    expect(stepFontSize(15, 1)).toBe(NODE_FONT_DEFAULT);
  });
});

describe('objective', () => {
  it('starts empty — a board never demands a stated purpose first', () => {
    expect(emptyBoard('b').objective).toBe('');
  });

  it('round-trips through the wire', () => {
    const raw = { objective: 'Ship async review to design teams by Q3.', nodes: [], edges: [] };
    expect(parseBoard('b', raw).objective).toBe('Ship async review to design teams by Q3.');
  });

  it('loads boards saved before objectives existed', () => {
    expect(parseBoard('b', { title: 'old', nodes: [], edges: [] }).objective).toBe('');
  });

  it('drops a non-string rather than trusting the wire', () => {
    expect(parseBoard('b', { objective: { goal: 'x' }, nodes: [] }).objective).toBe('');
    expect(parseBoard('b', { objective: 42, nodes: [] }).objective).toBe('');
  });

  it('truncates past the cap, because every character rides in the prompt', () => {
    const long = 'x'.repeat(OBJECTIVE_MAX + 200);
    expect(parseBoard('b', { objective: long, nodes: [] }).objective).toHaveLength(
      OBJECTIVE_MAX,
    );
  });
});

describe('fitViewport', () => {
  it('gives an empty board the origin at rest — presenting nothing must not crash', () => {
    expect(fitViewport([], { w: 1200, h: 800 })).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it('caps how far a fit will zoom in, and centers within the padding', () => {
    // One lone card: fitting it honestly would demand scale 5+, which the
    // wheel could never keep company with, so the cap holds and the card
    // centers inside the padded frame instead.
    const v = fitViewport([createNode({ x: 0, y: 0 })], { w: 1200, h: 800 });
    expect(v.scale).toBe(VIEW_MAX_SCALE);
    // Card center lands at the surface center: 600, 400.
    expect(v.x + (200 * v.scale) / 2).toBe(600);
    expect(v.y + (96 * v.scale) / 2).toBe(400);
  });

  it('fits a spread board and centers it', () => {
    // A 2000-wide pair of cards in a 1000-wide window with no padding: scale
    // 0.5 exactly, x pinned so the span starts at the left edge, y centered.
    const nodes = [createNode({ x: 0, y: 0 }), createNode({ x: 1800, y: 0 })];
    const v = fitViewport(nodes, { w: 1000, h: 1000 }, 0);
    expect(v).toEqual({ x: 0, y: 476, scale: 0.5 });
  });

  it('floors how far a fit will zoom out, like the wheel does', () => {
    const nodes = [createNode({ x: 0, y: 0 }), createNode({ x: 100000, y: 0 })];
    expect(fitViewport(nodes, { w: 1000, h: 1000 }, 0).scale).toBe(VIEW_MIN_SCALE);
  });

  it('centers boards that live far from the origin, not just small ones', () => {
    // A board at (1000, 2000) should land mid-screen, not mid-desert: the
    // translate accounts for where the bounds actually are.
    const v = fitViewport([createNode({ x: 1000, y: 2000 })], { w: 1000, h: 800 }, 0);
    // The card's center in screen terms: its own center, through the camera.
    expect(v.x + (1000 + 200 / 2) * v.scale).toBe(500);
    expect(v.y + (2000 + 96 / 2) * v.scale).toBe(400);
  });
});

describe('removeNodes', () => {
  /** Three cards in a line, all connected: a—b—c. */
  function line() {
    const b = emptyBoard('b');
    b.nodes = [
      createNode({ id: 'a', x: 0, y: 0 }),
      createNode({ id: 'b', x: 300, y: 0 }),
      createNode({ id: 'c', x: 600, y: 0 }),
    ];
    const edge = (id: string, from: string, to: string): Edge => ({
      id,
      from,
      to,
      layer: 'user',
    });
    b.edges = [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'a', 'c')];
    return b;
  }

  it('removes the listed nodes and every edge that touched them', () => {
    const out = removeNodes(line(), ['a', 'b']);
    expect(out.nodes.map((n) => n.id)).toEqual(['c']);
    expect(out.edges).toEqual([]);
  });

  it('keeps the edge between two survivors', () => {
    const out = removeNodes(line(), ['a']);
    expect(out.nodes.map((n) => n.id)).toEqual(['b', 'c']);
    // b—c survives; a's two edges die with it.
    expect(out.edges.map((e) => e.id)).toEqual(['e2']);
  });

  it('leaves the board alone for an empty or unknown batch', () => {
    const b = line();
    expect(removeNodes(b, [])).toEqual(b);
    expect(removeNodes(b, ['n_nope']).nodes).toHaveLength(3);
  });
});

describe('nodesInRect', () => {
  it('returns exactly the cards the sweep touches — crossing counts, not containment', () => {
    const b = emptyBoard('b');
    b.nodes = [
      createNode({ id: 'in1', x: 0, y: 0 }),
      createNode({ id: 'in2', x: 100, y: 100 }),
      createNode({ id: 'out', x: 1000, y: 1000 }),
    ];
    expect(nodesInRect(b, { x: -10, y: -10, w: 320, h: 320 })).toEqual(['in1', 'in2']);
  });

  it('returns nothing for a sweep over empty canvas', () => {
    const b = emptyBoard('b');
    b.nodes = [createNode({ id: 'a', x: 0, y: 0 })];
    expect(nodesInRect(b, { x: 500, y: 500, w: 100, h: 100 })).toEqual([]);
  });
});

describe('privacy', () => {
  it('starts off — a board is only silent because someone said so', () => {
    expect(emptyBoard('b').privacy).toBe(false);
  });

  it('round-trips through the wire', () => {
    expect(parseBoard('b', { privacy: true, nodes: [], edges: [] }).privacy).toBe(true);
  });

  it('loads boards saved before privacy mode existed', () => {
    expect(parseBoard('b', { title: 'old', nodes: [], edges: [] }).privacy).toBe(false);
  });

  it('takes strictly true, so junk off the wire never reads as private', () => {
    // The dangerous direction is the other one, but a truthy string turning a
    // board private without being asked is still the wire deciding, not a user.
    for (const junk of ['true', 1, {}, [], 'yes']) {
      expect(parseBoard('b', { privacy: junk, nodes: [] }).privacy).toBe(false);
    }
  });
});
