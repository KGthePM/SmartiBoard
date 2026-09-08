import {
  clampScale,
  distance,
  edgeScrollVelocity,
  midpoint,
  scrollViewport,
  zoomAround,
  type Point,
} from './gesture';
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

export type { Point } from './gesture';

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

/* ------------------------------------------------------------------------- *
 * Phase 5 (hand half): edge auto-scroll for the pinch pan.
 *
 * The card-drag half of phase 5 (`lib/gesture.ts`) already answers "how
 * hard is this edge being asked"; the pinch pan asks the same question of
 * the CURSOR. Holding a pinched hand inside EDGE_ZONE_PX of the surface's
 * edge keeps the board panning that way, so a large board is traversed in
 * ONE pinch — the cursor itself never moves (the board moves under it,
 * exactly as the drag version holds a card under a stationary pointer).
 * The arithmetic is the drag version's, reused, never duplicated; the only
 * new pieces are the mode gate and the dt-capped integration step.
 * ------------------------------------------------------------------------- */

/**
 * The edge auto-scroll velocity for a pinch pan in progress.
 *
 * `panning` is the loop's gate — a live ONE-hand pinch pan, which excludes
 * the pinch being released AND the two-hand zoom (zoom owns the gesture,
 * phase 4; the post-zoom cooldown blocks pan with it). Gated off, the
 * answer is zero everywhere; gated on, it is `edgeScrollVelocity` INVERTED
 * per axis — a corner runs both, a cursor pinned past the surface bound
 * holds full speed.
 *
 * Why inverted when the drag version is not: a card dragged to the edge
 * asks the edge to REVEAL what lies beyond it, but a pinch is a GRAB. The
 * board follows the hand, so the direction the scroll must continue is the
 * direction of the pull — hand pulling the board down, edge reached,
 * keep the board coming down. Negating the velocity does exactly that
 * (`scrollViewport` maps velocity toward an edge to a viewport move away
 * from it; negated, the viewport chases the hand's pull).
 */
export function pinchEdgeScroll(
  cursor: Point,
  surface: { w: number; h: number },
  panning: boolean,
): Point {
  if (!panning) return { x: 0, y: 0 };
  const vel = edgeScrollVelocity(cursor, surface);
  // `|| 0` normalizes -0 (negating a zero velocity) to +0 — deep equality
  // and Object.is tell them apart, and nobody should have to.
  return { x: -vel.x || 0, y: -vel.y || 0 };
}

/**
 * One integration step of the edge auto-scroll, with the drag version's dt
 * cap: a stalled frame (tab switch, GC pause) may not jump the board — past
 * 100ms the step is computed as if 100ms had passed. Same sign arithmetic
 * as `scrollViewport`: velocity toward the right/bottom edge moves the
 * viewport's translate left.
 */
export function integrateEdgeScroll(v: Viewport, vel: Point, dtMs: number): Viewport {
  return scrollViewport(v, vel.x, vel.y, Math.min(dtMs / 1000, 0.1));
}

/**
 * The single-hand zoom seam: zoom around a point the hand is holding.
 *
 * Phase 4 zooms with TWO hands (see `TwoHandZoom` below); a lone pinched
 * hand remains pan only, so this stands as the seam where a future one-hand
 * zoom would land. Kept and used by its test so the doctrine keeps one
 * home: zoom by hand goes through `zoomAround`, anchored under the gesture.
 */
export function handZoomViewport(v: Viewport, at: Point, ratio: number): Viewport {
  return zoomAround(v, at, clampScale(v.scale * ratio));
}

/* ------------------------------------------------------------------------- *
 * Phase 4: two-hand zoom.
 *
 * Two pinched hands that spread apart are a zoom — the touch pinch's own
 * gesture, done in air. The same doctrine applies as everywhere else in this
 * file: the ratio is taken from an ENTRY baseline, never accumulated per
 * frame, so hands that return to their starting spread return the scale with
 * them and the clamp cannot ratchet.
 * ------------------------------------------------------------------------- */

/**
 * Consecutive frames with both hands pinched before zoom engages. Tuning
 * round 1 kept this at 3: the live test's hard entry traced, in the code
 * path, to a real bug (a second hand entering the frame alone indexed an
 * empty slot and killed the tick — see `update`), not to the count, and the
 * dropout decay below now protects the climb anyway. Lowering to 2 was
 * considered and rejected — with a 2-frame entry the decay rule can never
 * hold partial progress (the count never exceeds 1 while idle), and the
 * live test showed zoom firing *occasionally* already, so a hair-trigger
 * is not the failure mode to encourage.
 */
export const ZOOM_ENTER_FRAMES = 3;

/**
 * Entry-climb forgiveness, in frames of progress lost per frame a hand is
 * MISSING (not seen at all). A detection dropout used to reset the climb to
 * zero, so a hand that blinked for one frame near the top of the count had
 * to start over — measured in the phase-4 live test as the entry that would
 * not fire. Now the count decays by this much per missed frame and keeps
 * climbing when the hand returns. A frame where both hands are SEEN and one
 * is genuinely open still resets to zero — forgiveness is for the tracker,
 * never for a pinch the camera watched open.
 */
export const ZOOM_ENTER_DECAY = 1;

/**
 * After zoom ends, this long passes before a pinch may pan again — so the
 * hand that stays pinched when its partner lets go does not yank the board
 * the instant zoom hands the gesture back.
 */
export const ZOOM_PAN_COOLDOWN_MS = 200;

/**
 * The most the applied zoom may move per frame, in log space (±2% of scale).
 * A rate limit, not a dead zone: a trembling hold hovers at the baseline and
 * zooms nothing, while a deliberate spread still travels — at the tracker's
 * top speed, not the arm's.
 */
export const ZOOM_LOG_STEP_MAX = 0.02;

/** One hand as the loop sees it: pinch midpoint plus the raw pinch ratio. */
export type HandObservation = { mid: Point; ratio: number };

/** A persistent hand slot the tracker matches observations into. */
export type HandSlotState = {
  seen: boolean;
  mid: Point;
  pinching: boolean;
  /** The latest raw pinch ratio the slot's detector was fed (diagnostics). */
  ratio: number;
};

/**
 * Which observation drives each hand's on-screen cursor, by slot.
 *
 * Returns `[obsForHand1, obsForHand2]` — indexes into the frame's
 * observations. Slot 0 falls back to observation 0 when its own hand went
 * unmatched (the primary cursor must follow whichever hand is visible, the
 * phase-3 rule); slot 1's index is −1 when no second hand is tracked this
 * frame. Identity rides the slot machine's `matchHands` proximity, so
 * "hand 1" and "hand 2" stay the same physical hands even when the
 * landmarker swaps its array order. Pure — this is the whole attribution
 * rule the loop uses.
 */
export function cursorObservations(map: number[]): [number, number] {
  const i0 = map.indexOf(0);
  return [i0 === -1 ? 0 : i0, map.indexOf(1)];
}

/** The zoom signal for one frame, relative to the entry baseline. */
export type ZoomFrame = {
  /** exp(applied − baseline): 1 at entry, ~2 after hands spread to double. */
  ratio: number;
  /** The two-hand midpoint in RAW normalized camera coords (not mapped). */
  mid: Point;
};

/**
 * The zoom machine's per-frame readout for the ?jarvis-debug=1 chip — one
 * frame of pure data, no React state: each visible hand's raw pinch ratio,
 * whether both slots read pinched, the entry counter, and the mode (pan /
 * armed = climbing toward entry / zoom / cooldown).
 */
export type ZoomDebugFrame = {
  mode: 'pan' | 'armed' | 'zoom' | 'cooldown';
  both: boolean;
  stable: number;
  ratios: number[];
};

/** Everything the loop needs from the two-hand tracker, per frame. */
export type TwoHandFrame = {
  /** For each observation this frame, the slot index it was matched to. */
  map: number[];
  /** The two persistent slots. `seen` gates everything a slot answers for. */
  slots: [HandSlotState, HandSlotState];
  mode: 'idle' | 'zoom';
  zoom: ZoomFrame | null;
  /** True while zoom owns the gesture or the post-zoom cooldown is running. */
  panBlocked: boolean;
};

/**
 * Assign this frame's hands to the previous frame's, by proximity.
 *
 * MediaPipe's `landmarks[]` order swaps between frames — trusting the index
 * would read hand A's landmarks as hand B's mid-spread and spike the
 * distance. Each next hand goes to its nearest previous hand, greedily
 * closest pair first; the result maps next-index → prev-index.
 */
export function matchHands(prev: Point[], next: Point[]): number[] {
  const result = new Array<number>(next.length).fill(-1);
  const used = new Set<number>();
  const pairs: { d: number; i: number; j: number }[] = [];
  for (let i = 0; i < next.length; i++) {
    for (let j = 0; j < prev.length; j++) {
      pairs.push({ d: distance(next[i], prev[j]), i, j });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  for (const p of pairs) {
    if (result[p.i] !== -1 || used.has(p.j)) continue;
    result[p.i] = p.j;
    used.add(p.j);
  }
  return result;
}

/**
 * Distance between two pinch midpoints, aspect-corrected.
 *
 * MediaPipe normalizes x by frame WIDTH and y by frame HEIGHT, so on 16:9 an
 * uncorrected distance is stretched ~1.8× along x and a horizontal spread
 * reads as far more zoom than the same spread vertically. Multiplying x by
 * width/height puts both axes in the same units before the hypot.
 */
export function zoomDistance(a: Point, b: Point, aspect: number): number {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}

/**
 * The One Euro filter on a scalar — the same adaptive jitter killing as
 * `OneEuro`, one axis fewer. The zoom signal is a single number
 * (ln of the two-hand distance), so it gets a single filter.
 */
export class OneEuroScalar {
  private prev: number | null = null;
  private prevD = 0;
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

  filter(x: number, tMs: number): number {
    if (this.prev === null || this.t === undefined) {
      this.prev = x;
      this.prevD = 0;
      this.t = tMs;
      return x;
    }
    const dt = Math.max((tMs - this.t) / 1000, 1e-6);
    const d = (x - this.prev) / dt;
    this.prevD += this.alpha(this.dCutoff, dt) * (d - this.prevD);
    const a = this.alpha(this.minCutoff + this.beta * Math.abs(this.prevD), dt);
    this.prev += a * (x - this.prev);
    this.t = tMs;
    return this.prev;
  }

  reset(): void {
    this.prev = null;
    this.prevD = 0;
    this.t = undefined;
  }
}

/** What the zoom gesture remembers from the moment it engaged. */
export type ZoomStart = {
  /** The viewport as it stood. */
  viewport: Viewport;
  /** The two-hand midpoint at entry, in surface coordinates. */
  mid: Point;
};

/**
 * The viewport for a two-hand zoom in progress — the touch pinch's
 * zoom-and-pan-jointly semantics (`pinchViewport`) done with hands.
 *
 * The zoom anchors on the START midpoint so the board point between the
 * hands stays between them; the midpoint's travel since entry is added on
 * top. `ratio` arrives already taken from the entry baseline and already
 * rate-limited, so a pinch that unspreads back to where it began hands the
 * scale back exactly, and the clamp cannot ratchet.
 */
export function twoHandZoomViewport(
  start: ZoomStart,
  now: { ratio: number; mid: Point },
): Viewport {
  const zoomed = zoomAround(start.viewport, start.mid, start.viewport.scale * now.ratio);
  return {
    scale: zoomed.scale,
    x: zoomed.x + (now.mid.x - start.mid.x),
    y: zoomed.y + (now.mid.y - start.mid.y),
  };
}

type ZoomTrack = { mid: Point; seen: boolean; pinch: PinchDetector; ratio: number };

/**
 * The two-hand zoom machine: identity, mode, baseline, rate limit.
 *
 * Per frame the loop hands in up to two raw observations and gets back the
 * matched slots, the mode, and (in zoom) the baseline-relative ratio.
 * Pinch hysteresis runs per SLOT, not per observation — the detector a hand
 * feeds must survive the landmarker shuffling its output order, which is
 * what `matchHands` is for. Baseline is taken only at zoom entry, and any
 * dropout ends zoom, so every entry re-baselines: the anti-ratchet rule
 * holds by construction, not by discipline.
 */
export class TwoHandZoom {
  private tracks: ZoomTrack[] = [];
  private mode: 'idle' | 'zoom' = 'idle';
  private stable = 0;
  private dist = new OneEuroScalar();
  private baseline = 0;
  private applied = 0;
  private blockedUntil = -Infinity;
  /** What the entry climb did last frame — the diagnostics chip shows it. */
  private lastFrame: ZoomDebugFrame = { mode: 'pan', both: false, stable: 0, ratios: [] };

  get isZooming(): boolean {
    return this.mode === 'zoom';
  }

  /** The machine's last frame, for the ?jarvis-debug=1 readout. Pure data. */
  get debugFrame(): ZoomDebugFrame {
    return this.lastFrame;
  }

  update(obs: HandObservation[], aspect: number, nowMs: number): TwoHandFrame {
    const map: number[] = [];
    if (obs.length === 0) {
      // Nothing seen: the slots die — a hand re-entering anywhere must seed
      // fresh, not match a stale midpoint — and zoom ends, which is also the
      // re-baseline after dropout: the next entry measures the distance anew.
      this.tracks = [];
      if (this.mode === 'zoom') this.exitZoom(nowMs);
      this.stable = Math.max(0, this.stable - ZOOM_ENTER_DECAY);
    } else if (this.tracks.length === 0) {
      this.tracks = obs.slice(0, 2).map((o) => ({
        mid: o.mid,
        seen: true,
        pinch: new PinchDetector(),
        ratio: o.ratio,
      }));
      for (let i = 0; i < this.tracks.length; i++) {
        this.tracks[i].pinch.update(obs[i].ratio);
        map[i] = i;
      }
    } else {
      for (const tr of this.tracks) tr.seen = false;
      const assign = matchHands(
        this.tracks.map((tr) => tr.mid),
        obs.map((o) => o.mid),
      );
      for (let i = 0; i < obs.length; i++) {
        let j = assign[i];
        if (j === -1 && this.tracks.length < 2) {
          // A hand the previous frame never saw — the common case is a
          // second hand entering the frame while one is already tracked. It
          // gets a FRESH SLOT with its own PinchDetector, or both-pinched
          // would be literally unenterable until both hands left the frame
          // and returned together. (This used to index tracks[-1] and throw
          // every frame — the phase-4 live test's "zoom won't fire".)
          this.tracks.push({
            mid: obs[i].mid,
            seen: true,
            pinch: new PinchDetector(),
            ratio: obs[i].ratio,
          });
          j = this.tracks.length - 1;
        }
        const tr = this.tracks[j];
        if (!tr) continue; // More hands than slots: the extra is dropped.
        tr.seen = true;
        tr.mid = obs[i].mid;
        tr.pinch.update(obs[i].ratio);
        tr.ratio = obs[i].ratio;
        map[i] = j;
      }
    }

    const state = (i: number): HandSlotState =>
      this.tracks[i]
        ? {
            seen: this.tracks[i].seen,
            mid: this.tracks[i].mid,
            pinching: this.tracks[i].pinch.isOn,
            ratio: this.tracks[i].ratio,
          }
        : { seen: false, mid: { x: 0, y: 0 }, pinching: false, ratio: 1 };
    const s0 = state(0);
    const s1 = state(1);
    const both = s0.seen && s1.seen && s0.pinching && s1.pinching;

    let zoom: ZoomFrame | null = null;
    if (this.mode === 'idle') {
      if (both) {
        this.stable += 1;
      } else if (s0.seen && s1.seen) {
        // Both hands visible and at least one genuinely open: a real miss,
        // the count starts over. Forgiveness (the decay above) is only for
        // frames the tracker dropped the hand from entirely.
        this.stable = 0;
      } else {
        // A hand blinked out of detection mid-climb: lose one frame of
        // progress, not the whole count. The ENTER condition itself stays
        // honest — zoom engages on a both-seen, both-pinched frame only.
        this.stable = Math.max(0, this.stable - ZOOM_ENTER_DECAY);
      }
      if (this.stable >= ZOOM_ENTER_FRAMES) {
        this.mode = 'zoom';
        // Entry baseline: reset filter, feed the entry distance — the first
        // call passes it through, so baseline IS the entry measurement and
        // the ratio starts at exactly 1.
        this.dist.reset();
        this.baseline = this.dist.filter(Math.log(zoomDistance(s0.mid, s1.mid, aspect)), nowMs);
        this.applied = 0;
      }
    }
    if (this.mode === 'zoom') {
      if (!both) {
        // Either pinch released, or a hand dropped out. Cooldown gates pan.
        this.exitZoom(nowMs);
      } else {
        const target = Math.log(zoomDistance(s0.mid, s1.mid, aspect));
        const s = this.dist.filter(target, nowMs);
        // Walk `applied` toward the measured log distance, at most
        // ZOOM_LOG_STEP_MAX per frame — always measured from the baseline,
        // never added onto the previous ratio.
        const delta = Math.max(
          -ZOOM_LOG_STEP_MAX,
          Math.min(ZOOM_LOG_STEP_MAX, s - this.baseline - this.applied),
        );
        this.applied += delta;
        zoom = { ratio: Math.exp(this.applied), mid: midpoint(s0.mid, s1.mid) };
      }
    }

    // The readout, one object per frame — the chip reads it through
    // Board's paint rAF; nothing here reaches React state.
    const nowMode: ZoomDebugFrame['mode'] =
      this.mode === 'zoom'
        ? 'zoom'
        : nowMs < this.blockedUntil
          ? 'cooldown'
          : this.stable > 0
            ? 'armed'
            : 'pan';
    this.lastFrame = {
      mode: nowMode,
      both,
      stable: Math.min(this.stable, ZOOM_ENTER_FRAMES),
      ratios: [s0.ratio, s1.ratio],
    };

    return {
      map,
      slots: [s0, s1],
      mode: this.mode,
      zoom,
      panBlocked: this.mode === 'zoom' || nowMs < this.blockedUntil,
    };
  }

  private exitZoom(nowMs: number): void {
    this.mode = 'idle';
    this.stable = 0;
    this.blockedUntil = nowMs + ZOOM_PAN_COOLDOWN_MS;
  }
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
