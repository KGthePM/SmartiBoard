import { describe, expect, it } from 'vitest';
import { boardTitle } from './boards';
import { NODE_FONT_STEPS, NODE_MIN_H, NODE_MIN_W, OBJECTIVE_MAX, parseBoard } from './graph';
import { SWOT_OBJECTIVE, SWOT_TITLE, swotBoard } from './swot';

const roundTrip = (id: string) => parseBoard(id, JSON.parse(JSON.stringify(swotBoard(id))));

describe('swotBoard', () => {
  it('names itself explicitly rather than deriving a title', () => {
    const board = swotBoard('b1');
    expect(board.title).toBe(SWOT_TITLE);
    expect(boardTitle(board)).toBe(SWOT_TITLE);
  });

  it('carries an objective, so ⌘. is live on it from the first second', () => {
    // A half-filled SWOT is exactly the board worth asking for candidates on,
    // and the objective is what makes the generator legal before that.
    const board = swotBoard('b1');
    expect(board.objective).toBe(SWOT_OBJECTIVE);
    expect(board.objective.trim().length).toBeGreaterThan(0);
    expect(board.objective.length).toBeLessThanOrEqual(OBJECTIVE_MAX);
  });

  it('is not private, like the tutorial and the Kanban', () => {
    expect(swotBoard('b1').privacy).toBe(false);
  });

  it('is ordinary content: every node is the user’s, and none is a proposal', () => {
    expect(swotBoard('b1').nodes.every((n) => n.layer === 'user')).toBe(true);
  });

  it('lays four quadrants at four corners, each with a header', () => {
    const board = swotBoard('b1');
    // A header is a node like any other; what makes it one is that it sits at
    // the top of its quadrant and everything below it points back to it.
    const heads = board.nodes.filter((n) => board.edges.some((e) => e.from === n.id));
    expect(heads).toHaveLength(4);
    const corners = heads.map((n) => [n.x, n.y]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    expect(corners).toEqual([
      [0, 0],
      [0, 400],
      [340, 0],
      [340, 400],
    ]);
  });

  it('points every card at its own quadrant’s header, and no other', () => {
    // The one piece of structure a quadrant has. The nearest header above a
    // card in its column must be the one it is wired to — an edge to another
    // quadrant's header would sort a card by wire rather than by person.
    const board = swotBoard('b1');
    const byId = new Map(board.nodes.map((n) => [n.id, n]));
    const heads = board.nodes.filter((n) => board.edges.some((e) => e.from === n.id));
    for (const e of board.edges) {
      const from = byId.get(e.from)!;
      const to = byId.get(e.to)!;
      expect(from.x).toBe(to.x);
      expect(from.y).toBeLessThan(to.y);
      const nearest = heads
        .filter((h) => h.x === to.x && h.y < to.y)
        .reduce((a, b) => (b.y > a.y ? b : a));
      expect(nearest.id).toBe(from.id);
    }
    const linked = new Set(board.edges.flatMap((e) => [e.from, e.to]));
    expect(board.nodes.filter((n) => !linked.has(n.id))).toHaveLength(0);
  });

  it('ships no done cards — nothing in a SWOT is finished', () => {
    // Unlike the Kanban, which demonstrates the ✓: two demos exist already,
    // and crossing off a strength would imply a rule the board does not have.
    expect(swotBoard('b1').nodes.some((n) => n.done)).toBe(false);
  });

  it('has no dangling edges — parseBoard drops those silently', () => {
    const board = swotBoard('b1');
    const ids = new Set(board.nodes.map((n) => n.id));
    for (const e of board.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
      expect(e.from).not.toBe(e.to);
    }
  });

  it('survives a save/load round-trip unchanged', () => {
    const board = swotBoard('b1');
    const loaded = roundTrip('b1');
    expect(loaded.nodes).toHaveLength(board.nodes.length);
    expect(loaded.edges).toHaveLength(board.edges.length);
    expect(loaded.title).toBe(board.title);
    expect(loaded.objective).toBe(board.objective);
    expect(loaded.privacy).toBe(false);
    expect(loaded.nodes.map((n) => n.text)).toEqual(board.nodes.map((n) => n.text));
  });

  it('sizes every card on the font ladder, so nothing snaps on load', () => {
    for (const n of swotBoard('b1').nodes) {
      expect(NODE_FONT_STEPS).toContain(n.fontSize as (typeof NODE_FONT_STEPS)[number]);
    }
  });

  it('keeps every card above the size floor — nothing here is a lesson in resizing', () => {
    for (const n of swotBoard('b1').nodes) {
      expect(n.w).toBeGreaterThanOrEqual(NODE_MIN_W);
      expect(n.h).toBeGreaterThanOrEqual(NODE_MIN_H);
    }
  });

  it('shares no ids between two copies, so both can coexist', () => {
    const a = swotBoard('b1');
    const b = swotBoard('b2');
    const ids = new Set([...a.nodes.map((n) => n.id), ...a.edges.map((e) => e.id)]);
    for (const id of [...b.nodes.map((n) => n.id), ...b.edges.map((e) => e.id)]) {
      expect(ids.has(id)).toBe(false);
    }
  });

  it('orders createdAt in reading order, so the minimap reads the same way', () => {
    const stamps = swotBoard('b1').nodes.map((n) => n.createdAt);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
  });
});
