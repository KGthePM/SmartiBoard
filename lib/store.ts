'use client';

import { create } from 'zustand';
import {
  createNode,
  edgeExists,
  edgePair,
  emptyBoard,
  newId,
  removeNode,
  TITLE_MAX,
  type Board,
  type Layer,
  type NodeId,
} from './graph';
import { placeProposal } from './placement';
import type { Rect } from './graph';
import type { Proposal, ProposalDraft } from './proposal';

type Viewport = { x: number; y: number; scale: number };

/** Screen size of the canvas surface, needed to know what's actually visible. */
type Surface = { w: number; h: number };

/**
 * The board summary (v1.3): read-only AI output. Everything it is NOT follows
 * from that — never a node, never in the undo stack, never persisted, never
 * fed to rejectedByBoard. It is display state and nothing more.
 */
export type SummaryStatus = 'idle' | 'streaming' | 'done' | 'no_key' | 'error';

export type State = {
  /**
   * The board the session is currently pointed at. It is set by `beginLoad`
   * before the fetch resolves, so it is authoritative where `board.id` is not:
   * a response for a board you have already navigated away from is ignored.
   */
  boardId: string;
  board: Board;
  /**
   * Proposals live here, never in board.nodes. There is no code path that
   * merges one implicitly — `accept` is the only bridge, and it constructs a
   * fresh node rather than promoting the proposal object.
   */
  proposal: Proposal | null;
  /**
   * Session-scoped memory of what the user turned down, keyed by board. Global
   * would leak board A's dismissals into board B's prompt, and would forget
   * A's the moment you looked at B.
   */
  rejectedByBoard: Record<string, string[]>;
  /**
   * Connections the user removed by hand, keyed by board, as normalized
   * pairs. The model only ever sees the current edges, so without this it
   * would happily re-propose the exact line the user just deleted.
   */
  deletedEdgesByBoard: Record<string, [NodeId, NodeId][]>;
  suggesting: boolean;
  /**
   * The summary panel. `summaryFingerprint` is the board the cached text was
   * generated from — the panel compares it to the live fingerprint to know a
   * cached read is still fresh, so reopening with no material change never
   * re-spends tokens.
   */
  summaryOpen: boolean;
  summaryText: string;
  summaryStatus: SummaryStatus;
  summaryFingerprint: string | null;
  /**
   * The Settings modal. Global like the settings themselves — provider config
   * belongs to the install, not to a board — but it still closes on board
   * switch with everything else, because the page remount would eat unsaved
   * form state mid-edit otherwise.
   */
  settingsOpen: boolean;
  viewport: Viewport;
  surface: Surface;
  selectedId: NodeId | null;
  /** The selected edge, if any. Mutually exclusive with selectedId. */
  selectedEdgeId: string | null;
  /** Board snapshots, pushed only by user actions. Ghost arrival never touches this. */
  undoStack: Board[];
  lastMutationAt: number;
  lastRequestedFingerprint: string | null;
  /** Which node the last text edit touched, so typing coalesces into one undo step. */
  lastTextEditId: NodeId | null;
  loaded: boolean;

  beginLoad: (id: string) => void;
  hydrate: (board: Board) => void;
  setTitle: (title: string) => void;
  addNode: (x: number, y: number) => NodeId;
  setNodeText: (id: NodeId, text: string, format?: boolean) => void;
  moveNode: (id: NodeId, x: number, y: number) => void;
  deleteNode: (id: NodeId) => void;
  connect: (from: NodeId, to: NodeId, layer?: Layer) => void;
  deleteEdge: (id: string) => void;
  select: (id: NodeId | null) => void;
  selectEdge: (id: string | null) => void;
  setViewport: (v: Viewport) => void;
  setSurface: (s: Surface) => void;

  setSuggesting: (v: boolean) => void;
  markRequested: (fingerprint: string) => void;
  receiveProposal: (draft: ProposalDraft) => void;
  acceptProposal: () => void;
  dismissProposal: () => void;

  setSummaryOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  beginSummary: () => void;
  appendSummary: (chunk: string) => void;
  finishSummary: (fingerprint: string) => void;
  failSummary: (reason: string) => void;

  undo: () => void;
};

const UNDO_LIMIT = 50;
const REJECTED_LIMIT = 12;
const DELETED_LIMIT = 24;

/**
 * A stand-in node id for the title field, so renaming coalesces into one undo
 * step the same way typing into a card does.
 */
const TITLE_EDIT = '__title__';

export const useBoard = create<State>((set, get) => ({
  boardId: '',
  board: emptyBoard(''),
  proposal: null,
  rejectedByBoard: {},
  deletedEdgesByBoard: {},
  suggesting: false,
  summaryOpen: false,
  summaryText: '',
  summaryStatus: 'idle',
  summaryFingerprint: null,
  settingsOpen: false,
  viewport: { x: 0, y: 0, scale: 1 },
  surface: { w: 1200, h: 800 },
  selectedId: null,
  selectedEdgeId: null,
  undoStack: [],
  lastMutationAt: 0,
  lastRequestedFingerprint: null,
  lastTextEditId: null,
  loaded: false,

  /**
   * Point the session at a board and drop everything derived from the last one.
   * Switching boards is a client-side navigation inside one mounted canvas, so
   * without this the undo stack, the live ghost, and the trigger fingerprint
   * all follow you across — and ⌘Z would restore one board's snapshot into
   * another, which autosave would then write to the wrong id. The summary goes
   * too: closing the panel unmounts it, which aborts any live stream.
   */
  beginLoad: (id) =>
    set({
      boardId: id,
      board: emptyBoard(id),
      loaded: false,
      proposal: null,
      undoStack: [],
      selectedId: null,
      selectedEdgeId: null,
      suggesting: false,
      summaryOpen: false,
      summaryText: '',
      summaryStatus: 'idle',
      summaryFingerprint: null,
      settingsOpen: false,
      lastRequestedFingerprint: null,
      lastTextEditId: null,
      viewport: { x: 0, y: 0, scale: 1 },
    }),

  hydrate: (board) =>
    set((s) =>
      // A slow response for a board we already left must not clobber this one.
      s.boardId && s.boardId !== board.id
        ? s
        : { board, loaded: true, lastMutationAt: Date.now() },
    ),

  setTitle: (title) =>
    set((s) => ({
      ...(shouldSnapshotTextEdit(s, TITLE_EDIT) ? pushUndo(s) : {}),
      board: { ...s.board, title: title.slice(0, TITLE_MAX) },
      lastTextEditId: TITLE_EDIT,
      // Deliberately no lastMutationAt bump: naming a board renames the
      // picture without changing what it says, so it must not spend a token.
    })),

  addNode: (x, y) => {
    const node = createNode({ x, y });
    set((s) => ({
      ...pushUndo(s),
      board: { ...s.board, nodes: [...s.board.nodes, node] },
      selectedId: node.id,
      lastMutationAt: Date.now(),
    }));
    return node.id;
  },

  setNodeText: (id, text, format = false) =>
    set((s) => ({
      // Typing coalesces into one undo entry per node, per burst — pushing a
      // snapshot per keystroke would make undo useless. Format toggles
      // (format: true) are deliberate single actions and always snapshot.
      ...(format || shouldSnapshotTextEdit(s, id) ? pushUndo(s) : {}),
      board: {
        ...s.board,
        nodes: s.board.nodes.map((n) => (n.id === id ? { ...n, text } : n)),
      },
      lastMutationAt: Date.now(),
      lastTextEditId: id,
    })),

  moveNode: (id, x, y) =>
    set((s) => ({
      board: {
        ...s.board,
        nodes: s.board.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)),
      },
      // Deliberately does NOT bump lastMutationAt: moving a node rearranges the
      // picture without changing what the board says, so it must not spend a token.
    })),

  deleteNode: (id) =>
    set((s) => ({
      ...pushUndo(s),
      board: removeNode(s.board, id),
      selectedId: s.selectedId === id ? null : s.selectedId,
      // A node's edges die with it, so the selected edge may have vanished too.
      selectedEdgeId:
        s.selectedEdgeId &&
        s.board.edges.some(
          (e) => e.id === s.selectedEdgeId && (e.from === id || e.to === id),
        )
          ? null
          : s.selectedEdgeId,
      lastMutationAt: Date.now(),
    })),

  connect: (from, to, layer = 'user') =>
    set((s) => {
      if (from === to || edgeExists(s.board, from, to)) return s;
      return {
        ...pushUndo(s),
        board: {
          ...s.board,
          edges: [...s.board.edges, { id: newId('e'), from, to, layer }],
        },
        lastMutationAt: Date.now(),
      };
    }),

  deleteEdge: (id) =>
    set((s) => {
      const edge = s.board.edges.find((e) => e.id === id);
      if (!edge) return s;
      const seen = s.deletedEdgesByBoard[s.board.id] ?? [];
      return {
        ...pushUndo(s),
        board: { ...s.board, edges: s.board.edges.filter((e) => e.id !== id) },
        selectedEdgeId: s.selectedEdgeId === id ? null : s.selectedEdgeId,
        deletedEdgesByBoard: {
          ...s.deletedEdgesByBoard,
          // Remembered so the ghost layer cannot offer this line back.
          [s.board.id]: [...seen, edgePair(edge.from, edge.to)].slice(-DELETED_LIMIT),
        },
        lastMutationAt: Date.now(),
      };
    }),

  select: (id) => set({ selectedId: id, selectedEdgeId: null }),
  selectEdge: (id) => set({ selectedEdgeId: id, selectedId: null }),
  setViewport: (v) => set({ viewport: v }),
  setSurface: (surface) => set({ surface }),

  setSuggesting: (v) => set({ suggesting: v }),
  markRequested: (fingerprint) => set({ lastRequestedFingerprint: fingerprint }),

  receiveProposal: (draft) => {
    const { board, deletedEdgesByBoard, viewport, surface } = get();
    // A connection the user deleted by hand must not come back as a ghost.
    if (draft.kind === 'connection' && draft.connectTo && draft.anchors[0]) {
      const pair = edgePair(draft.anchors[0], draft.connectTo);
      const dead = deletedEdgesByBoard[board.id] ?? [];
      if (dead.some((p) => p[0] === pair[0] && p[1] === pair[1])) return;
    }
    const { x, y } = placeProposal(board, draft.anchors, undefined, visibleRect(viewport, surface));
    // No pushUndo: a suggestion arriving is not something the user did, so it
    // must never be undoable. Otherwise the board feels haunted.
    set({ proposal: { ...draft, id: newId('p'), x, y } });
  },

  acceptProposal: () =>
    set((s) => {
      const p = s.proposal;
      if (!p) return s;

      if (p.kind === 'connection' && p.connectTo) {
        const from = p.anchors[0];
        if (!from || edgeExists(s.board, from, p.connectTo)) {
          return { ...s, proposal: null };
        }
        return {
          ...pushUndo(s),
          proposal: null,
          board: {
            ...s.board,
            edges: [
              ...s.board.edges,
              { id: newId('e'), from, to: p.connectTo, layer: 'accepted' as Layer },
            ],
          },
          lastMutationAt: Date.now(),
        };
      }

      // A fresh node is constructed here — the proposal object itself is discarded.
      const node = createNode({ x: p.x, y: p.y, text: p.text, layer: 'accepted' });
      const edges = p.anchors
        .filter((a) => s.board.nodes.some((n) => n.id === a))
        .map((a) => ({ id: newId('e'), from: a, to: node.id, layer: 'accepted' as Layer }));

      return {
        ...pushUndo(s),
        proposal: null,
        board: {
          ...s.board,
          nodes: [...s.board.nodes, node],
          edges: [...s.board.edges, ...edges],
        },
        lastMutationAt: Date.now(),
      };
    }),

  dismissProposal: () =>
    set((s) => {
      if (!s.proposal) return s;
      const id = s.board.id;
      const seen = s.rejectedByBoard[id] ?? [];
      return {
        proposal: null,
        // Remember it so the next request doesn't re-offer a reworded version.
        rejectedByBoard: {
          ...s.rejectedByBoard,
          [id]: [...seen, s.proposal.text].slice(-REJECTED_LIMIT),
        },
      };
    }),

  setSummaryOpen: (open) => set({ summaryOpen: open }),

  setSettingsOpen: (open) => set({ settingsOpen: open }),

  beginSummary: () => set({ summaryText: '', summaryStatus: 'streaming' }),

  // Streaming deltas are only meaningful mid-stream. The guard makes a stale
  // delta — one that outlived its board switch — structurally a no-op even if
  // the component-side boardId check ever failed.
  appendSummary: (chunk) =>
    set((s) =>
      s.summaryStatus === 'streaming' && chunk
        ? { summaryText: s.summaryText + chunk }
        : s,
    ),

  finishSummary: (fp) =>
    set((s) => (s.summaryStatus === 'streaming' ? { summaryStatus: 'done', summaryFingerprint: fp } : s)),

  failSummary: (reason) =>
    set((s) =>
      s.summaryStatus === 'streaming'
        ? { summaryStatus: reason === 'no_api_key' ? 'no_key' : 'error' }
        : s,
    ),

  undo: () =>
    set((s) => {
      const prev = s.undoStack.at(-1);
      if (!prev) return s;
      return {
        board: prev,
        undoStack: s.undoStack.slice(0, -1),
        selectedId: null,
        // The restored board may not contain the selected edge anymore.
        selectedEdgeId: null,
        lastMutationAt: Date.now(),
      };
    }),
}));

/** What the user has turned down on the board they are looking at. */
export function rejectedFor(s: State): string[] {
  return s.rejectedByBoard[s.board.id] ?? [];
}

/** The on-screen region, expressed in board coordinates. */
function visibleRect(v: Viewport, s: Surface): Rect {
  return { x: -v.x / v.scale, y: -v.y / v.scale, w: s.w / v.scale, h: s.h / v.scale };
}

function pushUndo(s: State): { undoStack: Board[] } {
  return { undoStack: [...s.undoStack, s.board].slice(-UNDO_LIMIT) };
}

/**
 * Snapshot on the first edit to a node, not on every keystroke. Typing a
 * sentence should be one undo step, not forty.
 */
function shouldSnapshotTextEdit(s: State, id: NodeId): boolean {
  return s.lastTextEditId !== id;
}
