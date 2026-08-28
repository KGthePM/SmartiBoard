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
  nodes: IdeaNode[];
  edges: Edge[];
  updatedAt: number;
};

/** Renames are stored, not typed at, so a generous cap is enough. */
export const TITLE_MAX = 120;

export const NODE_W = 200;
export const NODE_H = 96;

let counter = 0;

export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

export function emptyBoard(id: string): Board {
  return { id, title: '', nodes: [], edges: [], updatedAt: Date.now() };
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
    nodes,
    edges,
    updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : Date.now(),
  };
}
