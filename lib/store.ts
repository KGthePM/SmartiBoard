'use client';

import { create } from 'zustand';
import {
  clampSize,
  createNode,
  edgeExists,
  edgePair,
  emptyBoard,
  newId,
  OBJECTIVE_MAX,
  removeNodes,
  stepFontSize,
  TITLE_MAX,
  visibleRect,
  type Board,
  type Layer,
  type NodeId,
  type Viewport,
} from './graph';
import { DEBOUNCE_MS, fingerprint } from './ai/trigger';
import type { IdeaDraft } from './ai/ideas';
import { placeProposal } from './placement';
import type { Proposal, ProposalDraft } from './proposal';

/** Screen size of the canvas surface, needed to know what's actually visible. */
type Surface = { w: number; h: number };

/**
 * The idea generator (v2.0), replacing the summary. `too_thin` is its own
 * refusal because it is the one the person can act on — write an objective or
 * a card and the button lights up.
 */
export type IdeasStatus =
  | 'idle'
  | 'streaming'
  | 'done'
  | 'no_key'
  | 'private'
  | 'too_thin'
  | 'error';

/**
 * A generated idea as the panel holds it: the draft plus a local id and whether
 * it has been added. Like a Proposal it is deliberately NOT an IdeaNode — it
 * lives in this slice, never in board.nodes, and `addIdea` constructs a fresh
 * node rather than promoting it. That is the only bridge, and the user is
 * always the one who crosses it.
 */
export type PanelIdea = IdeaDraft & {
  id: string;
  /** Kept in the list once added, greyed rather than removed: a list that
   *  reshuffles under the cursor makes the next click a gamble. */
  added: boolean;
};

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
   * The ideas panel. `ideasFingerprint` is the board the list was generated
   * from — the panel compares it to the live fingerprint to know the list is
   * still about the board you are looking at, so reopening with no material
   * change never re-spends tokens. `ideasSeedId` is the card the run branched
   * from, when there was one; it is remembered so Regenerate keeps the thread.
   */
  ideasOpen: boolean;
  ideas: PanelIdea[];
  ideasStatus: IdeasStatus;
  ideasFingerprint: string | null;
  ideasSeedId: NodeId | null;
  /**
   * The Settings modal. Global like the settings themselves — provider config
   * belongs to the install, not to a board — but it still closes on board
   * switch with everything else, because the page remount would eat unsaved
   * form state mid-edit otherwise.
   */
  settingsOpen: boolean;
  /**
   * The Objective popover. Per-board, unlike Settings — the objective is part of
   * the board — but it closes on a board switch for the same reason.
   */
  objectiveOpen: boolean;
  /**
   * Find and Replace (v2.4). All six fields are session UI and spend nothing —
   * no undo snapshot, no redo stack, no lastMutationAt bump, never a token, and
   * deliberately absent from the fingerprint: looking for a word you already
   * wrote says nothing new about the board. Per-board like the Objective
   * popover, so beginLoad clears the lot.
   *
   * The matches themselves are NOT here. They are derived from the board and
   * the query wherever they are needed, so there is nothing to invalidate when
   * a card changes underneath them. `searchIndex` is an ordinal into that
   * derived list, clamped by whoever holds it — the BoardSwitcher's cursor rule.
   */
  searchOpen: boolean;
  searchQuery: string;
  searchReplace: string;
  searchCase: boolean;
  searchWhole: boolean;
  searchIndex: number;
  viewport: Viewport;
  surface: Surface;
  /**
   * Presentation mode (v1.13): the board on a screen, for a room. Pure view,
   * exactly like the selection — no undo snapshot, no redo spend, no
   * lastMutationAt bump, never a token, absent from the fingerprint by
   * construction. The canvas is read-only under it; the only interactions
   * left are pan and wheel-zoom.
   */
  presenting: boolean;
  /**
   * The viewport the presenter left, saved on the way in and restored on the
   * way out — a viewport is not content, so restoring is politeness, not an
   * edit. The fitted camera itself is set by the canvas, which owns the
   * surface geometry.
   */
  prePresentViewport: Viewport | null;
  /**
   * The selection — one card or many. Pure UI state: it spends no undo step,
   * no token, and never survives a board switch, an undo, or a redo.
   */
  selectedIds: NodeId[];
  /** The selected edge, if any. Mutually exclusive with selectedIds. */
  selectedEdgeId: string | null;
  /** Board snapshots, pushed only by user actions. Ghost arrival never touches this. */
  undoStack: Board[];
  /**
   * The undone future, newest last — the mirror of undoStack. Any change to
   * the board spends it: the future it holds belongs to the board exactly as
   * it was when it was undone. Ghost arrival never touches this either.
   */
  redoStack: Board[];
  lastMutationAt: number;
  lastRequestedFingerprint: string | null;
  /**
   * The ghost's settle window (v2.1), as the Settings row holds it. Install-
   * level UI state, like settingsOpen: no undo snapshot, no redo spend, no
   * lastMutationAt bump, never a token, and deliberately absent from beginLoad
   * — it belongs to the install, not to any board, so a switch must not reset
   * it. The suggest loop reads it fresh off getState() every tick, which is
   * the whole delivery mechanism: a Settings save lands within a second.
   */
  ghostDelayMs: number;
  /**
   * When the last suggest request failed to come back with an answer. A failure
   * says nothing about the board, so the fingerprint is released and this
   * stands in its place — see FAILURE_COOLDOWN_MS in lib/ai/trigger.ts.
   */
  suggestFailedAt: number | null;
  /** Which node the last text edit touched, so typing coalesces into one undo step. */
  lastTextEditId: NodeId | null;
  loaded: boolean;

  beginLoad: (id: string) => void;
  hydrate: (board: Board) => void;
  setTitle: (title: string) => void;
  setObjective: (objective: string) => void;
  setPrivacy: (v: boolean) => void;
  addNode: (x: number, y: number) => NodeId;
  setNodeText: (id: NodeId, text: string, format?: boolean) => void;
  /** Absolute positions for a whole dragged set — one set() per pointer event. */
  moveNodes: (moves: { id: NodeId; x: number; y: number }[]) => void;
  resizeNode: (id: NodeId, w: number, h: number) => void;
  adjustNodeFontSize: (id: NodeId, dir: 1 | -1) => void;
  toggleNodeDone: (id: NodeId) => void;
  deleteNode: (id: NodeId) => void;
  /** The multi-delete: one deliberate edit, one undo step for the whole batch. */
  deleteNodes: (ids: NodeId[]) => void;
  connect: (from: NodeId, to: NodeId, layer?: Layer) => void;
  deleteEdge: (id: string) => void;
  /** Collapse the selection to one card, or clear it with null. */
  select: (id: NodeId | null) => void;
  /** Shift+click: add the card to the selection, or remove it if it is in. */
  toggleSelect: (id: NodeId) => void;
  /** The marquee result: what it swept is the selection, an empty sweep clears. */
  selectMany: (ids: NodeId[]) => void;
  selectEdge: (id: string | null) => void;
  setViewport: (v: Viewport) => void;
  setSurface: (s: Surface) => void;
  setPresenting: (v: boolean) => void;

  setSuggesting: (v: boolean) => void;
  /** Install-level: the Settings panel writes it, the suggest loop reads it. */
  setGhostDelay: (ms: number) => void;
  markRequested: (fingerprint: string) => void;
  failRequest: () => void;
  receiveProposal: (draft: ProposalDraft) => void;
  acceptProposal: () => void;
  dismissProposal: () => void;

  setIdeasOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setObjectiveOpen: (open: boolean) => void;
  setSearchOpen: (open: boolean) => void;
  setSearchQuery: (query: string) => void;
  setSearchReplace: (replacement: string) => void;
  setSearchOptions: (opts: { caseSensitive?: boolean; wholeWord?: boolean }) => void;
  setSearchIndex: (i: number) => void;
  /** Rewritten text for a batch of cards, and the objective if it changed. */
  replaceText: (nodes: { id: NodeId; text: string }[], objective?: string) => void;
  beginIdeas: (seedId: NodeId | null) => void;
  receiveIdea: (draft: IdeaDraft) => void;
  finishIdeas: (fingerprint: string) => void;
  failIdeas: (reason: string) => void;
  cancelIdeas: () => void;
  addIdea: (localId: string) => void;

  undo: () => void;
  redo: () => void;
};

const UNDO_LIMIT = 50;
const REJECTED_LIMIT = 12;
const DELETED_LIMIT = 24;

/**
 * A stand-in node id for the title field, so renaming coalesces into one undo
 * step the same way typing into a card does.
 */
const TITLE_EDIT = '__title__';

/** The same stand-in, for the objective textarea. */
const OBJECTIVE_EDIT = '__objective__';

export const useBoard = create<State>((set, get) => ({
  boardId: '',
  board: emptyBoard(''),
  proposal: null,
  rejectedByBoard: {},
  deletedEdgesByBoard: {},
  suggesting: false,
  ideasOpen: false,
  ideas: [],
  ideasStatus: 'idle',
  ideasFingerprint: null,
  ideasSeedId: null,
  settingsOpen: false,
  objectiveOpen: false,
  searchOpen: false,
  searchQuery: '',
  searchReplace: '',
  searchCase: false,
  searchWhole: false,
  searchIndex: 0,
  viewport: { x: 0, y: 0, scale: 1 },
  surface: { w: 1200, h: 800 },
  presenting: false,
  prePresentViewport: null,
  selectedIds: [],
  selectedEdgeId: null,
  undoStack: [],
  redoStack: [],
  lastMutationAt: 0,
  lastRequestedFingerprint: null,
  ghostDelayMs: DEBOUNCE_MS,
  suggestFailedAt: null,
  lastTextEditId: null,
  loaded: false,

  /**
   * Point the session at a board and drop everything derived from the last one.
   * Switching boards is a client-side navigation inside one mounted canvas, so
   * without this the undo stack, its redo mirror, the live ghost, and the
   * trigger fingerprint all follow you across — and ⌘Z would restore one
   * board's snapshot into another, which autosave would then write to the
   * wrong id. The generated ideas go too: closing the panel unmounts it, which
   * aborts any live stream.
   */
  beginLoad: (id) =>
    set({
      boardId: id,
      board: emptyBoard(id),
      loaded: false,
      proposal: null,
      undoStack: [],
      redoStack: [],
      selectedIds: [],
      selectedEdgeId: null,
      suggesting: false,
      ideasOpen: false,
      ideas: [],
      ideasStatus: 'idle',
      ideasFingerprint: null,
      ideasSeedId: null,
      settingsOpen: false,
      objectiveOpen: false,
      searchOpen: false,
      searchQuery: '',
      searchReplace: '',
      // The toggles reset too. They could plausibly be a sticky preference, but
      // then they would be the only search field that survives a board switch
      // and still not survive a reload — one rule is worth more than the
      // convenience of keeping `Aa` on across boards.
      searchCase: false,
      searchWhole: false,
      searchIndex: 0,
      lastRequestedFingerprint: null,
      suggestFailedAt: null,
      lastTextEditId: null,
      viewport: { x: 0, y: 0, scale: 1 },
      // A board switch lands you out of presentation, like it closes the
      // panels — and, through the overlay unmounting, out of browser
      // fullscreen. Presenting board A over board B is not a thing.
      presenting: false,
      prePresentViewport: null,
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
      // A continued rename still spends the redo stack — the board changed.
      ...(shouldSnapshotTextEdit(s, TITLE_EDIT) ? pushUndo(s) : { redoStack: [] }),
      board: { ...s.board, title: title.slice(0, TITLE_MAX) },
      lastTextEditId: TITLE_EDIT,
      // Deliberately no lastMutationAt bump: naming a board renames the
      // picture without changing what it says, so it must not spend a token.
    })),

  setObjective: (objective) =>
    set((s) => ({
      // Coalesces per burst like the title does — but the doctrine inverts here.
      // The objective leads both prompts, so rewriting it changes what the board
      // says to the model, and the ghost should be allowed to answer the new
      // framing on an otherwise unchanged board. Hence the bump.
      ...(shouldSnapshotTextEdit(s, OBJECTIVE_EDIT) ? pushUndo(s) : { redoStack: [] }),
      board: { ...s.board, objective: objective.slice(0, OBJECTIVE_MAX) },
      lastTextEditId: OBJECTIVE_EDIT,
      lastMutationAt: Date.now(),
    })),

  /**
   * Privacy Mode. Deliberately spends nothing: no undo snapshot, no redo stack,
   * no lastMutationAt bump. The model never sees this flag, so flipping it says
   * nothing new about the board and must not cost a token — and see undo/redo
   * below, which refuse to carry it at all.
   */
  setPrivacy: (v) =>
    set((s) => ({
      board: { ...s.board, privacy: v },
      // Turning it on retires a ghost already on the canvas. Not
      // dismissProposal(): the user didn't turn the idea down, so it must not
      // land in rejectedByBoard and be suppressed forever after.
      proposal: v ? null : s.proposal,
    })),

  addNode: (x, y) => {
    const node = createNode({ x, y });
    set((s) => ({
      ...pushUndo(s),
      board: { ...s.board, nodes: [...s.board.nodes, node] },
      selectedIds: [node.id],
      lastMutationAt: Date.now(),
    }));
    return node.id;
  },

  setNodeText: (id, text, format = false) =>
    set((s) => ({
      // Typing coalesces into one undo entry per node, per burst — pushing a
      // snapshot per keystroke would make undo useless. Format toggles
      // (format: true) are deliberate single actions and always snapshot.
      // Either way the redo stack is spent: the board changed.
      ...(format || shouldSnapshotTextEdit(s, id) ? pushUndo(s) : { redoStack: [] }),
      board: {
        ...s.board,
        nodes: s.board.nodes.map((n) => (n.id === id ? { ...n, text } : n)),
      },
      lastMutationAt: Date.now(),
      lastTextEditId: id,
    })),

  moveNodes: (moves) =>
    set((s) => ({
      board: {
        ...s.board,
        nodes: s.board.nodes.map((n) => {
          const m = moves.find((x) => x.id === n.id);
          return m ? { ...n, x: m.x, y: m.y } : n;
        }),
      },
      // The move doctrine, batched: rearranging the picture changes nothing the
      // board says — deliberately no undo snapshot and no lastMutationAt bump,
      // so it never spends a token. It still spends the redo stack: a redo
      // snapshot is the whole board, positions included, so redoing after a
      // drag would snap the cards back.
      redoStack: [],
    })),

  resizeNode: (id, w, h) =>
    set((s) => ({
      board: {
        ...s.board,
        nodes: s.board.nodes.map((n) => (n.id === id ? { ...n, ...clampSize(w, h) } : n)),
      },
      // Same doctrine as moveNode: a box's size is presentation, not content —
      // no undo snapshot, no lastMutationAt bump, never a token. But like a
      // move it spends the redo stack, because a redo snapshot holds sizes too.
      redoStack: [],
    })),

  /**
   * Text size, one ladder rung at a time. The resize doctrine again, and for
   * the same reasons: a card's font is presentation — the model never sees it,
   * so no undo snapshot, no lastMutationAt bump, never a token. Like a resize
   * it still spends the redo stack, because a redo snapshot holds font sizes
   * too, and redoing after a size change would snap the text back.
   */
  adjustNodeFontSize: (id, dir) =>
    set((s) => ({
      board: {
        ...s.board,
        nodes: s.board.nodes.map((n) =>
          n.id === id ? { ...n, fontSize: stepFontSize(n.fontSize, dir) } : n,
        ),
      },
      redoStack: [],
    })),

  /**
   * Crossing an idea off is the opposite doctrine from resize: done is content
   * the model sees, so the toggle is a deliberate action — one undo snapshot
   * per toggle, like a format toggle — and it bumps lastMutationAt, so the
   * ghost debounces and may wake once the board settles again.
   */
  toggleNodeDone: (id) =>
    set((s) => ({
      ...pushUndo(s),
      board: {
        ...s.board,
        nodes: s.board.nodes.map((n) => (n.id === id ? { ...n, done: !n.done } : n)),
      },
      lastMutationAt: Date.now(),
    })),

  // The card's × is the batch of one — one implementation, one doctrine.
  deleteNode: (id) => get().deleteNodes([id]),

  deleteNodes: (ids) =>
    set((s) => {
      const board = removeNodes(s.board, ids);
      // Nothing listed was on the board: not an edit, nothing to snapshot.
      if (board.nodes.length === s.board.nodes.length) return s;
      return {
        ...pushUndo(s),
        board,
        // The deleted cards leave the selection; survivors stay selected.
        selectedIds: s.selectedIds.filter((id) => board.nodes.some((n) => n.id === id)),
        // A node's edges die with it, so the selected edge may have vanished too.
        selectedEdgeId:
          s.selectedEdgeId && board.edges.some((e) => e.id === s.selectedEdgeId)
            ? s.selectedEdgeId
            : null,
        // One bump for the whole batch, like the one snapshot: deleting five
        // cards is one deliberate edit, not five.
        lastMutationAt: Date.now(),
      };
    }),

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

  select: (id) => set({ selectedIds: id ? [id] : [], selectedEdgeId: null }),

  toggleSelect: (id) =>
    set((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id],
      // Selecting cards and selecting a line never coexist.
      selectedEdgeId: null,
    })),

  selectMany: (ids) => set({ selectedIds: ids, selectedEdgeId: null }),

  selectEdge: (id) => set({ selectedEdgeId: id, selectedIds: [] }),
  setViewport: (v) => set({ viewport: v }),
  setSurface: (surface) => set({ surface }),

  /**
   * Presentation mode. The mode flag plus the viewport bookkeeping and nothing
   * else — entering clears the selection the way undo does (no ring on the
   * projector) and saves the viewport to restore on exit. Spending nothing is
   * the point: a view of the board is not a change to it, so the undo stack,
   * the redo stack, and the trigger clock all stand exactly as they were.
   */
  setPresenting: (v) =>
    set((s) => {
      // Already there: re-asking must not re-save the viewport, or the fitted
      // camera would quietly become the restore point.
      if (v === s.presenting) return s;
      if (!v) {
        return {
          presenting: false,
          viewport: s.prePresentViewport ?? s.viewport,
          prePresentViewport: null,
        };
      }
      return {
        presenting: true,
        prePresentViewport: s.viewport,
        selectedIds: [],
        selectedEdgeId: null,
        // The find bar's chrome unmounts under the overlay, but its highlights
        // are painted on the cards themselves — no tinted words on a projector,
        // for the same reason there is no selection ring on one.
        searchOpen: false,
      };
    }),

  setSuggesting: (v) => set({ suggesting: v }),
  setGhostDelay: (ms) => set({ ghostDelayMs: ms }),
  // A request that got through ends any cooldown, whatever it came back with.
  markRequested: (fingerprint) =>
    set({ lastRequestedFingerprint: fingerprint, suggestFailedAt: null }),

  /**
   * The request never reached the model. Release the fingerprint so this board
   * can be asked about again — otherwise one dropped connection retires the
   * ghost until the user happens to edit something — and stamp the failure so
   * the trigger's cooldown paces the retry.
   */
  failRequest: () => set({ lastRequestedFingerprint: null, suggestFailedAt: Date.now() }),

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

  setIdeasOpen: (open) => set({ ideasOpen: open }),

  setSettingsOpen: (open) => set({ settingsOpen: open }),

  setObjectiveOpen: (open) => set({ objectiveOpen: open }),

  /**
   * The find bar. Closing it deliberately keeps the query: reopening on the
   * same board should offer back what you were looking for, and there is
   * nothing to spend by remembering it.
   */
  setSearchOpen: (open) => set({ searchOpen: open }),

  // A changed query or option makes the old ordinal meaningless — back to the
  // first match, the way the switcher's cursor resets as you type.
  setSearchQuery: (query) => set({ searchQuery: query, searchIndex: 0 }),

  setSearchReplace: (replacement) => set({ searchReplace: replacement }),

  setSearchOptions: (opts) =>
    set((s) => ({
      searchCase: opts.caseSensitive ?? s.searchCase,
      searchWhole: opts.wholeWord ?? s.searchWhole,
      searchIndex: 0,
    })),

  setSearchIndex: (i) => set({ searchIndex: i }),

  /**
   * A replace, of one match or of every match on the board. One action for
   * both, because a single Replace is the batch of one — the same reason
   * deleteNode delegates to deleteNodes.
   *
   * The doctrine is the ordinary one for content: ONE undo snapshot for the
   * whole batch and ONE lastMutationAt bump, so a Replace All across twelve
   * cards is a single ⌘Z and a single settle of the ghost clock. Looping
   * setNodeText would give twelve of each, because its coalescing is keyed on
   * node identity with no timer — a different id ends the burst every time.
   *
   * It bumps lastMutationAt (unlike a move or a resize) because it changes what
   * the board says, and the ghost is allowed to answer the board's new wording.
   */
  replaceText: (nodes, objective) =>
    set((s) => {
      const edits = new Map(nodes.map((n) => [n.id, n.text]));
      const board = {
        ...s.board,
        nodes: s.board.nodes.map((n) =>
          edits.has(n.id) && edits.get(n.id) !== n.text ? { ...n, text: edits.get(n.id)! } : n,
        ),
        objective:
          objective === undefined ? s.board.objective : objective.slice(0, OBJECTIVE_MAX),
      };

      // Nothing actually moved: not an edit, so nothing to snapshot. The guard
      // deleteNodes uses, for the same reason.
      const changed =
        board.objective !== s.board.objective || board.nodes.some((n, i) => n !== s.board.nodes[i]);
      if (!changed) return s;

      return {
        ...pushUndo(s),
        board,
        lastMutationAt: Date.now(),
        // End the typing burst: the first keystroke after a replace is a new
        // edit and must get a snapshot of its own, as after an undo.
        lastTextEditId: null,
      };
    }),

  beginIdeas: (seedId) => set({ ideas: [], ideasStatus: 'streaming', ideasSeedId: seedId }),

  // Ideas are only meaningful mid-stream. The guard makes a stale frame — one
  // that outlived its board switch — structurally a no-op even if the
  // component-side boardId check ever failed. No pushUndo, for the same reason
  // ghost arrival has none: a suggestion appearing is not something the user
  // did, and must never be undoable.
  receiveIdea: (draft) =>
    set((s) =>
      s.ideasStatus === 'streaming'
        ? { ideas: [...s.ideas, { ...draft, id: newId('i'), added: false }] }
        : s,
    ),

  finishIdeas: (fp) =>
    set((s) => (s.ideasStatus === 'streaming' ? { ideasStatus: 'done', ideasFingerprint: fp } : s)),

  failIdeas: (reason) =>
    set((s) =>
      s.ideasStatus === 'streaming'
        ? {
            ideasStatus:
              reason === 'no_api_key'
                ? 'no_key'
                : // The route refused because the board is private, or because
                  // there is nothing on it yet. Both are states, not failures,
                  // and must not read as one.
                  reason === 'privacy'
                  ? 'private'
                  : reason === 'too_thin'
                    ? 'too_thin'
                    : 'error',
          }
        : s,
    ),

  // Closing the panel mid-stream is a cancellation, not a failure: back to idle
  // with nothing half-listed, so reopening offers the button again. A finished
  // list is untouched — it is the cache the panel reopens to.
  cancelIdeas: () =>
    set((s) => (s.ideasStatus === 'streaming' ? { ideas: [], ideasStatus: 'idle' } : s)),

  /**
   * The only bridge from the panel to the board, and the mirror of
   * acceptProposal: a fresh node is constructed here with layer 'accepted', and
   * the draft object is discarded rather than promoted. Unlike the ideas
   * arriving, this IS the user acting — so it snapshots for undo and bumps
   * lastMutationAt like any other edit.
   */
  addIdea: (localId) =>
    set((s) => {
      const idea = s.ideas.find((i) => i.id === localId);
      if (!idea || idea.added) return s;

      const { x, y } = placeProposal(
        s.board,
        idea.anchors,
        undefined,
        visibleRect(s.viewport, s.surface),
      );
      const node = createNode({ x, y, text: idea.text, layer: 'accepted' });
      // Anchors the model named may have been deleted since it was asked.
      const edges = idea.anchors
        .filter((a) => s.board.nodes.some((n) => n.id === a))
        .map((a) => ({ id: newId('e'), from: a, to: node.id, layer: 'accepted' as Layer }));

      const board = {
        ...s.board,
        nodes: [...s.board.nodes, node],
        edges: [...s.board.edges, ...edges],
      };

      return {
        ...pushUndo(s),
        board,
        ideas: s.ideas.map((i) => (i.id === localId ? { ...i, added: true } : i)),
        // Re-stamped, so your own Add does not immediately flag the rest of the
        // list as stale — the list is still about the board it was asked about,
        // plus the one card you just took from it.
        ideasFingerprint: s.ideasStatus === 'done' ? fingerprint(board) : s.ideasFingerprint,
        selectedIds: [node.id],
        lastMutationAt: Date.now(),
      };
    }),

  undo: () =>
    set((s) => {
      const prev = s.undoStack.at(-1);
      if (!prev) return s;
      return {
        // Privacy Mode is never in the undo stack, in either direction — the
        // live flag survives the restore. A ⌘Z that silently put the board back
        // on speaking terms with a model is the one undo nobody can see and
        // nobody can take back.
        board: { ...prev, privacy: s.board.privacy },
        undoStack: s.undoStack.slice(0, -1),
        // The board being left becomes the undone future, one entry per undo.
        redoStack: [...s.redoStack, s.board],
        selectedIds: [],
        // The restored board may not contain the selected edge anymore.
        selectedEdgeId: null,
        lastMutationAt: Date.now(),
        // End the typing burst: the first keystroke after an undo is a new
        // edit and must get a snapshot of its own, not coalesce onto the
        // pre-undo burst.
        lastTextEditId: null,
      };
    }),

  redo: () =>
    set((s) => {
      const next = s.redoStack.at(-1);
      if (!next) return s;
      return {
        // Pinned for the same reason as undo, above.
        board: { ...next, privacy: s.board.privacy },
        // Walking forward is itself undoable, so the board being left goes
        // back on the undo stack. No UNDO_LIMIT slice needed: undo and redo
        // only trade entries between the two stacks, so neither can outgrow
        // the cap pushUndo already enforces.
        undoStack: [...s.undoStack, s.board],
        redoStack: s.redoStack.slice(0, -1),
        selectedIds: [],
        selectedEdgeId: null,
        lastMutationAt: Date.now(),
        lastTextEditId: null,
      };
    }),
}));

/** What the user has turned down on the board they are looking at. */
export function rejectedFor(s: State): string[] {
  return s.rejectedByBoard[s.board.id] ?? [];
}

function pushUndo(s: State): { undoStack: Board[]; redoStack: Board[] } {
  // A new user edit spends the redo stack: the future it holds belongs to the
  // board exactly as it was when it was undone, and that board no longer exists.
  return { undoStack: [...s.undoStack, s.board].slice(-UNDO_LIMIT), redoStack: [] };
}

/**
 * Snapshot on the first edit to a node, not on every keystroke. Typing a
 * sentence should be one undo step, not forty.
 */
function shouldSnapshotTextEdit(s: State, id: NodeId): boolean {
  return s.lastTextEditId !== id;
}
