import { describe, expect, it } from 'vitest';
import { boardTitle } from './boards';
import { NODE_FONT_STEPS, NODE_MIN_H, NODE_MIN_W, OBJECTIVE_MAX, parseBoard } from './graph';
import { KANBAN_OBJECTIVE, KANBAN_TITLE, kanbanBoard } from './kanban';

const roundTrip = (id: string) => parseBoard(id, JSON.parse(JSON.stringify(kanbanBoard(id))));

describe('kanbanBoard', () => {
  it('names itself explicitly rather than deriving a title', () => {
    const board = kanbanBoard('b1');
    expect(board.title).toBe(KANBAN_TITLE);
    expect(boardTitle(board)).toBe(KANBAN_TITLE);
  });

  it('carries an objective, so ⌘. is live on it from the first second', () => {
    // The point of shipping one: a fresh Kanban board has too few cards for
    // the ghost's floor, and the objective is what satisfies the generator's.
    const board = kanbanBoard('b1');
    expect(board.objective).toBe(KANBAN_OBJECTIVE);
    expect(board.objective.trim().length).toBeGreaterThan(0);
    expect(board.objective.length).toBeLessThanOrEqual(OBJECTIVE_MAX);
  });

  it('is not private, like the tutorial', () => {
    expect(kanbanBoard('b1').privacy).toBe(false);
  });

  it('is ordinary content: every node is the user’s, and none is a proposal', () => {
    // No accepted card and no ghost — a template is a board somebody could
    // have typed, and a proposal is never a node.
    expect(kanbanBoard('b1').nodes.every((n) => n.layer === 'user')).toBe(true);
  });

  it('lays four columns out at four x positions, each with a header', () => {
    const board = kanbanBoard('b1');
    const columns = new Set(board.nodes.map((n) => n.x));
    expect(columns.size).toBe(4);

    // A header is a node like any other; what makes it one is that it sits at
    // the top of its column and everything below it points back to it.
    const heads = board.nodes.filter((n) => board.edges.some((e) => e.from === n.id));
    expect(heads).toHaveLength(4);
    expect(heads.map((n) => n.x).sort((a, b) => a - b)).toEqual([0, 300, 600, 900]);
  });

  it('gives every card an edge to its own column header, and no other', () => {
    // The one piece of structure a Kanban has. An edgeless board would render
    // as a blank minimap and read to the model as unrelated sentences.
    const board = kanbanBoard('b1');
    const byId = new Map(board.nodes.map((n) => [n.id, n]));
    for (const e of board.edges) {
      expect(byId.get(e.from)!.x).toBe(byId.get(e.to)!.x);
      expect(byId.get(e.from)!.y).toBeLessThan(byId.get(e.to)!.y);
    }
    const linked = new Set(board.edges.flatMap((e) => [e.from, e.to]));
    expect(board.nodes.filter((n) => !linked.has(n.id))).toHaveLength(0);
  });

  it('crosses off exactly the one card in the Done column, and no other', () => {
    // The columns and the ✓ are independent: a position never sets `done`, so
    // the template can only demonstrate the mark, not imply a rule.
    const board = kanbanBoard('b1');
    const done = board.nodes.filter((n) => n.done);
    expect(done).toHaveLength(1);
    expect(done[0].x).toBe(900);
  });

  it('has no dangling edges — parseBoard drops those silently', () => {
    const board = kanbanBoard('b1');
    const ids = new Set(board.nodes.map((n) => n.id));
    for (const e of board.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
      expect(e.from).not.toBe(e.to);
    }
  });

  it('survives a save/load round-trip unchanged', () => {
    const board = kanbanBoard('b1');
    const loaded = roundTrip('b1');
    expect(loaded.nodes).toHaveLength(board.nodes.length);
    expect(loaded.edges).toHaveLength(board.edges.length);
    expect(loaded.title).toBe(board.title);
    expect(loaded.objective).toBe(board.objective);
    expect(loaded.privacy).toBe(false);
    expect(loaded.nodes.filter((n) => n.done)).toHaveLength(1);
    expect(loaded.nodes.map((n) => n.text)).toEqual(board.nodes.map((n) => n.text));
  });

  it('sizes every card on the font ladder, so nothing snaps on load', () => {
    for (const n of kanbanBoard('b1').nodes) {
      expect(NODE_FONT_STEPS).toContain(n.fontSize as (typeof NODE_FONT_STEPS)[number]);
    }
  });

  it('keeps every card above the size floor — nothing here is a lesson in resizing', () => {
    for (const n of kanbanBoard('b1').nodes) {
      expect(n.w).toBeGreaterThanOrEqual(NODE_MIN_W);
      expect(n.h).toBeGreaterThanOrEqual(NODE_MIN_H);
    }
  });

  it('shares no ids between two copies, so both can coexist', () => {
    const a = kanbanBoard('b1');
    const b = kanbanBoard('b2');
    const ids = new Set([...a.nodes.map((n) => n.id), ...a.edges.map((e) => e.id)]);
    for (const id of [...b.nodes.map((n) => n.id), ...b.edges.map((e) => e.id)]) {
      expect(ids.has(id)).toBe(false);
    }
  });

  it('orders createdAt in reading order, so the minimap reads the same way', () => {
    const stamps = kanbanBoard('b1').nodes.map((n) => n.createdAt);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
  });
});
