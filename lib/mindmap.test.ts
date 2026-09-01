import { describe, expect, it } from 'vitest';
import { boardTitle } from './boards';
import { NODE_FONT_STEPS, NODE_MIN_H, NODE_MIN_W, OBJECTIVE_MAX, parseBoard } from './graph';
import { MINDMAP_OBJECTIVE, MINDMAP_TITLE, mindMapBoard } from './mindmap';

const roundTrip = (id: string) => parseBoard(id, JSON.parse(JSON.stringify(mindMapBoard(id))));

describe('mindMapBoard', () => {
  it('names itself explicitly rather than deriving a title', () => {
    const board = mindMapBoard('b1');
    expect(board.title).toBe(MINDMAP_TITLE);
    expect(boardTitle(board)).toBe(MINDMAP_TITLE);
  });

  it('carries an objective, so ⌘. is live on it from the first second', () => {
    const board = mindMapBoard('b1');
    expect(board.objective).toBe(MINDMAP_OBJECTIVE);
    expect(board.objective.trim().length).toBeGreaterThan(0);
    expect(board.objective.length).toBeLessThanOrEqual(OBJECTIVE_MAX);
  });

  it('is not private, like the tutorial and the Kanban', () => {
    expect(mindMapBoard('b1').privacy).toBe(false);
  });

  it('is ordinary content: every node is the user’s, and none is a proposal', () => {
    expect(mindMapBoard('b1').nodes.every((n) => n.layer === 'user')).toBe(true);
  });

  it('is a tree: one root, every other node parented exactly once', () => {
    // n−1 edges, a single root and exactly one parent each is the definition
    // that keeps it connected and acyclic — a mind map, not a pile of spokes.
    const board = mindMapBoard('b1');
    expect(board.edges).toHaveLength(board.nodes.length - 1);
    const roots = board.nodes.filter((n) => !board.edges.some((e) => e.to === n.id));
    expect(roots).toHaveLength(1);
    for (const n of board.nodes) {
      const parents = board.edges.filter((e) => e.to === n.id);
      if (n.id === roots[0].id) {
        expect(parents).toHaveLength(0);
      } else {
        expect(parents).toHaveLength(1);
      }
    }
  });

  it('roots the tree at the hub, which branches at least four ways', () => {
    const board = mindMapBoard('b1');
    const hub = board.nodes.find((n) => !board.edges.some((e) => e.to === n.id))!;
    const children = board.edges.filter((e) => e.from === hub.id);
    expect(children.length).toBeGreaterThanOrEqual(4);
  });

  it('ships a second ring — a branch with a child of its own', () => {
    // A mind map that stops at one ring is a list. The child is the
    // connect-dot lesson, so its presence is structure the test pins.
    const board = mindMapBoard('b1');
    const parented = new Set(board.edges.map((e) => e.to));
    const grandchildEdges = board.edges.filter((e) => parented.has(e.from));
    expect(grandchildEdges.length).toBeGreaterThanOrEqual(1);
  });

  it('ships no done cards — nothing on a fresh map is finished', () => {
    expect(mindMapBoard('b1').nodes.some((n) => n.done)).toBe(false);
  });

  it('has no dangling edges — parseBoard drops those silently', () => {
    const board = mindMapBoard('b1');
    const ids = new Set(board.nodes.map((n) => n.id));
    for (const e of board.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
      expect(e.from).not.toBe(e.to);
    }
  });

  it('survives a save/load round-trip unchanged', () => {
    const board = mindMapBoard('b1');
    const loaded = roundTrip('b1');
    expect(loaded.nodes).toHaveLength(board.nodes.length);
    expect(loaded.edges).toHaveLength(board.edges.length);
    expect(loaded.title).toBe(board.title);
    expect(loaded.objective).toBe(board.objective);
    expect(loaded.privacy).toBe(false);
    expect(loaded.nodes.map((n) => n.text)).toEqual(board.nodes.map((n) => n.text));
  });

  it('sizes every card on the font ladder, so nothing snaps on load', () => {
    for (const n of mindMapBoard('b1').nodes) {
      expect(NODE_FONT_STEPS).toContain(n.fontSize as (typeof NODE_FONT_STEPS)[number]);
    }
  });

  it('keeps every card above the size floor — nothing here is a lesson in resizing', () => {
    for (const n of mindMapBoard('b1').nodes) {
      expect(n.w).toBeGreaterThanOrEqual(NODE_MIN_W);
      expect(n.h).toBeGreaterThanOrEqual(NODE_MIN_H);
    }
  });

  it('shares no ids between two copies, so both can coexist', () => {
    const a = mindMapBoard('b1');
    const b = mindMapBoard('b2');
    const ids = new Set([...a.nodes.map((n) => n.id), ...a.edges.map((e) => e.id)]);
    for (const id of [...b.nodes.map((n) => n.id), ...b.edges.map((e) => e.id)]) {
      expect(ids.has(id)).toBe(false);
    }
  });

  it('orders createdAt in reading order, so the minimap reads the same way', () => {
    const stamps = mindMapBoard('b1').nodes.map((n) => n.createdAt);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
  });
});
