import { VIEW_MAX_SCALE, VIEW_MIN_SCALE, type Viewport } from './graph';

/**
 * Touch gestures, as arithmetic.
 *
 * The canvas is on Pointer Events already, so a finger drags a card the same way
 * a mouse does and nothing here is needed for that. What a finger cannot do is
 * the two things a mouse gets from hardware: the wheel, and the Shift key. This
 * module is the answer to both, kept pure so the rules are testable and the
 * component stays a thin translation of events into them.
 */

export type Point = { x: number; y: number };

/** A press this long without moving means what Shift means. */
export const LONG_PRESS_MS = 450;

/**
 * How far a pointer must travel before a press counts as a gesture rather than
 * a click. It decides three things that are really the same thing: whether a
 * card drag was a drag, whether the surface takes the pointer capture, and
 * whether the click that ends a press on a folded dot opens it.
 */
export const DRAG_SLOP = 3;

/**
 * How far a pointer may wander and still count as a press rather than a drag.
 * Deliberately larger than the canvas's 3px click-vs-drag threshold: a finger
 * resting on glass drifts in a way a mouse on a desk does not, and holding
 * still for 450ms is when it drifts most.
 */
export const LONG_PRESS_SLOP = 10;

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function clampScale(scale: number): number {
  return Math.min(VIEW_MAX_SCALE, Math.max(VIEW_MIN_SCALE, scale));
}

/**
 * Zoom to `scale`, keeping the board point currently under `at` still under it.
 *
 * This is the one piece of viewport algebra in the app, and both zoom gestures
 * are it: the wheel calls it with the cursor and a fixed 8% step, a pinch calls
 * it with the midpoint and the ratio of finger spread. `at` is in surface
 * coordinates — client pixels minus the surface's top-left — because that is
 * the space `.world`'s transform lives in.
 */
export function zoomAround(v: Viewport, at: Point, scale: number): Viewport {
  const next = clampScale(scale);
  return {
    scale: next,
    x: at.x - ((at.x - v.x) / v.scale) * next,
    y: at.y - ((at.y - v.y) / v.scale) * next,
  };
}

/** What a pinch remembers from the moment the second finger landed. */
export type PinchStart = {
  /** Distance between the two pointers, in client pixels. */
  dist: number;
  /** Their midpoint, in surface coordinates. */
  mid: Point;
  /** The viewport as it stood. */
  viewport: Viewport;
};

/**
 * Edge auto-scroll: the drag that reaches for the edge takes the board with it.
 *
 * Holding a card (a marquee, a connect line, a resize) within `EDGE_ZONE_PX` of
 * the surface's edge pans the viewport, so a board bigger than the screen stays
 * draggable across it. As arithmetic it is one question per axis — how hard is
 * the pointer asking this edge to give way — answered here, pure and tested.
 */

/** How close to the edge a drag must hold before the board starts giving way. */
export const EDGE_ZONE_PX = 56;

/**
 * The speed at the very edge, in surface px per second. Inside the zone the
 * speed ramps linearly from zero at the zone's inner boundary to this at the
 * edge itself, so brushing the edge drifts and pinning against it travels.
 */
export const EDGE_MAX_SPEED = 900;

/**
 * The auto-scroll velocity for a pointer at surface pixel `p` on a
 * `surface`-sized canvas: zero more than `zone` from every edge, ramping
 * linearly to `maxSpeed` at each edge — per axis, independently, so a corner
 * asks both at once. A pointer carried past the edge (pointer capture lets it
 * leave the surface) holds full speed rather than ramping back down. A
 * negative velocity means the left/top edge; positive, right/bottom.
 */
export function edgeScrollVelocity(
  p: Point,
  surface: { w: number; h: number },
  zone = EDGE_ZONE_PX,
  maxSpeed = EDGE_MAX_SPEED,
): Point {
  const axis = (at: number, span: number): number => {
    if (!(span > 0) || !(zone > 0)) return 0;
    const nearLeft = at < zone;
    const nearRight = span - at < zone;
    if (!nearLeft && !nearRight) return 0;
    const t = nearLeft ? 1 - at / zone : 1 - (span - at) / zone;
    return (nearLeft ? -1 : 1) * Math.min(1, Math.max(0, t)) * maxSpeed;
  };
  return { x: axis(p.x, surface.w), y: axis(p.y, surface.h) };
}

/**
 * The viewport after one auto-scroll step: `v` is the velocity from
 * `edgeScrollVelocity`, `dt` the seconds since the last step. Panning right
 * (toward content off the right edge) moves the viewport's translate left —
 * the same arithmetic the drag-pan's client deltas produce, one integration
 * step of it.
 */
export function scrollViewport(v: Viewport, vx: number, vy: number, dt: number): Viewport {
  return { scale: v.scale, x: v.x - vx * dt, y: v.y - vy * dt };
}

/**
 * The viewport for a pinch in progress.
 *
 * A pinch zooms *and* pans, because two fingers that spread while sliding are
 * doing both and splitting them would make the board slip out from under them.
 * The zoom is anchored on the starting midpoint so the board point pinched
 * stays pinched; the translation of the midpoint since then is then added on
 * top. Scaling from the *start* rather than accumulating per-frame ratios means
 * a pinch that returns to where it began returns the viewport with it, and the
 * clamp cannot ratchet.
 *
 * A degenerate start (two pointers at the same place) would divide by zero, so
 * it holds the scale and pans only.
 */
export function pinchViewport(start: PinchStart, now: { dist: number; mid: Point }): Viewport {
  const ratio = start.dist > 0 ? now.dist / start.dist : 1;
  const zoomed = zoomAround(start.viewport, start.mid, start.viewport.scale * ratio);
  return {
    scale: zoomed.scale,
    x: zoomed.x + (now.mid.x - start.mid.x),
    y: zoomed.y + (now.mid.y - start.mid.y),
  };
}
