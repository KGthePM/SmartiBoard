import {
  NODE_H,
  NODE_W,
  intersects,
  rectOf,
  type Board,
  type IdeaNode,
  type NodeId,
  type Rect,
} from './graph';

const PAD = 16;
const STEP = 40;
const MAX_RINGS = 24;
const POINTS_PER_RING = 12;

/**
 * Where does the ghost go?
 *
 * Three constraints, in priority order:
 *  1. It must not occlude anything the user placed.
 *  2. It must be on screen. A suggestion outside the viewport is not a subtle
 *     suggestion, it is an invisible one — strictly worse than none, because
 *     the ceiling of one live proposal then blocks the next one too.
 *  3. It must land near what it is talking about; a suggestion across the board
 *     from its subject reads as unrelated noise.
 *
 * Strategy: spiral outward from the centroid of the anchor nodes and take the
 * first clear position. Run the spiral twice — once requiring the candidate to
 * be fully visible, then again without that requirement — so visibility wins
 * over proximity, but proximity still decides among visible spots.
 */
export function placeProposal(
  board: Board,
  anchors: NodeId[],
  size: { w: number; h: number } = { w: NODE_W, h: NODE_H },
  /** Visible region in board coordinates. Omit to ignore the viewport. */
  visible?: Rect,
  /**
   * What each card actually occupies. Defaults to the node's own box; the
   * canvas passes `viewRect` so a folded done card (v2.8) is avoided at its
   * stub height instead of at the full box it is not currently drawing — the
   * ghost must not detour around space that is plainly empty on screen.
   */
  rectFor: (n: IdeaNode) => Rect = rectOf,
): { x: number; y: number } {
  const obstacles = board.nodes.map(rectFor);
  const origin = centroid(board, anchors, rectFor);
  const start = { x: origin.x - size.w / 2, y: origin.y - size.h / 2 };

  const found =
    (visible ? spiral(start, size, obstacles, visible) : null) ??
    spiral(start, size, obstacles, undefined);

  return found ?? fallback(board, size);
}

function spiral(
  start: { x: number; y: number },
  size: { w: number; h: number },
  obstacles: Rect[],
  visible: Rect | undefined,
): { x: number; y: number } | null {
  for (let ring = 0; ring <= MAX_RINGS; ring += 1) {
    const radius = ring * STEP;
    const points = ring === 0 ? 1 : POINTS_PER_RING;

    for (let i = 0; i < points; i += 1) {
      // Offset each ring's starting angle so candidates don't stack on one axis.
      const angle = (i / points) * Math.PI * 2 + ring * 0.4;
      const candidate: Rect = {
        x: start.x + Math.cos(angle) * radius,
        y: start.y + Math.sin(angle) * radius,
        w: size.w,
        h: size.h,
      };
      if (!isClear(candidate, obstacles)) continue;
      if (visible && !isWithin(candidate, visible)) continue;
      return { x: Math.round(candidate.x), y: Math.round(candidate.y) };
    }
  }
  return null;
}

/**
 * Fully inside, with room for the accept/dismiss buttons that hang below the
 * card and the rationale tooltip that sits above it.
 */
function isWithin(candidate: Rect, visible: Rect): boolean {
  const CHROME = 28;
  return (
    candidate.x >= visible.x + PAD &&
    candidate.y >= visible.y + CHROME &&
    candidate.x + candidate.w <= visible.x + visible.w - PAD &&
    candidate.y + candidate.h <= visible.y + visible.h - CHROME
  );
}

function isClear(candidate: Rect, obstacles: Rect[]): boolean {
  return !obstacles.some((o) => intersects(candidate, o, PAD));
}

function centroid(
  board: Board,
  anchors: NodeId[],
  rectFor: (n: IdeaNode) => Rect,
): { x: number; y: number } {
  const anchored = board.nodes.filter((n) => anchors.includes(n.id));
  const pool = anchored.length > 0 ? anchored : board.nodes;
  if (pool.length === 0) return { x: 0, y: 0 };

  let sx = 0;
  let sy = 0;
  for (const n of pool) {
    const r = rectFor(n);
    sx += r.x + r.w / 2;
    sy += r.y + r.h / 2;
  }
  return { x: sx / pool.length, y: sy / pool.length };
}

function fallback(board: Board, size: { w: number; h: number }): { x: number; y: number } {
  if (board.nodes.length === 0) return { x: 0, y: 0 };
  const right = Math.max(...board.nodes.map((n) => n.x + n.w));
  const top = Math.min(...board.nodes.map((n) => n.y));
  void size;
  return { x: Math.round(right + STEP + PAD), y: Math.round(top) };
}
