import { describe, expect, it } from 'vitest';
import { boardTitle } from './boards';
import {
  NODE_FONT_STEPS,
  NODE_MIN_H,
  NODE_MIN_W,
  OBJECTIVE_MAX,
  parseBoard,
} from './graph';
import { TUTORIAL_OBJECTIVE, TUTORIAL_TITLE, tutorialBoard } from './tutorial';

const roundTrip = (id: string) =>
  parseBoard(id, JSON.parse(JSON.stringify(tutorialBoard(id))));

describe('tutorialBoard', () => {
  it('names itself explicitly rather than deriving a title', () => {
    const board = tutorialBoard('b1');
    expect(board.title).toBe(TUTORIAL_TITLE);
    expect(boardTitle(board)).toBe(TUTORIAL_TITLE);
  });

  it('carries an objective, so ⌘. is live on it from the first second', () => {
    const board = tutorialBoard('b1');
    expect(board.objective).toBe(TUTORIAL_OBJECTIVE);
    expect(board.objective.trim().length).toBeGreaterThan(0);
    expect(board.objective.length).toBeLessThanOrEqual(OBJECTIVE_MAX);
  });

  it('is not private — the ghost arriving here is the demonstration', () => {
    expect(tutorialBoard('b1').privacy).toBe(false);
  });

  it('never seeds a proposal: nodes are only user or accepted', () => {
    const board = tutorialBoard('b1');
    expect(board.nodes.every((n) => n.layer === 'user' || n.layer === 'accepted')).toBe(true);
    // …and exactly one card demonstrates the third layer.
    expect(board.nodes.filter((n) => n.layer === 'accepted')).toHaveLength(1);
  });

  it('has no dangling edges — parseBoard drops those silently', () => {
    const board = tutorialBoard('b1');
    const ids = new Set(board.nodes.map((n) => n.id));
    for (const e of board.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
      expect(e.from).not.toBe(e.to);
    }
  });

  it('leaves exactly one card unconnected, for the connect lesson', () => {
    const board = tutorialBoard('b1');
    const linked = new Set(board.edges.flatMap((e) => [e.from, e.to]));
    expect(board.nodes.filter((n) => !linked.has(n.id))).toHaveLength(1);
  });

  it('survives a save/load round-trip unchanged', () => {
    const board = tutorialBoard('b1');
    const loaded = roundTrip('b1');
    expect(loaded.nodes).toHaveLength(board.nodes.length);
    expect(loaded.edges).toHaveLength(board.edges.length);
    expect(loaded.title).toBe(board.title);
    expect(loaded.objective).toBe(board.objective);
    expect(loaded.privacy).toBe(false);
    expect(loaded.nodes.filter((n) => n.layer === 'accepted')).toHaveLength(1);
    expect(loaded.nodes.filter((n) => n.done)).toHaveLength(
      board.nodes.filter((n) => n.done).length,
    );
    // Text is the whole payload here; a snapped size or coerced layer would
    // survive silently, but altered copy must not.
    expect(loaded.nodes.map((n) => n.text)).toEqual(board.nodes.map((n) => n.text));
  });

  it('sizes every card on the font ladder, so nothing snaps on load', () => {
    for (const n of tutorialBoard('b1').nodes) {
      expect(NODE_FONT_STEPS).toContain(n.fontSize as (typeof NODE_FONT_STEPS)[number]);
    }
  });

  it('ships the resize lesson too small to read, which is the lesson', () => {
    const board = tutorialBoard('b1');
    const smallest = [...board.nodes].sort((a, b) => a.w * a.h - b.w * b.h)[0];
    expect(smallest.w).toBeGreaterThanOrEqual(NODE_MIN_W);
    expect(smallest.h).toBeGreaterThanOrEqual(NODE_MIN_H);
    expect(smallest.w).toBeLessThan(NODE_MIN_W * 1.3);
    expect(smallest.h).toBeLessThan(NODE_MIN_H * 1.3);
    // Far more text than a card that size can show.
    expect(smallest.text.length).toBeGreaterThan(80);
  });

  it('shares no ids between two copies, so both can coexist', () => {
    const a = tutorialBoard('b1');
    const b = tutorialBoard('b2');
    const ids = new Set([...a.nodes.map((n) => n.id), ...a.edges.map((e) => e.id)]);
    for (const id of [...b.nodes.map((n) => n.id), ...b.edges.map((e) => e.id)]) {
      expect(ids.has(id)).toBe(false);
    }
  });

  it('orders createdAt in reading order, so the minimap reads the same way', () => {
    const stamps = tutorialBoard('b1').nodes.map((n) => n.createdAt);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
  });
});
