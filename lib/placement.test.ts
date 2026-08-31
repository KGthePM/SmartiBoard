import { describe, expect, it } from 'vitest';
import { NODE_H, NODE_W, createNode, emptyBoard, intersects, rectOf, type Board } from './graph';
import { placeProposal } from './placement';
import { viewRect } from './collapse';

function boardWith(nodes: { id: string; x: number; y: number }[]): Board {
  const b = emptyBoard('t');
  b.nodes = nodes.map((n) => createNode({ id: n.id, x: n.x, y: n.y, text: n.id }));
  return b;
}

const ghost = (p: { x: number; y: number }) => ({ ...p, w: NODE_W, h: NODE_H });

describe('placeProposal', () => {
  it('never overlaps an existing node', () => {
    const board = boardWith([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 220, y: 0 },
      { id: 'c', x: 0, y: 120 },
      { id: 'd', x: 220, y: 120 },
    ]);

    const p = placeProposal(board, ['a', 'b']);
    for (const n of board.nodes) {
      expect(intersects(ghost(p), rectOf(n))).toBe(false);
    }
  });

  it('stays clear on a densely packed board', () => {
    const nodes = [];
    for (let row = 0; row < 6; row += 1) {
      for (let col = 0; col < 6; col += 1) {
        nodes.push({ id: `n${row}-${col}`, x: col * 210, y: row * 106 });
      }
    }
    const board = boardWith(nodes);

    const p = placeProposal(board, ['n2-2', 'n3-3']);
    for (const n of board.nodes) {
      expect(intersects(ghost(p), rectOf(n))).toBe(false);
    }
  });

  it('lands near its anchors rather than near unrelated nodes', () => {
    const board = boardWith([
      { id: 'near1', x: 0, y: 0 },
      { id: 'near2', x: 0, y: 200 },
      { id: 'far', x: 4000, y: 4000 },
    ]);

    const p = placeProposal(board, ['near1', 'near2']);
    const distToAnchors = Math.hypot(p.x - 0, p.y - 100);
    const distToFar = Math.hypot(p.x - 4000, p.y - 4000);
    expect(distToAnchors).toBeLessThan(distToFar);
  });

  it('centers on the origin for an empty board', () => {
    // Coordinates are the card's top-left, so a card centered on (0,0)
    // sits at (-w/2, -h/2).
    expect(placeProposal(emptyBoard('t'), [])).toEqual({ x: -NODE_W / 2, y: -NODE_H / 2 });
  });

  it('stays inside the viewport when one is given', () => {
    // Regression: placement used to be viewport-blind and would happily park a
    // ghost above the visible area, where it is not a subtle suggestion but an
    // invisible one — and the one-live-proposal ceiling then blocks the next.
    const board = boardWith([
      { id: 'a', x: 300, y: 60 },
      { id: 'b', x: 300, y: 220 },
    ]);
    const visible = { x: 0, y: 0, w: 1000, h: 620 };

    const p = placeProposal(board, ['a', 'b'], undefined, visible);
    expect(p.x).toBeGreaterThanOrEqual(visible.x);
    expect(p.y).toBeGreaterThanOrEqual(visible.y);
    expect(p.x + NODE_W).toBeLessThanOrEqual(visible.x + visible.w);
    expect(p.y + NODE_H).toBeLessThanOrEqual(visible.y + visible.h);
    for (const n of board.nodes) {
      expect(intersects(ghost(p), rectOf(n))).toBe(false);
    }
  });

  it('prefers a clear off-screen spot over overlapping user content', () => {
    // Visibility outranks proximity, but never outranks not-occluding.
    const board = boardWith([{ id: 'a', x: 0, y: 0 }]);
    // A viewport with no room at all for a card.
    const cramped = { x: 0, y: 0, w: 40, h: 40 };

    const p = placeProposal(board, ['a'], undefined, cramped);
    expect(intersects(ghost(p), rectOf(board.nodes[0]))).toBe(false);
  });

  it('ignores anchor ids that no longer exist', () => {
    const board = boardWith([{ id: 'a', x: 500, y: 500 }]);
    const p = placeProposal(board, ['deleted-node']);
    expect(intersects(ghost(p), rectOf(board.nodes[0]))).toBe(false);
  });
});

describe('placeProposal with folded cards', () => {
  it('treats a folded card as the stub it draws, not the box it stores', () => {
    // A ghost that detoured around space the person can plainly see is empty
    // would read as a bug in the placement, not as a policy about `done`.
    const board = boardWith([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 0, y: 120 },
    ]);
    // Both folds, since a dot gives up its width as well as its height and the
    // placement has to believe that too.
    for (const view of ['line', 'dot'] as const) {
      const folded = (n: { x: number; y: number; w: number; h: number }) => viewRect(n, view);
      const p = placeProposal(board, ['a'], undefined, undefined, folded);
      for (const n of board.nodes) {
        expect(intersects(ghost(p), folded(n))).toBe(false);
      }
    }
  });

  it('defaults to the node’s own box, so every existing caller is unchanged', () => {
    const board = boardWith([{ id: 'a', x: 0, y: 0 }]);
    expect(placeProposal(board, ['a'])).toEqual(placeProposal(board, ['a'], undefined, undefined, rectOf));
  });
});
