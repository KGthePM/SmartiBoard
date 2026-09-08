import { distance, midpoint, zoomAround, clampScale, type Point } from './gesture';
import type { Viewport } from './graph';

/**
 * Project Jarvis: hand gestures, as arithmetic.
 *
 * The webcam never reaches React state. A loop feeds filtered landmark
 * positions in, and this module answers with the viewport/cursor changes a
 * mouse could have made — nothing a pointer device could not already do, per
 * the Touch doctrine. The math is pure so the rules are testable and the
 * component stays a thin translation of landmarks into them, exactly the
 * division `lib/gesture.ts` drew for touch.
 */

/** A press this long while pinched selects what is under the pinch. */
export const JARVIS_DWELL_MS = 450;

/**
 * How long a missing hand is forgiven: the cursor stays up and an active pan
 * holds through a dropped frame or two instead of blinking off or ending the
 * drag. Chosen to cover MediaPipe's occasional single-frame detection gaps
 * without feeling like a stuck cursor when the hand really leaves.
 */
export const HAND_LOST_GRACE_MS = 250;

/** True while `nowMs` is within `graceMs` of the last frame a hand was seen. */
export function handPresent(
  lastSeenMs: number | null,
  nowMs: number,
  graceMs = HAND_LOST_GRACE_MS,
): boolean {
  return lastSeenMs !== null && nowMs - lastSeenMs <= graceMs;
}

/** Presence machine: `mark()` each frame a hand is detected, `present()` otherwise. */
export class HandPresence {
  private lastSeen: number | null = null;

  mark(nowMs: number): void {
    this.lastSeen = nowMs;
  }

  present(nowMs: number, graceMs = HAND_LOST_GRACE_MS): boolean {
    return handPresent(this.lastSeen, nowMs, graceMs);
  }

  reset(): void {
    this.lastSeen = null;
  }
}

/**
 * Pinch detection with hysteresis, in units of hand size (wrist to
 * middle-MCP distance). Absolute pixel distances drift with camera distance;
 * hand size does not, so "closed" is a fraction of your own hand.
 */
export const PINCH_ON = 0.35;
export const PINCH_OFF = 0.55;

/**
 * The One Euro filter (Casiez, Roussel & Vogel, CHI 2012) — adaptive jitter
 * killing: hard at rest, open at speed, so pans are not punished with lag.
 * One filter per axis on the derived cursor point, not on the 21 landmarks.
 */
export class OneEuro {
  private prev: Point | null = null;
  private prevD: Point | null = null;
  private t: number | undefined;

  constructor(
    private minCutoff = 1.0,
    private beta = 0.02,
    private dCutoff = 1.0,
  ) {}

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(p: Point, tMs: number): Point {
    if (!this.prev || this.t === undefined || !this.prevD) {
      this.prev = p;
      this.prevD = { x: 0, y: 0 };
      this.t = tMs;
      return p;
    }
    const dt = Math.max((tMs - this.t) / 1000, 1e-6);
    const d: Point = { x: (p.x - this.prev.x) / dt, y: (p.y - this.prev.y) / dt };
    const ad = this.alpha(this.dCutoff, dt);
    const fd: Point = {
      x: this.prevD.x + ad * (d.x - this.prevD.x),
      y: this.prevD.y + ad * (d.y - this.prevD.y),
    };
    const cutoff = this.minCutoff + this.beta * Math.hypot(fd.x, fd.y);
    const a = this.alpha(cutoff, dt);
    const out: Point = {
      x: this.prev.x + a * (p.x - this.prev.x),
      y: this.prev.y + a * (p.y - this.prev.y),
    };
    this.prev = out;
    this.prevD = fd;
    this.t = tMs;
    return out;
  }

  reset(): void {
    this.prev = null;
    this.prevD = null;
    this.t = undefined;
  }
}

/** The two landmarks a pinch is measured between. */
export type PinchLandmarks = { thumb: Point; index: Point; wrist: Point; middleMcp: Point };

/** Raw pinch state derived from one frame's landmarks. */
export function pinchState(l: PinchLandmarks): number {
  const handSize = distance(l.wrist, l.middleMcp);
  if (handSize <= 0) return 1;
  return distance(l.thumb, l.index) / handSize;
}

/** Hysteresis machine: pinch reads on only after it has read off. */
export class PinchDetector {
  private on = false;

  update(ratio: number): boolean {
    if (!this.on && ratio < PINCH_ON) this.on = true;
    else if (this.on && ratio > PINCH_OFF) this.on = false;
    return this.on;
  }

  get isOn(): boolean {
    return this.on;
  }
}

/** What the cursor remembers between frames while pinching. */
export type DragStart = {
  /** Surface coordinates of the cursor when the pinch closed. */
  at: Point;
  /** The viewport as it stood. */
  viewport: Viewport;
};

/**
 * The viewport for a closed pinch at `cursor`, relative to where it closed.
 *
 * An open hand pans nothing — only a pinched hand moves the board, so a
 * stretch or a wander never drags the canvas by accident. The math is the
 * plain drag: translate the viewport by the cursor's travel in surface
 * pixels.
 */
export function panViewport(start: DragStart, cursor: Point): Viewport {
  return {
    scale: start.viewport.scale,
    x: start.viewport.x + (cursor.x - start.at.x),
    y: start.viewport.y + (cursor.y - start.at.y),
  };
}

/**
 * The viewport for a pinch held while the second consideration applies:
 * zoom. Jarvis zooms by *holding* the pinch and dwelling — but for v1 the
 * closed pinch is one gesture only (pan), and zoom stays on the wheel and
 * touch pinch. Kept here so the doctrine has one home when zoom-by-hand
 * lands: always through `zoomAround`, anchored under the cursor.
 */
export function handZoomViewport(v: Viewport, at: Point, ratio: number): Viewport {
  return zoomAround(v, at, clampScale(v.scale * ratio));
}

/** The gain `mapToSurface` ships with, and the middle rung of the sensitivity ladder. */
export const JARVIS_DEFAULT_GAIN = 1.6;

/** The sensitivity rungs the Settings panel offers, low (1:1) to high. */
export const JARVIS_GAIN_STEPS = [1.0, 1.3, JARVIS_DEFAULT_GAIN, 2.0, 2.5] as const;

/**
 * Snap a stored/typed gain onto the ladder. Off-ladder junk lands on the
 * nearest rung rather than failing — the same doctrine as
 * `normalizeGhostDelay`: a preference must never wedge the feature it rides
 * in with. Non-finite input (a corrupted or absent localStorage value) takes
 * the default.
 */
export function normalizeJarvisGain(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return JARVIS_DEFAULT_GAIN;
  let best = JARVIS_GAIN_STEPS[0] as number;
  for (const step of JARVIS_GAIN_STEPS) {
    if (Math.abs(step - v) < Math.abs(best - v)) best = step;
  }
  return best;
}

/**
 * How deep inside the camera frame the hand sits, 0 at the edge to 1 fully in.
 *
 * A band of `band` (the same 15% `mapToSurface`'s margin uses) from each edge
 * fades linearly, so the cursor dims as tracking is about to drop — the
 * affordance Ultraleap ships, computed from the RAW landmark before any
 * mapping so it answers "where in the frame is the hand", not "where on the
 * board is the cursor".
 */
export function edgeFactor(p: Point, band = 0.15): number {
  const d = Math.min(p.x, 1 - p.x, p.y, 1 - p.y);
  return Math.min(1, Math.max(0, d / band));
}

/**
 * Cursor position in surface coordinates from a filtered landmark point.
 *
 * The hand's normalized camera-space x/y (0..1) maps to the surface with a
 * margin, x mirrored: the camera sees the room as an onlooker does, but the
 * user reads their own hand as in a mirror — hand left must move the cursor
 * left. Kyle's phase-1 live test found the direct mapping backwards in
 * practice, so x is flipped (1 - nx) before gain; y is untouched. The margin
 * keeps the board reachable without sweeping to the frame's edge, and lets a
 * small hand motion cover the whole surface (gain).
 */
export function mapToSurface(
  p: Point,
  surface: { w: number; h: number },
  gain = JARVIS_DEFAULT_GAIN,
  margin = 0.15,
): Point {
  const span = 1 - 2 * margin;
  const nx = Math.min(1, Math.max(0, (p.x - margin) / span));
  const ny = Math.min(1, Math.max(0, (p.y - margin) / span));
  // Gain > 1 deliberately overshoots the frame's reach — a small hand motion
  // covers the whole surface — so the result is clamped to the surface.
  return {
    x: Math.min(surface.w, Math.max(0, (0.5 + (1 - nx - 0.5) * gain) * surface.w)),
    y: Math.min(surface.h, Math.max(0, (0.5 + (ny - 0.5) * gain) * surface.h)),
  };
}
