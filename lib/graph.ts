/**
 * The board is a typed graph, not a drawing surface. Everything else —
 * rendering, persistence, and especially the AI behavior — is downstream of
 * these types.
 */

import { normalizeReactions, type ReactionKey } from './reactions';

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
  /**
   * The card's text size, one of NODE_FONT_STEPS. Unlike `done` this is pure
   * presentation — the model never sees it, so it never joins the fingerprint
   * and changing it never spends a token. See the resize doctrine in the store.
   */
  fontSize: number;
  layer: Layer;
  /**
   * The whiteboard's crossed-off idea. Unlike size or formatting this is
   * content the model sees, so it joins the fingerprint — see lib/ai/trigger.
   */
  done: boolean;
  /**
   * How the person feels about this idea — see ./reactions. The exact inverse
   * of `done`: a deliberate mark the model never sees, so it stays out of the
   * fingerprint and out of the prompt, and toggling one never spends a token.
   */
  reactions: ReactionKey[];
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

/**
 * The card text size ladder. Discrete rungs, not a free slider: a handful of
 * readable sizes is all a whiteboard needs, and fixed steps keep the clamp in
 * parseBoard total — any junk off the wire lands on a real size or the default.
 * 14 is the body font, so a card that was never touched renders exactly as it
 * always did.
 */
export const NODE_FONT_STEPS = [12, 14, 17, 21, 26] as const;
export const NODE_FONT_DEFAULT: number = NODE_FONT_STEPS[1];

/** One rung up or down; the ends hold, so a bored click cannot run away. */
export function stepFontSize(current: number, dir: 1 | -1): number {
  let i = NODE_FONT_STEPS.indexOf(current as (typeof NODE_FONT_STEPS)[number]);
  if (i < 0) return NODE_FONT_DEFAULT;
  i = Math.min(NODE_FONT_STEPS.length - 1, Math.max(0, i + dir));
  return NODE_FONT_STEPS[i];
}

/** A stored size back onto the ladder: exact rungs pass, near ones snap, junk defaults. */
export function snapFontSize(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return NODE_FONT_DEFAULT;
  return NODE_FONT_STEPS.reduce((best, s) =>
    Math.abs(s - v) < Math.abs(best - v) ? s : best,
  );
}

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
    fontSize: partial.fontSize ?? NODE_FONT_DEFAULT,
    layer: partial.layer ?? 'user',
    done: partial.done ?? false,
    reactions: partial.reactions ?? [],
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

/**
 * Removing several nodes at once — their edges go with them, and an edge
 * between two survivors stays. One deliberate action (the multi-delete) must
 * be one board rewrite, not a filter pass per card.
 */
export function removeNodes(board: Board, ids: Iterable<NodeId>): Board {
  const gone = new Set(ids);
  return {
    ...board,
    nodes: board.nodes.filter((n) => !gone.has(n.id)),
    edges: board.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)),
  };
}

/**
 * Which cards a marquee sweep touches. Intersection, not containment: a band
 * across the middle of a board should take the cards it crosses.
 */
export function nodesInRect(
  board: Board,
  rect: Rect,
  /**
   * What each card actually occupies. Defaults to the node's own box; the
   * canvas passes `viewRect` so a sweep over the blank space below a folded
   * done card (v2.8) does not catch it by its full-size ghost.
   */
  rectFor: (n: IdeaNode) => Rect = rectOf,
): NodeId[] {
  return board.nodes.filter((n) => intersects(rectFor(n), rect)).map((n) => n.id);
}

export type Rect = { x: number; y: number; w: number; h: number };

/* ---------- presentation ---------- */

/** The canvas camera: where the world sits on screen. */
export type Viewport = { x: number; y: number; scale: number };

/** The wheel's zoom range — what a fit gives, the wheel must be able to keep. */
export const VIEW_MIN_SCALE = 0.25;
export const VIEW_MAX_SCALE = 2.5;

/** Screen breathing room around a fitted board, so cards don't kiss the edge. */
export const FIT_PAD = 80;

/**
 * The camera that fits every card on screen, centered — presentation mode's
 * opening frame. Pure geometry over the union of node rects; an empty board
 * has nothing to frame, so it gets the origin at rest. The scale is clamped
 * to the wheel's range so the fitted view is one the presenter can still
 * adjust, not a zoom level the canvas would immediately fight.
 */
export function fitViewport(
  nodes: IdeaNode[],
  surface: { w: number; h: number },
  pad = FIT_PAD,
): Viewport {
  const bounds = unionRect(nodes);
  if (!bounds) return { x: 0, y: 0, scale: 1 };

  const availW = Math.max(1, surface.w - pad * 2);
  const availH = Math.max(1, surface.h - pad * 2);
  const raw = Math.min(availW / bounds.w, availH / bounds.h);
  const scale = Math.min(VIEW_MAX_SCALE, Math.max(VIEW_MIN_SCALE, raw));

  return {
    scale,
    x: (surface.w - bounds.w * scale) / 2 - bounds.x * scale,
    y: (surface.h - bounds.h * scale) / 2 - bounds.y * scale,
  };
}

/**
 * The camera that puts a rect in the middle of the surface at the scale you are
 * already at. Deliberately not `fitViewport([node], …)`, which would zoom one
 * card up to fill the screen: bringing a search match into view must not also
 * change how far in you are standing.
 */
export function centerOn(rect: Rect, surface: { w: number; h: number }, scale: number): Viewport {
  return {
    scale,
    x: surface.w / 2 - (rect.x + rect.w / 2) * scale,
    y: surface.h / 2 - (rect.y + rect.h / 2) * scale,
  };
}

/** The on-screen region, expressed in board coordinates. */
export function visibleRect(v: Viewport, surface: { w: number; h: number }): Rect {
  return { x: -v.x / v.scale, y: -v.y / v.scale, w: surface.w / v.scale, h: surface.h / v.scale };
}

/**
 * Whether `inner` sits entirely inside `outer`. The companion to `intersects`:
 * a card half off the edge of the screen is visible by intersection but is not
 * something you can read, so "do I need to move the camera" asks this instead.
 */
export function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

export function rectOf(n: Pick<IdeaNode, 'x' | 'y' | 'w' | 'h'>): Rect {
  return { x: n.x, y: n.y, w: n.w, h: n.h };
}

/**
 * The bounding box of every card, or null when there are none. The shared
 * measure behind "show the whole board" — the presentation fit on screen and
 * the print plan on paper both frame exactly this.
 */
export function unionRect(nodes: IdeaNode[]): Rect | null {
  if (nodes.length === 0) return null;
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.w));
  const maxY = Math.max(...nodes.map((n) => n.y + n.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
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
 * Validates and normalizes untrusted board JSON coming off the wire. Anything
 * malformed is dropped rather than thrown. Persisted rows use the stricter
 * parsePersistedBoard contract so disk corruption cannot become data loss.
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
            // Boards saved before text sizes existed load at the default, and
            // anything off the ladder snaps onto it — see snapFontSize.
            fontSize: snapFontSize(n.fontSize),
            layer: n.layer === 'accepted' ? 'accepted' : 'user',
            // Boards saved before done existed load as not done, and anything
            // that is not strictly true is junk off the wire.
            done: n.done === true,
            // Boards saved before reactions existed load without any, and
            // unknown keys are dropped rather than rendered as a blank chip.
            reactions: normalizeReactions(n.reactions),
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
