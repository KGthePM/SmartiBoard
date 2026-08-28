import { describe, expect, it, vi } from 'vitest';
import { createNode, edgePair, emptyBoard } from './graph';
import { rejectedFor, useBoard } from './store';
import type { ProposalDraft } from './proposal';

/**
 * The store is a module singleton, so every test starts by pointing it at a
 * board id of its own — which is also the action under test. Board ids are
 * unique per test because dismissals are deliberately remembered across a
 * switch and must not leak between cases.
 */
const s = () => useBoard.getState();

/** Open a board the way the canvas does: park the session, then hydrate. */
function open(id: string) {
  s().beginLoad(id);
  s().hydrate(emptyBoard(id));
}

const draft: ProposalDraft = {
  kind: 'gap_fill',
  text: 'What does churn cost us?',
  anchors: [],
  rationale: 'The board prices the plan but never counts the losses.',
};

describe('beginLoad', () => {
  it('leaves one board’s undo history behind when opening another', () => {
    // Otherwise ⌘Z on the new board restores a snapshot of the old one, and
    // autosave then writes that content under the new board's id.
    open('undo-a');
    s().addNode(0, 0);
    expect(s().undoStack).toHaveLength(1);

    open('undo-b');
    expect(s().undoStack).toEqual([]);

    s().undo();
    expect(s().board.id).toBe('undo-b');
    expect(s().board.nodes).toEqual([]);
  });

  it('does not let a live ghost follow you to another board', () => {
    open('ghost-a');
    s().receiveProposal(draft);
    expect(s().proposal).not.toBeNull();

    open('ghost-b');
    expect(s().proposal).toBeNull();
  });

  it('forgets the fingerprint so the next board is not mistaken for no change', () => {
    open('fp-a');
    s().markRequested('some-hash');
    open('fp-b');
    expect(s().lastRequestedFingerprint).toBeNull();
  });

  it('reports the board as unloaded until its content arrives', () => {
    open('load-a');
    s().beginLoad('load-b');
    expect(s().loaded).toBe(false);
    expect(s().board.id).toBe('load-b');
  });
});

describe('hydrate', () => {
  it('ignores a response for a board the session has already left', () => {
    open('stale-a');
    s().beginLoad('stale-b');

    const late = emptyBoard('stale-a');
    late.nodes = [createNode({ x: 0, y: 0, text: 'from the board we left' })];
    s().hydrate(late);

    expect(s().board.id).toBe('stale-b');
    expect(s().board.nodes).toEqual([]);
    expect(s().loaded).toBe(false);
  });
});

describe('dismissProposal', () => {
  it('keeps a dismissal on the board it happened on', () => {
    open('rej-a');
    s().receiveProposal(draft);
    s().dismissProposal();
    expect(rejectedFor(s())).toEqual([draft.text]);

    open('rej-b');
    expect(rejectedFor(s())).toEqual([]);
  });

  it('still remembers it when you come back', () => {
    open('rej-c');
    s().receiveProposal(draft);
    s().dismissProposal();

    open('rej-d');
    open('rej-c');
    expect(rejectedFor(s())).toEqual([draft.text]);
  });
});

describe('setTitle', () => {
  it('coalesces a rename into a single undo step', () => {
    open('title-a');
    for (const t of ['Q', 'Q3', 'Q3 ', 'Q3 pricing']) s().setTitle(t);
    expect(s().board.title).toBe('Q3 pricing');
    expect(s().undoStack).toHaveLength(1);

    s().undo();
    expect(s().board.title).toBe('');
  });

  it('does not count as thinking, so it never spends a token', () => {
    // Naming the board renames the picture without changing what it says —
    // the same reason moving a node does not bump lastMutationAt.
    open('title-b');
    const before = s().lastMutationAt;
    s().setTitle('Q3 pricing');
    expect(s().lastMutationAt).toBe(before);
  });
});

const connDraft = (anchor: string, to: string): ProposalDraft => ({
  kind: 'connection',
  text: 'these two relate',
  anchors: [anchor],
  connectTo: to,
  rationale: 'The board leaves this pair unconnected.',
});

describe('deleteEdge', () => {
  /** A board with one drawn connection, ready to be removed. */
  function connected(id: string) {
    open(id);
    const a = s().addNode(0, 0);
    const b = s().addNode(300, 0);
    s().connect(a, b);
    return { a, b, edgeId: s().board.edges[0].id };
  }

  it('removes only the targeted edge, and undo restores it', () => {
    const { b, edgeId } = connected('edge-a');
    const c = s().addNode(600, 0);
    s().connect(b, c);

    s().deleteEdge(edgeId);
    expect(s().board.edges).toHaveLength(1);
    expect(s().board.edges[0]).toMatchObject({ from: b, to: c });

    s().undo();
    expect(s().board.edges.some((e) => e.id === edgeId)).toBe(true);
    expect(s().board.edges).toHaveLength(2);
  });

  it('is a no-op for an unknown id', () => {
    const { edgeId } = connected('edge-b');
    const undoDepth = s().undoStack.length;
    s().deleteEdge('e_does_not_exist');
    expect(s().board.edges).toHaveLength(1);
    expect(s().board.edges[0].id).toBe(edgeId);
    expect(s().undoStack).toHaveLength(undoDepth);
  });

  it('clears the edge selection pointing at the removed line', () => {
    const { edgeId } = connected('edge-c');
    s().selectEdge(edgeId);
    s().deleteEdge(edgeId);
    expect(s().selectedEdgeId).toBeNull();
  });

  it('counts as thinking, so the trigger debounces instead of firing at once', () => {
    const { edgeId } = connected('edge-d');
    // Pinned rather than compared against a real clock: on a fast machine the
    // setup and the delete can land in the same millisecond.
    vi.spyOn(Date, 'now').mockReturnValue(12345);
    s().deleteEdge(edgeId);
    expect(s().lastMutationAt).toBe(12345);
    vi.restoreAllMocks();
  });

  it('remembers the pair on the board it happened on, across switches', () => {
    const { a, b, edgeId } = connected('edge-e');
    s().deleteEdge(edgeId);
    expect(s().deletedEdgesByBoard['edge-e']).toEqual([edgePair(a, b)]);

    open('edge-f');
    expect(s().deletedEdgesByBoard['edge-f']).toBeUndefined();
    open('edge-e');
    expect(s().deletedEdgesByBoard['edge-e']).toEqual([edgePair(a, b)]);
  });
});

describe('edge selection', () => {
  it('is mutually exclusive with node selection', () => {
    open('sel-a');
    const n = s().addNode(0, 0);
    s().selectEdge('e_1');
    expect(s().selectedId).toBeNull();
    s().select(n);
    expect(s().selectedEdgeId).toBeNull();
    expect(s().selectedId).toBe(n);
  });

  it('does not survive a board switch or an undo', () => {
    open('sel-b');
    s().selectEdge('e_1');
    open('sel-c');
    expect(s().selectedEdgeId).toBeNull();

    open('sel-d');
    s().addNode(0, 0);
    s().selectEdge('e_1');
    s().undo();
    expect(s().selectedEdgeId).toBeNull();
  });

  it('drops when node deletion cascades its edge away', () => {
    open('sel-e');
    const a = s().addNode(0, 0);
    const b = s().addNode(300, 0);
    s().connect(a, b);
    s().selectEdge(s().board.edges[0].id);
    s().deleteNode(b);
    expect(s().selectedEdgeId).toBeNull();
    expect(s().board.edges).toHaveLength(0);
  });
});

describe('receiveProposal after a deleted connection', () => {
  it('drops a proposal for the exact pair the user removed, in either direction', () => {
    open('supp-a');
    const a = s().addNode(0, 0);
    const b = s().addNode(300, 0);
    s().connect(a, b);
    s().deleteEdge(s().board.edges[0].id);

    s().receiveProposal(connDraft(a, b));
    expect(s().proposal).toBeNull();
    s().receiveProposal(connDraft(b, a));
    expect(s().proposal).toBeNull();
  });

  it('still admits unrelated proposals', () => {
    open('supp-b');
    const a = s().addNode(0, 0);
    const b = s().addNode(300, 0);
    const c = s().addNode(600, 0);
    s().connect(a, b);
    s().deleteEdge(s().board.edges[0].id);

    s().receiveProposal(connDraft(a, c));
    expect(s().proposal).not.toBeNull();
    expect(s().proposal?.connectTo).toBe(c);
  });

  it('does not leak one board’s deletions into another', () => {
    open('supp-c');
    const a = s().addNode(0, 0);
    const b = s().addNode(300, 0);
    s().connect(a, b);
    s().deleteEdge(s().board.edges[0].id);

    open('supp-d');
    const c = s().addNode(0, 0);
    const d = s().addNode(300, 0);
    s().receiveProposal(connDraft(c, d));
    expect(s().proposal).not.toBeNull();
  });
});
