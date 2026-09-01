import { describe, expect, it } from 'vitest';
import {
  COLLAPSED_H,
  COLLAPSE_MODES,
  DEFAULT_COLLAPSE_MODE,
  DOT_SIZE,
  binnedNodes,
  cardView,
  isBinned,
  modeFromRow,
  modeToRow,
  normalizeCollapseMode,
  viewRect,
} from './collapse';
import { createNode, NODE_H, NODE_W } from './graph';

describe('normalizeCollapseMode', () => {
  it('passes every real mode through', () => {
    for (const m of COLLAPSE_MODES) expect(normalizeCollapseMode(m)).toBe(m);
  });

  it('lands junk and absence on the default', () => {
    // Same doctrine as normalizeTheme: a hand-edited row or a stale client's
    // PUT must not leave the canvas measuring cards against a non-answer.
    for (const junk of [null, undefined, 0, 1, true, '', 'fold', 'FULL', {}, [], NaN]) {
      expect(normalizeCollapseMode(junk)).toBe(DEFAULT_COLLAPSE_MODE);
    }
  });

  it('defaults to full size, so an install that never asked sees no change', () => {
    expect(DEFAULT_COLLAPSE_MODE).toBe('full');
  });
});

describe('the settings row codec', () => {
  it('round-trips every mode', () => {
    for (const m of COLLAPSE_MODES) expect(modeFromRow(modeToRow(m))).toBe(m);
  });

  it('reads a v2.8 and a v2.9 row as the fold it already had', () => {
    // The column held a 0/1 boolean before v2.9 and 0/1/2 before v3.0. Every
    // one of those values keeps its meaning exactly, which is why the bin
    // needed no migration either: the new mode appends, it does not reorder.
    expect(modeFromRow(0)).toBe('full');
    expect(modeFromRow(1)).toBe('line');
    expect(modeFromRow(2)).toBe('dot');
    expect(modeFromRow(3)).toBe('bin');
    expect(modeToRow('bin')).toBe(3);
  });

  it('lands an impossible row on the default', () => {
    for (const junk of [-1, 4, 99, 1.5, null, undefined, '1', {}]) {
      expect(modeFromRow(junk)).toBe(DEFAULT_COLLAPSE_MODE);
    }
  });
});

describe('cardView', () => {
  const done = { id: 'n1', done: true };
  const open = { id: 'n2', done: false };
  const none: ReadonlySet<string> = new Set();

  it('needs the setting, the ✓, and no peek — all three', () => {
    expect(cardView(done, 'line', none)).toBe('line');
    expect(cardView(done, 'dot', none)).toBe('dot');
    expect(cardView(done, 'bin', none)).toBe('bin');
    expect(cardView(done, 'full', none)).toBe(null);
    expect(cardView(open, 'dot', none)).toBe(null);
    expect(cardView(open, 'bin', none)).toBe(null);
    expect(cardView(done, 'dot', new Set(['n1']))).toBe(null);
  });

  it('lets a peek pull a card back out of the bin', () => {
    // The bin is a view, so the peek that opens a dot is the same one that
    // puts a binned card back on the canvas. There is no second mechanism.
    expect(cardView(done, 'bin', new Set(['n1']))).toBe(null);
  });

  it('is off for every card while the setting is full size', () => {
    // The whole feature costs an install that never turned it on nothing.
    expect(cardView(done, 'full', new Set(['n1']))).toBe(null);
    expect(cardView(open, 'full', none)).toBe(null);
  });

  it('reads a peek for the card it names and no other', () => {
    expect(cardView({ id: 'n3', done: true }, 'line', new Set(['n1']))).toBe('line');
  });
});

describe('isBinned', () => {
  it('is true for the bin and nothing else', () => {
    expect(isBinned('bin')).toBe(true);
    expect(isBinned('dot')).toBe(false);
    expect(isBinned('line')).toBe(false);
    expect(isBinned(null)).toBe(false);
    expect(isBinned(undefined)).toBe(false);
  });
});

describe('binnedNodes', () => {
  const nodes = [
    { id: 'a', done: true, createdAt: 1 },
    { id: 'b', done: false, createdAt: 2 },
    { id: 'c', done: true, createdAt: 3 },
  ];
  const none: ReadonlySet<string> = new Set();

  it('holds the done cards, newest first', () => {
    expect(binnedNodes(nodes, 'bin', none).map((n) => n.id)).toEqual(['c', 'a']);
  });

  it('is empty in every other mode — there is no bin unless the setting says so', () => {
    for (const m of ['full', 'line', 'dot'] as const) {
      expect(binnedNodes(nodes, m, none)).toEqual([]);
    }
  });

  it('drops a card that has been peeked back onto the canvas', () => {
    expect(binnedNodes(nodes, 'bin', new Set(['c'])).map((n) => n.id)).toEqual(['a']);
  });
});

describe('viewRect', () => {
  const n = createNode({ x: 40, y: 80 });

  it('leaves an open card exactly as the node stores it', () => {
    expect(viewRect(n, null)).toEqual({ x: 40, y: 80, w: NODE_W, h: NODE_H });
    expect(viewRect(n, undefined)).toEqual({ x: 40, y: 80, w: NODE_W, h: NODE_H });
  });

  it('takes only the height off a stub — the columns the person arranged hold', () => {
    expect(viewRect(n, 'line')).toEqual({ x: 40, y: 80, w: NODE_W, h: COLLAPSED_H });
  });

  it('takes both off a dot, from the top-left the card was already anchored at', () => {
    // Narrowing is the whole of what the dot is for, and it costs only the
    // right edge: x and y are untouched, so a column keeps its left edge.
    expect(viewRect(n, 'dot')).toEqual({ x: 40, y: 80, w: DOT_SIZE, h: DOT_SIZE });
  });

  it('keeps a resized card’s own width folded to a line, and gives it all back', () => {
    const wide = { ...n, w: 320, h: 240 };
    expect(viewRect(wide, 'line')).toEqual({ x: 40, y: 80, w: 320, h: COLLAPSED_H });
    expect(viewRect(wide, 'dot')).toEqual({ x: 40, y: 80, w: DOT_SIZE, h: DOT_SIZE });
    expect(viewRect(wide, null)).toEqual({ x: 40, y: 80, w: 320, h: 240 });
  });

  it('gives a binned card no footprint at all, at the place it still holds', () => {
    // Zero-size is the honest answer for a card the canvas is not drawing, and
    // it is the useful one: placeProposal sees no obstacle and the rubber band
    // cannot catch it. x and y stay, because the card has not moved — peeking
    // it back must put it exactly where its author left it.
    expect(viewRect(n, 'bin')).toEqual({ x: 40, y: 80, w: 0, h: 0 });
    expect(viewRect({ ...n, w: 320, h: 240 }, 'bin')).toEqual({ x: 40, y: 80, w: 0, h: 0 });
  });

  it('never writes the node', () => {
    // The reason there is no migration: folding is a view, not a field.
    const before = JSON.stringify(n);
    viewRect(n, 'dot');
    viewRect(n, 'line');
    viewRect(n, 'bin');
    expect(JSON.stringify(n)).toBe(before);
  });
});
