import { describe, expect, it } from 'vitest';
import {
  clampSize,
  createNode,
  emptyBoard,
  NODE_MIN_H,
  NODE_MIN_W,
  OBJECTIVE_MAX,
  parseBoard,
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
