import { describe, expect, it } from 'vitest';
import { boardTitle, deriveTitle, previewOf, relativeTime, summarize, UNTITLED } from './boards';
import { createNode, emptyBoard, type Board, type IdeaNode } from './graph';

function board(nodes: Partial<IdeaNode>[]): Board {
  const b = emptyBoard('t');
  b.nodes = nodes.map((n, i) => createNode({ x: 0, y: 0, createdAt: 1_000 + i, ...n }));
  return b;
}

describe('deriveTitle', () => {
  it('names a board after the idea that started it', () => {
    const b = board([
      { text: 'Pricing page rewrite', createdAt: 10 },
      { text: 'Something thought of later', createdAt: 20 },
    ]);
    expect(deriveTitle(b)).toBe('Pricing page rewrite');
  });

  it('prefers what the user wrote over what the AI proposed', () => {
    // A board belongs to its author; an accepted suggestion must not name it,
    // even when it happens to be the oldest card on the canvas.
    const b = board([
      { text: 'Bundle the analytics tier', layer: 'accepted', createdAt: 10 },
      { text: 'Pricing page rewrite', layer: 'user', createdAt: 20 },
    ]);
    expect(deriveTitle(b)).toBe('Pricing page rewrite');
  });

  it('falls back to accepted content when the user has written nothing', () => {
    const b = board([{ text: 'Bundle the analytics tier', layer: 'accepted' }]);
    expect(deriveTitle(b)).toBe('Bundle the analytics tier');
  });

  it('never shows formatting markers in a name', () => {
    const b = board([{ text: '**Pricing** {{red|rewrite}}' }]);
    expect(deriveTitle(b)).toBe('Pricing rewrite');
  });

  it('skips blank cards rather than naming a board after one', () => {
    const b = board([
      { text: '   ', createdAt: 10 },
      { text: 'Churn on the annual plan', createdAt: 20 },
    ]);
    expect(deriveTitle(b)).toBe('Churn on the annual plan');
  });

  it('truncates a long idea on a word boundary', () => {
    const long = 'A very long opening idea about pricing strategy for the enterprise tier';
    const title = deriveTitle(board([{ text: long }]));
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(49);
    expect(long.startsWith(title.slice(0, -1))).toBe(true);
    expect(title).not.toMatch(/ …$/);
  });

  it('collapses newlines so a name stays one line', () => {
    expect(deriveTitle(board([{ text: 'Pricing\n\npage' }]))).toBe('Pricing page');
  });

  it('has nothing to derive from an empty board', () => {
    expect(deriveTitle(emptyBoard('t'))).toBe('');
  });
});

describe('boardTitle', () => {
  it('lets an explicit name win over the derived one', () => {
    const b = board([{ text: 'Pricing page rewrite' }]);
    b.title = 'Q3 pricing';
    expect(boardTitle(b)).toBe('Q3 pricing');
  });

  it('hands the name back to the content when the field is cleared', () => {
    const b = board([{ text: 'Pricing page rewrite' }]);
    b.title = '   ';
    expect(boardTitle(b)).toBe('Pricing page rewrite');
  });

  it('calls a board with nothing in it untitled', () => {
    expect(boardTitle(emptyBoard('t'))).toBe(UNTITLED);
  });
});

describe('previewOf', () => {
  it('projects the whole graph into the unit box', () => {
    const b = board([
      { id: 'a', x: -900, y: -400 },
      { id: 'b', x: 700, y: 350 },
      { id: 'c', x: 0, y: 0 },
    ]);
    const thumb = previewOf(b);
    for (const n of thumb.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x + n.w).toBeLessThanOrEqual(1);
      expect(n.y + n.h).toBeLessThanOrEqual(1);
    }
  });

  it('keeps the layout in proportion instead of stretching it to fill', () => {
    // A wide board is wide. Squashing it into a square would destroy the very
    // thing the thumbnail exists to make recognizable.
    const b = board([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1600, y: 0 },
      { id: 'c', x: 800, y: 100 },
    ]);
    const { nodes } = previewOf(b);
    const spreadX = Math.max(...nodes.map((n) => n.x)) - Math.min(...nodes.map((n) => n.x));
    const spreadY = Math.max(...nodes.map((n) => n.y)) - Math.min(...nodes.map((n) => n.y));
    expect(spreadY).toBeLessThan(spreadX / 4);
  });

  it('survives a board with a single node', () => {
    const thumb = previewOf(board([{ id: 'only', x: 42, y: -7 }]));
    for (const n of thumb.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
      expect(Number.isFinite(n.w)).toBe(true);
    }
  });

  it('draws nothing for an empty board', () => {
    expect(previewOf(emptyBoard('t'))).toEqual({ nodes: [], edges: [] });
  });

  it('drops edges whose node fell outside the cap', () => {
    const b = board([
      { id: 'a', x: 0, y: 0, createdAt: 10 },
      { id: 'b', x: 400, y: 0, createdAt: 20 },
    ]);
    b.edges = [{ id: 'e1', from: 'a', to: 'b', layer: 'user' }];
    const thumb = previewOf(b, 1);
    expect(thumb.nodes).toHaveLength(1);
    expect(thumb.edges).toEqual([]);
  });
});

describe('summarize', () => {
  it('reports a name that is already resolved', () => {
    const b = board([{ text: 'Pricing page rewrite' }]);
    const s = summarize(b, { createdAt: 1, updatedAt: 2, archivedAt: null });
    expect(s.title).toBe('Pricing page rewrite');
    expect(s.nodeCount).toBe(1);
    expect(s.archivedAt).toBeNull();
  });
});

describe('relativeTime', () => {
  const now = 1_000_000_000;
  const min = 60_000;

  it('reads as just now inside the first minute', () => {
    expect(relativeTime(now - 20_000, now)).toBe('just now');
  });

  it('counts minutes, then hours, then days', () => {
    expect(relativeTime(now - 5 * min, now)).toBe('5m ago');
    expect(relativeTime(now - 3 * 60 * min, now)).toBe('3h ago');
    expect(relativeTime(now - 2 * 24 * 60 * min, now)).toBe('2d ago');
  });

  it('never reports a board as edited in the future', () => {
    expect(relativeTime(now + 60_000, now)).toBe('just now');
  });
});
