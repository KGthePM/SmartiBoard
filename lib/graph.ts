/**
 * The board is a typed graph, not a drawing surface. Everything else —
 * rendering, persistence, and especially the AI behavior — is downstream of
 * these types.
 */

export type NodeId = string;

/** Authorship layer. Proposals are deliberately absent: they are never nodes. */
export type Layer = 'user' | 'accepted';

export type IdeaNode = {
  id: NodeId;
  text: string;
  /** Board coordinates, not screen coordinates. */
  x: number;
  y: number;
  w: number;
  h: number;
  layer: Layer;
  /**
   * The whiteboard's crossed-off idea. Unlike size or formatting this is
   * content the model sees, so it joins the fingerprint — see lib/ai/trigger.
   */
  done: boolean;
  createdAt: number;
};

export type Edge = {
  id: string;
  from: NodeId;
  to: NodeId;
  layer: Layer;
};

export type Board = {
  id: string;
  /**
   * A user-chosen name. Empty means "derive one from the content" — see
   * `boardTitle` in ./boards. Nobody should have to name a board before
   * thinking in it, so this stays empty until someone renames it.
   */
  title: string;
  /**
   * What this board is for, in the person's own words. Unlike the title this is
   * content the model reads: it leads the prompt both AI behaviors see, so it
   * joins the fingerprint (lib/ai/trigger) the way `done` does. Empty is the
   * normal state — nobody has to declare an objective to think in a board.
   */
  objective: string;
  /**
   * Privacy Mode: this board's contents are never sent to a model. It is the
   * inverse of the objective — the objective is content the model reads, this
   * is the switch that decides whether there is a model at all. The AI paths
   * check it, so it is not presentation; but the model never sees it, so it
   * never joins the fingerprint and never spends a token. False is the normal
   * state, and boards saved before it existed load that way.
   */
  privacy: boolean;
  nodes: IdeaNode[];
  edges: Edge[];
  updatedAt: number;
};

/** Renames are stored, not typed at, so a generous cap is enough. */
export const TITLE_MAX = 120;
/**
 * The objective is typed into, and every character of it rides in front of both
 * prompts. A paragraph is enough to state a goal, an audience, and a constraint;
 * past that it stops being the frame and starts competing with the board.
 */
export const OBJECTIVE_MAX = 400;

export const NODE_W = 200;
export const NODE_H = 96;
/** Floor for a manual resize: below this a card fits no word and no toolbar row. */
export const NODE_MIN_W = 120;
export const NODE_MIN_H = 48;

/** A manual resize lands on whole pixels and never below the minimums. */
export function clampSize(w: number, h: number): { w: number; h: number } {
  return {
    w: clampDim(w, NODE_MIN_W),
    h: clampDim(h, NODE_MIN_H),
  };
}

function clampDim(v: number, min: number): number {
  return Number.isFinite(v) ? Math.max(min, Math.round(v)) : min;
}

let counter = 0;

export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

export function emptyBoard(id: string): Board {
  return {
    id,
    title: '',
    objective: '',
    privacy: false,
    nodes: [],
    edges: [],
    updatedAt: Date.now(),
  };
}

export function createNode(
  partial: Partial<IdeaNode> & Pick<IdeaNode, 'x' | 'y'>,
): IdeaNode {
  return {
    id: partial.id ?? newId('n'),
    text: partial.text ?? '',
    x: partial.x,
    y: partial.y,
    w: partial.w ?? NODE_W,
    h: partial.h ?? NODE_H,
    layer: partial.layer ?? 'user',
    done: partial.done ?? false,
    createdAt: partial.createdAt ?? Date.now(),
  };
}

export function nodeById(board: Board, id: NodeId): IdeaNode | undefined {
  return board.nodes.find((n) => n.id === id);
}

export function edgeExists(board: Board, from: NodeId, to: NodeId): boolean {
  return board.edges.some(
    (e) => (e.from === from && e.to === to) || (e.from === to && e.to === from),
  );
}

/**
 * A canonical key for an undirected connection between two nodes, so that
 * A→B and B→A compare equal. Deleting either direction must suppress an AI
 * re-proposal of the other.
 */
export function edgePair(from: NodeId, to: NodeId): [NodeId, NodeId] {
  return from < to ? [from, to] : [to, from];
}

/** Removing a node takes its edges with it. */
export function removeNode(board: Board, id: NodeId): Board {
  return {
    ...board,
    nodes: board.nodes.filter((n) => n.id !== id),
    edges: board.edges.filter((e) => e.from !== id && e.to !== id),
  };
}

export type Rect = { x: number; y: number; w: number; h: number };

export function rectOf(n: Pick<IdeaNode, 'x' | 'y' | 'w' | 'h'>): Rect {
  return { x: n.x, y: n.y, w: n.w, h: n.h };
}

export function intersects(a: Rect, b: Rect, pad = 0): boolean {
  return (
    a.x - pad < b.x + b.w + pad &&
    a.x + a.w + pad > b.x - pad &&
    a.y - pad < b.y + b.h + pad &&
    a.y + a.h + pad > b.y - pad
  );
}

/**
 * Validates and normalizes untrusted board JSON coming off disk or the wire.
 * Anything malformed is dropped rather than thrown — a corrupt row should
 * degrade to an empty board, not a 500.
 */
export function parseBoard(id: string, raw: unknown): Board {
  if (typeof raw !== 'object' || raw === null) return emptyBoard(id);
  const obj = raw as Record<string, unknown>;

  const nodes: IdeaNode[] = Array.isArray(obj.nodes)
    ? obj.nodes.flatMap((candidate) => {
        if (typeof candidate !== 'object' || candidate === null) return [];
        const n = candidate as Record<string, unknown>;
        if (typeof n.id !== 'string') return [];
        if (typeof n.x !== 'number' || typeof n.y !== 'number') return [];
        return [
          createNode({
            id: n.id,
            text: typeof n.text === 'string' ? n.text : '',
            x: n.x,
            y: n.y,
            w: typeof n.w === 'number' ? n.w : NODE_W,
            h: typeof n.h === 'number' ? n.h : NODE_H,
            layer: n.layer === 'accepted' ? 'accepted' : 'user',
            // Boards saved before done existed load as not done, and anything
            // that is not strictly true is junk off the wire.
            done: n.done === true,
            createdAt: typeof n.createdAt === 'number' ? n.createdAt : Date.now(),
          }),
        ];
      })
    : [];

  const ids = new Set(nodes.map((n) => n.id));

  const edges: Edge[] = Array.isArray(obj.edges)
    ? obj.edges.flatMap((candidate) => {
        if (typeof candidate !== 'object' || candidate === null) return [];
        const e = candidate as Record<string, unknown>;
        if (typeof e.from !== 'string' || typeof e.to !== 'string') return [];
        // Drop dangling edges rather than rendering lines to nowhere.
        if (!ids.has(e.from) || !ids.has(e.to)) return [];
        return [
          {
            id: typeof e.id === 'string' ? e.id : newId('e'),
            from: e.from,
            to: e.to,
            layer: e.layer === 'accepted' ? 'accepted' : 'user',
          },
        ];
      })
    : [];

  return {
    id,
    title: typeof obj.title === 'string' ? obj.title.slice(0, TITLE_MAX) : '',
    // Boards saved before objectives existed load without one, same as `done`.
    objective:
      typeof obj.objective === 'string' ? obj.objective.slice(0, OBJECTIVE_MAX) : '',
    // Strictly true or it is not private. A board is only silent because
    // someone said so — never because a malformed row was ambiguous.
    privacy: obj.privacy === true,
    nodes,
    edges,
    updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : Date.now(),
  };
}
