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
