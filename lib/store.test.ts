import { describe, expect, it, vi } from 'vitest';
import {
  createNode,
  edgePair,
  emptyBoard,
  NODE_MIN_H,
  NODE_MIN_W,
  OBJECTIVE_MAX,
} from './graph';
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
    s().undo();
    expect(s().redoStack).toHaveLength(1);

    open('undo-b');
    expect(s().undoStack).toEqual([]);
    expect(s().redoStack).toEqual([]);

    s().undo();
    expect(s().board.id).toBe('undo-b');
    expect(s().board.nodes).toEqual([]);
    s().redo();
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

  it('forgets a failed request so the next board is not born cooling down', () => {
    open('fail-a');
    s().failRequest();
    open('fail-b');
    expect(s().suggestFailedAt).toBeNull();
  });

  it('reports the board as unloaded until its content arrives', () => {
    open('load-a');
    s().beginLoad('load-b');
    expect(s().loaded).toBe(false);
    expect(s().board.id).toBe('load-b');
  });
});

describe('redo', () => {
  it('walks an undone edit back in, and the round trip repeats', () => {
    open('redo-a');
    s().addNode(0, 0);
    s().addNode(300, 0);
    const before = s().board;

    s().undo();
    expect(s().board.nodes).toHaveLength(1);
    s().redo();
    expect(s().board).toEqual(before);
    expect(s().redoStack).toEqual([]);

    // History is a two-way street: the walk repeats.
    s().undo();
    s().redo();
    expect(s().board).toEqual(before);
  });

  it('is itself undoable — redo puts the board it leaves back on the undo stack', () => {
    open('redo-b');
    s().addNode(0, 0);
    s().addNode(300, 0);
    s().undo();
    s().redo();
    const undoDepth = s().undoStack.length;

    s().undo();
    expect(s().board.nodes).toHaveLength(1);
    expect(s().undoStack).toHaveLength(undoDepth - 1);
  });

  it('is spent by the next deliberate edit', () => {
    open('redo-c');
    s().addNode(0, 0);
    s().undo();
    expect(s().redoStack).toHaveLength(1);

    s().addNode(300, 0);
    expect(s().redoStack).toEqual([]);
  });

  it('survives a ghost arriving, but is spent by accepting it', () => {
    // Arrival is not an edit; accepting is. Same split as the undo stack.
    open('redo-d');
    s().addNode(0, 0);
    s().undo();
    s().receiveProposal(draft);
    expect(s().redoStack).toHaveLength(1);

    s().acceptProposal();
    expect(s().redoStack).toEqual([]);
  });

  it('is spent by a move: a redo snapshot is the whole board, positions included', () => {
    // Otherwise redoing after a drag would snap the card back — the board
    // would feel haunted, the exact thing the ghost layer is kept out of.
    open('redo-e');
    const a = s().addNode(0, 0);
    s().addNode(300, 0);
    s().undo();
    expect(s().redoStack).toHaveLength(1);

    s().moveNode(a, 999, 999);
    expect(s().redoStack).toEqual([]);
  });

  it('is spent by a resize, the same as a move', () => {
    open('redo-f');
    const a = s().addNode(0, 0);
    s().addNode(300, 0);
    s().undo();

    s().resizeNode(a, 400, 200);
    expect(s().redoStack).toEqual([]);
  });

  it('ends the typing burst, so the first post-undo keystroke is its own undo step', () => {
    open('redo-g');
    const a = s().addNode(0, 0);
    s().setNodeText(a, 'one');
    s().setNodeText(a, 'one two'); // coalesced: the burst is one step
    expect(s().undoStack).toHaveLength(2); // addNode + the burst

    s().undo();
    expect(s().board.nodes[0]?.text).toBe('');

    // Without the burst reset this would coalesce onto the pre-undo burst and
    // leave the new text with no undo step of its own.
    s().setNodeText(a, 'fresh');
    expect(s().undoStack).toHaveLength(2);
    s().undo();
    expect(s().board.nodes[0]?.text).toBe('');
  });

  it('brings a deleted connection back, through undo of the delete', () => {
    open('redo-h');
    const a = s().addNode(0, 0);
    const b = s().addNode(300, 0);
    s().connect(a, b);
    s().deleteEdge(s().board.edges[0].id);
    expect(s().board.edges).toHaveLength(0);

    s().undo();
    expect(s().board.edges).toHaveLength(1);
    s().undo(); // past the connect
    expect(s().board.edges).toHaveLength(0);
    s().redo();
    expect(s().board.edges).toHaveLength(1);
  });

  it('clears the selection like undo does', () => {
    open('redo-i');
    const a = s().addNode(0, 0);
    s().addNode(300, 0);
    s().undo();
    s().select(a);

    s().redo();
    expect(s().selectedId).toBeNull();
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

describe('cancelSummary', () => {
  it('puts an abandoned stream back to idle with nothing half-written', () => {
    // Closing the panel mid-stream must not leave a corpse: reopening shows
    // the launch button, not a frozen partial summary pretending to stream.
    open('cancel-a');
    s().beginSummary();
    s().appendSummary('The board is about ');
    s().cancelSummary();
    expect(s().summaryStatus).toBe('idle');
    expect(s().summaryText).toBe('');
  });

  it('leaves a finished summary alone — that is the cache the panel reopens to', () => {
    open('cancel-b');
    s().beginSummary();
    s().appendSummary('a finished read');
    s().finishSummary('fp-1');
    s().cancelSummary();
    expect(s().summaryStatus).toBe('done');
    expect(s().summaryText).toBe('a finished read');
    expect(s().summaryFingerprint).toBe('fp-1');
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

describe('setObjective', () => {
  it('coalesces a burst into a single undo step', () => {
    open('obj-a');
    for (const t of ['W', 'Win', 'Win back', 'Win back churned teams']) s().setObjective(t);
    expect(s().board.objective).toBe('Win back churned teams');
    expect(s().undoStack).toHaveLength(1);

    s().undo();
    expect(s().board.objective).toBe('');
  });

  it('counts as thinking, unlike a rename', () => {
    // The objective leads both prompts, so rewriting it gives the model a
    // different board — the ghost should be allowed to answer the new framing.
    open('obj-b');
    // Pinned rather than compared against a real clock, as elsewhere here.
    vi.spyOn(Date, 'now').mockReturnValue(12345);
    s().setObjective('Win back churned design teams.');
    expect(s().lastMutationAt).toBe(12345);

    // The control: the same keystrokes in the title field spend nothing.
    s().setTitle('Q3 pricing');
    expect(s().lastMutationAt).toBe(12345);
    vi.restoreAllMocks();
  });

  it('truncates at the cap', () => {
    open('obj-c');
    s().setObjective('x'.repeat(OBJECTIVE_MAX + 50));
    expect(s().board.objective).toHaveLength(OBJECTIVE_MAX);
  });

  it('closes the popover on a board switch', () => {
    open('obj-d');
    s().setObjectiveOpen(true);
    expect(s().objectiveOpen).toBe(true);
    s().beginLoad('obj-e');
    expect(s().objectiveOpen).toBe(false);
  });

  it('does not follow you to the next board', () => {
    open('obj-f');
    s().setObjective('Win back churned design teams.');
    open('obj-g');
    expect(s().board.objective).toBe('');
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

describe('resizeNode', () => {
  it('resizes only the target card, on whole pixels, never below the minimums', () => {
    open('size-a');
    const a = s().addNode(0, 0);
    const b = s().addNode(300, 0);
    s().resizeNode(a, 340.6, 180.2);
    expect(s().board.nodes[0]).toMatchObject({ w: 341, h: 180 });
    expect(s().board.nodes[1]).toMatchObject({ w: 200, h: 96 });

    s().resizeNode(a, 10, 5);
    expect(s().board.nodes[0]).toMatchObject({ w: NODE_MIN_W, h: NODE_MIN_H });
  });

  it('is presentation, not content: no undo step, no token', () => {
    // Same doctrine as moveNode — rearranging the picture must neither haunt
    // the undo stack nor debounce the trigger.
    open('size-b');
    const n = s().addNode(0, 0);
    const undoDepth = s().undoStack.length;
    const before = s().lastMutationAt;
    s().resizeNode(n, 400, 200);
    expect(s().board.nodes[0]).toMatchObject({ w: 400, h: 200 });
    expect(s().undoStack).toHaveLength(undoDepth);
    expect(s().lastMutationAt).toBe(before);
  });
});

describe('toggleNodeDone', () => {
  it('crosses off the idea, and only that idea, both ways', () => {
    open('done-a');
    const a = s().addNode(0, 0);
    const b = s().addNode(300, 0);

    s().toggleNodeDone(a);
    expect(s().board.nodes.find((n) => n.id === a)?.done).toBe(true);
    expect(s().board.nodes.find((n) => n.id === b)?.done).toBe(false);

    s().toggleNodeDone(a);
    expect(s().board.nodes.find((n) => n.id === a)?.done).toBe(false);
  });

  it('is a deliberate action: one undo step per toggle, and ⌘Z walks them back', () => {
    open('done-b');
    const a = s().addNode(0, 0);
    const depth = s().undoStack.length;

    s().toggleNodeDone(a);
    s().toggleNodeDone(a);
    expect(s().undoStack).toHaveLength(depth + 2);

    s().undo();
    expect(s().board.nodes[0].done).toBe(true);
    s().undo();
    expect(s().board.nodes[0].done).toBe(false);
  });

  it('counts as thinking, so the ghost debounces instead of waking at once', () => {
    // Done is content the model sees, so crossing an idea off belongs on the
    // same clock as editing one — unlike moving or resizing.
    open('done-c');
    const a = s().addNode(0, 0);
    vi.spyOn(Date, 'now').mockReturnValue(12345);
    s().toggleNodeDone(a);
    expect(s().lastMutationAt).toBe(12345);
    vi.restoreAllMocks();
  });
});

describe('failRequest', () => {
  // A request that never reached the model says nothing about this board, so
  // the board must not be treated as already asked about — otherwise one
  // dropped connection retires the ghost until the user edits something.
  it('releases the fingerprint and stamps the failure', () => {
    open('fail-c');
    s().markRequested('board-hash');
    s().failRequest();
    expect(s().lastRequestedFingerprint).toBeNull();
    expect(s().suggestFailedAt).not.toBeNull();
  });

  it('lets a request that got through end the cooldown', () => {
    open('fail-d');
    s().failRequest();
    s().markRequested('board-hash');
    expect(s().suggestFailedAt).toBeNull();
  });
});

describe('setPrivacy', () => {
  it('turns the board silent, and back', () => {
    open('privacy-a');
    expect(s().board.privacy).toBe(false);
    s().setPrivacy(true);
    expect(s().board.privacy).toBe(true);
    s().setPrivacy(false);
    expect(s().board.privacy).toBe(false);
  });

  it('spends nothing: no undo step, no token', () => {
    // The model never sees this flag, so flipping it says nothing new about
    // the board and must not put the ghost back on the clock.
    open('privacy-b');
    s().addNode(0, 0);
    const undoDepth = s().undoStack.length;
    const before = s().lastMutationAt;
    s().setPrivacy(true);
    expect(s().undoStack).toHaveLength(undoDepth);
    expect(s().lastMutationAt).toBe(before);
  });

  it('retires a live ghost without recording it as a rejection', () => {
    // The user silenced the board; they did not turn this idea down. Routing
    // it through rejectedByBoard would suppress it forever after.
    open('privacy-c');
    s().receiveProposal(draft);
    expect(s().proposal).not.toBeNull();

    s().setPrivacy(true);
    expect(s().proposal).toBeNull();
    expect(rejectedFor(s())).toEqual([]);
  });

  it('survives undo — ⌘Z can never put a board back on speaking terms', () => {
    // The single most important guarantee here: undo restores a whole board
    // snapshot, so without pinning, one ⌘Z would silently re-enable sending
    // this board to a model, invisibly and with no way to notice.
    open('privacy-d');
    const n = s().addNode(0, 0);
    s().setNodeText(n, 'pricing');
    s().setPrivacy(true);

    s().undo();
    expect(s().board.privacy).toBe(true);
    s().undo();
    expect(s().board.privacy).toBe(true);
  });

  it('survives redo too, in both directions', () => {
    open('privacy-e');
    const n = s().addNode(0, 0);
    s().setPrivacy(true);
    s().undo();
    s().redo();
    expect(s().board.privacy).toBe(true);

    // And the mirror: a board turned public stays public across the walk.
    s().setPrivacy(false);
    s().setNodeText(n, 'churn');
    s().undo();
    expect(s().board.privacy).toBe(false);
    s().redo();
    expect(s().board.privacy).toBe(false);
  });

  it('does not follow you to the next board', () => {
    open('privacy-f');
    s().setPrivacy(true);
    open('privacy-g');
    expect(s().board.privacy).toBe(false);
  });
});
