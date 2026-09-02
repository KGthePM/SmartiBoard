import { describe, expect, it } from 'vitest';
import { applyOps, diffBoards, type Op } from './sync';
import {
  createNode,
  emptyBoard,
  NODE_FONT_STEPS,
  stepFontSize,
  type Board,
  type Edge,
  type IdeaNode,
} from './graph';
import { tutorialBoard } from './tutorial';
import { kanbanBoard } from './kanban';

/** `updatedAt` is fixed here because it is the server's stamp, never diffed. */
function board(nodes: IdeaNode[] = [], edges: Edge[] = []): Board {
  return { ...emptyBoard('b1'), nodes, edges, updatedAt: 1000 };
}

function node(id: string, over: Partial<IdeaNode> = {}): IdeaNode {
  return createNode({ id, x: 0, y: 0, createdAt: 1000, ...over });
}

function edge(id: string, from: string, to: string): Edge {
  return { id, from, to, layer: 'user' };
}

/** A change is one op, and applying it lands exactly the board we diffed to. */
function expectSingleRoundTrip(prev: Board, next: Board, t: Op['t']): Op[] {
  const ops = diffBoards(prev, next);
  expect(ops).toHaveLength(1);
  expect(ops[0].t).toBe(t);
  expect(applyOps(prev, ops)).toEqual(next);
  return ops;
}

describe('diffBoards', () => {
  it('says nothing about a board nobody touched', () => {
    const b = board([node('n1', { text: 'a' })], []);
    expect(diffBoards(b, b)).toEqual([]);
    expect(diffBoards(b, structuredClone(b))).toEqual([]);
  });

  it('is one op per per-card mutation, whichever field moved', () => {
    const before = board([node('n1', { text: 'a' }), node('n2', { text: 'b', x: 400 })]);
    const at = (i: number, over: Partial<IdeaNode>): Board => ({
      ...before,
      nodes: before.nodes.map((n, j) => (j === i ? { ...n, ...over } : n)),
    });

    expectSingleRoundTrip(before, at(0, { text: 'a!' }), 'node.put');
    expectSingleRoundTrip(before, at(0, { x: 120, y: 60 }), 'node.put');
    expectSingleRoundTrip(before, at(0, { w: 320, h: 200 }), 'node.put');
    expectSingleRoundTrip(before, at(0, { fontSize: stepFontSize(before.nodes[0].fontSize, 1) }), 'node.put');
    expectSingleRoundTrip(before, at(0, { done: true }), 'node.put');
    expectSingleRoundTrip(before, at(0, { reactions: ['fire'] }), 'node.put');
    expectSingleRoundTrip(before, at(0, { layer: 'accepted' }), 'node.put');
  });

  it('carries only the board fields that changed, and no node ops', () => {
    const before = board([node('n1')]);
    const ops = expectSingleRoundTrip(before, { ...before, title: 'Launch' }, 'board.set');
    expect(ops[0]).toEqual({ t: 'board.set', title: 'Launch' });

    const both = diffBoards(before, { ...before, objective: 'why', privacy: true });
    expect(both).toEqual([{ t: 'board.set', objective: 'why', privacy: true }]);
  });

  it('never diffs the row key or the server stamp', () => {
    const before = board([node('n1')]);
    expect(diffBoards(before, { ...before, id: 'other', updatedAt: 999 })).toEqual([]);
  });

  it('adds, deletes and reconnects', () => {
    const one = board([node('n1')]);
    const two = board([node('n1'), node('n2', { x: 400 })]);
    expectSingleRoundTrip(one, two, 'node.put');
    expectSingleRoundTrip(two, one, 'node.del');

    const linked = board(two.nodes, [edge('e1', 'n1', 'n2')]);
    expectSingleRoundTrip(two, linked, 'edge.add');
    expectSingleRoundTrip(linked, two, 'edge.del');
  });

  it('round-trips whole real boards, in both directions', () => {
    const cases: Board[] = [
      emptyBoard('b1'),
      { ...tutorialBoard('b1') },
      { ...kanbanBoard('b1') },
    ];
    for (const from of cases) {
      for (const to of cases) {
        // updatedAt is the server's, so the diff cannot carry it; everything
        // else must survive the trip.
        const landed = applyOps(from, diffBoards(from, to));
        expect({ ...landed, updatedAt: 0 }).toEqual({ ...to, id: from.id, updatedAt: 0 });
      }
    }
  });
});

describe('applyOps is idempotent', () => {
  it('leaves the board unchanged when any batch lands twice', () => {
    const prev = board([node('n1', { text: 'a' }), node('n2', { x: 400 })], [edge('e1', 'n1', 'n2')]);
    const next = board(
      [node('n1', { text: 'edited' }), node('n3', { x: 800 })],
      [edge('e1', 'n1', 'n3'), edge('e2', 'n3', 'n1')],
    );
    const ops = diffBoards(prev, next);
    const once = applyOps(prev, ops);
    expect(applyOps(once, ops)).toEqual(once);
    // The one op that is not idempotent for free: a re-sent edge.add must
    // upsert, not double the line.
    expect(once.edges).toHaveLength(2);
  });

  it('upserts an edge by id rather than appending it', () => {
    const b = board([node('n1'), node('n2', { x: 400 })], [edge('e1', 'n1', 'n2')]);
    const twice = applyOps(applyOps(b, [{ t: 'edge.add', edge: edge('e1', 'n1', 'n2') }]), [
      { t: 'edge.add', edge: edge('e1', 'n1', 'n2') },
    ]);
    expect(twice.edges).toEqual([edge('e1', 'n1', 'n2')]);
  });
});

describe('applyOps is total and tolerant', () => {
  const base = board([node('n1'), node('n2', { x: 400 })], [edge('e1', 'n1', 'n2')]);
  const good: Op = { t: 'node.put', node: node('n3', { x: 800, text: 'kept' }) };

  it('drops the bad op and lands the rest of the batch', () => {
    const junk: unknown[] = [
      { t: 'nope', whatever: 1 },
      { t: 'node.put', node: { id: 'x' } },
      { t: 'node.put', node: { id: 'x', x: 'left', y: 0 } },
      { t: 'node.put', node: { id: 'x', x: Number.NaN, y: 0 } },
      { t: 'node.put', node: null },
      { t: 'node.del', id: 'gone' },
      { t: 'node.del' },
      { t: 'edge.add', edge: { id: 'e9', from: 'n1', to: 'ghost' } },
      { t: 'edge.add', edge: { id: 'e9', from: 'n1' } },
      { t: 'edge.del', id: 'gone' },
      { t: 'board.set', title: 42 },
      null,
      'nonsense',
      7,
    ];
    for (const bad of junk) {
      const landed = applyOps(base, [bad, good]);
      expect(landed.nodes.map((n) => n.id)).toEqual(['n1', 'n2', 'n3']);
      expect(landed.edges).toEqual(base.edges);
      expect(landed.title).toBe('');
    }
  });

  it('never throws on a batch that is not a batch', () => {
    for (const ops of [null, undefined, 'x', 7, {}, { length: 2 }]) {
      expect(applyOps(base, ops)).toEqual(base);
    }
  });

  it('guards a synced node exactly as parseBoard does', () => {
    const landed = applyOps(base, [
      {
        t: 'node.put',
        node: { id: 'n4', x: 0, y: 0, fontSize: 999, reactions: ['fire', 'fire', 'nope'] },
      },
    ]);
    const n4 = landed.nodes.find((n) => n.id === 'n4')!;
    expect(NODE_FONT_STEPS).toContain(n4.fontSize);
    expect(n4.reactions).toEqual(['fire']);
  });

  it('clamps the board fields it is given', () => {
    const landed = applyOps(base, [
      { t: 'board.set', title: 'T'.repeat(500), objective: 'O'.repeat(900), privacy: true },
    ]);
    expect(landed.title).toHaveLength(120);
    expect(landed.objective).toHaveLength(400);
    expect(landed.privacy).toBe(true);
  });

  it('does not mutate the board it was given', () => {
    const before = structuredClone(base);
    applyOps(base, diffBoards(base, board([node('n1', { text: 'x' })])));
    expect(base).toEqual(before);
  });
});

describe('the merge, which is the whole point', () => {
  const ancestor = board(
    [node('n1', { text: 'one' }), node('n2', { text: 'two', x: 400 })],
    [edge('e1', 'n1', 'n2')],
  );

  it('lets two people on different cards both win', () => {
    const alice = { ...ancestor, nodes: ancestor.nodes.map((n) => (n.id === 'n1' ? { ...n, text: 'ALICE' } : n)) };
    const bob = { ...ancestor, nodes: ancestor.nodes.map((n) => (n.id === 'n2' ? { ...n, text: 'BOB' } : n)) };

    // Each diffs against the ancestor it last acked — which is why neither
    // batch carries the other's card at all.
    const merged = applyOps(applyOps(ancestor, diffBoards(ancestor, alice)), diffBoards(ancestor, bob));
    expect(merged.nodes.map((n) => n.text)).toEqual(['ALICE', 'BOB']);
  });

  it('resolves two people on the same card last-write-wins, and only that card', () => {
    const alice = { ...ancestor, nodes: ancestor.nodes.map((n) => (n.id === 'n1' ? { ...n, text: 'ALICE' } : n)) };
    const bob = {
      ...ancestor,
      nodes: ancestor.nodes.map((n) => (n.id === 'n1' ? { ...n, text: 'BOB' } : n)),
    };
    const merged = applyOps(applyOps(ancestor, diffBoards(ancestor, alice)), diffBoards(ancestor, bob));
    expect(merged.nodes.find((n) => n.id === 'n1')!.text).toBe('BOB');
    expect(merged.nodes.find((n) => n.id === 'n2')).toEqual(ancestor.nodes[1]);
    expect(merged.edges).toEqual(ancestor.edges);
  });

  it('does not resurrect a card the other person deleted', () => {
    // Bob's tab still holds n2 on screen, but he never touched it, so his diff
    // is silent about it and Alice's delete stands. This is the bug fixed.
    const alice = board([ancestor.nodes[0]], []);
    const bob = { ...ancestor, nodes: ancestor.nodes.map((n) => (n.id === 'n1' ? { ...n, text: 'BOB' } : n)) };
    const merged = applyOps(applyOps(ancestor, diffBoards(ancestor, alice)), diffBoards(ancestor, bob));
    expect(merged.nodes.map((n) => n.id)).toEqual(['n1']);
    expect(merged.nodes[0].text).toBe('BOB');
  });

  it('takes a deleted card edges with it', () => {
    const merged = applyOps(ancestor, [{ t: 'node.del', id: 'n2' }]);
    expect(merged.nodes.map((n) => n.id)).toEqual(['n1']);
    expect(merged.edges).toEqual([]);
  });
});
