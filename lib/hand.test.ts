import { describe, expect, it } from 'vitest';
import { EDGE_MAX_SPEED, EDGE_ZONE_PX, edgeScrollVelocity } from './gesture';
import type { Viewport } from './graph';
import { VIEW_MAX_SCALE, VIEW_MIN_SCALE } from './graph';
import {
  HAND_LOST_GRACE_MS,
  JARVIS_DEFAULT_GAIN,
  PINCH_OFF,
  PINCH_ON,
  ZOOM_ENTER_DECAY,
  ZOOM_ENTER_FRAMES,
  ZOOM_LOG_STEP_MAX,
  ZOOM_PAN_COOLDOWN_MS,
  OneEuro,
  OneEuroScalar,
  PinchDetector,
  HandPresence,
  TwoHandZoom,
  cursorObservations,
  edgeFactor,
  handPresent,
  handZoomViewport,
  integrateEdgeScroll,
  mapToSurface,
  matchHands,
  normalizeJarvisGain,
  panViewport,
  pinchEdgeScroll,
  pinchState,
  twoHandZoomViewport,
  zoomDistance,
} from './hand';

const v = (x: number, y: number, scale: number): Viewport => ({ x, y, scale });

describe('OneEuro', () => {
  it('passes the first sample through untouched', () => {
    const f = new OneEuro();
    expect(f.filter({ x: 10, y: 20 }, 0)).toEqual({ x: 10, y: 20 });
  });

  it('kills jitter at rest and follows motion', () => {
    const rest = new OneEuro();
    rest.filter({ x: 100, y: 100 }, 0);
    // A noisy hand at rest: samples oscillating ±5px around 100.
    let last = { x: 100, y: 100 };
    for (let i = 1; i <= 30; i++) {
      last = rest.filter({ x: 100 + (i % 2 ? 5 : -5), y: 100 + (i % 2 ? -5 : 5) }, i * 33);
    }
    expect(Math.abs(last.x - 100)).toBeLessThan(3);
    expect(Math.abs(last.y - 100)).toBeLessThan(3);

    const moving = new OneEuro();
    moving.filter({ x: 0, y: 0 }, 0);
    // A fast steady pan: 16px/frame ≈ 480px/s must keep up, not lag behind.
    let cur = { x: 0, y: 0 };
    for (let i = 1; i <= 30; i++) {
      cur = moving.filter({ x: i * 16, y: 0 }, i * 33);
    }
    expect(cur.x).toBeGreaterThan(30 * 16 * 0.9);
  });

  it('reset makes the next sample a first sample', () => {
    const f = new OneEuro();
    f.filter({ x: 0, y: 0 }, 0);
    f.reset();
    expect(f.filter({ x: 50, y: 50 }, 1000)).toEqual({ x: 50, y: 50 });
  });
});

describe('pinchState', () => {
  const l = (thumbDist: number) => ({
    thumb: { x: 0, y: 0 },
    index: { x: thumbDist, y: 0 },
    wrist: { x: 0, y: 0 },
    middleMcp: { x: 0, y: 1 },
  });

  it('scales thumb-index distance by hand size', () => {
    expect(pinchState(l(0.5))).toBe(0.5);
  });

  it('survives a degenerate hand (zero size)', () => {
    const flat = {
      thumb: { x: 3, y: 0 },
      index: { x: 0, y: 0 },
      wrist: { x: 0, y: 0 },
      middleMcp: { x: 0, y: 0 },
    };
    expect(pinchState(flat)).toBe(1);
  });
});

describe('PinchDetector', () => {
  it('closes below PINCH_ON and opens above PINCH_OFF', () => {
    const d = new PinchDetector();
    expect(d.update(1.0)).toBe(false);
    expect(d.update(PINCH_ON - 0.01)).toBe(true);
    // Between the thresholds the state holds — that is the hysteresis.
    expect(d.update(PINCH_OFF - 0.01)).toBe(true);
    expect(d.update(PINCH_OFF + 0.01)).toBe(false);
  });

  it('does not flicker on a boundary-cruising ratio', () => {
    const d = new PinchDetector();
    d.update(1.0);
    d.update(PINCH_ON - 0.02);
    for (let i = 0; i < 10; i++) {
      d.update(PINCH_ON + 0.01);
      d.update(PINCH_ON - 0.01);
    }
    expect(d.isOn).toBe(true);
  });
});

describe('panViewport', () => {
  it('translates the viewport by the cursor travel', () => {
    const start = { at: { x: 400, y: 300 }, viewport: v(0, 0, 1) };
    const out = panViewport(start, { x: 340, y: 350 });
    expect(out).toEqual({ x: -60, y: 50, scale: 1 });
  });

  it('never changes scale', () => {
    const start = { at: { x: 0, y: 0 }, viewport: v(10, 20, 0.7) };
    expect(panViewport(start, { x: 99, y: -3 }).scale).toBe(0.7);
  });

  it('is a no-op when the hand holds still', () => {
    const start = { at: { x: 5, y: 5 }, viewport: v(-3, 8, 1.2) };
    expect(panViewport(start, { x: 5, y: 5 })).toEqual(start.viewport);
  });
});

describe('handZoomViewport', () => {
  it('delegates to zoomAround and holds the clamp', () => {
    const out = handZoomViewport(v(0, 0, 2.4), { x: 100, y: 100 }, 1.5);
    expect(out.scale).toBe(VIEW_MAX_SCALE);
    const in_ = handZoomViewport(v(0, 0, 0.26), { x: 100, y: 100 }, 0.5);
    expect(in_.scale).toBe(VIEW_MIN_SCALE);
  });
});

describe('mapToSurface', () => {
  const surface = { w: 1000, h: 500 };

  it('centers the neutral hand', () => {
    expect(mapToSurface({ x: 0.5, y: 0.5 }, surface)).toEqual({ x: 500, y: 250 });
  });

  it('mirrors camera x so left is left (inverted)', () => {
    // The camera sees the room like an onlooker; the user reads their own
    // hand like a mirror. Camera x=0.35 is the user's hand LEFT (in the
    // mirrored selfie view), so the cursor must land left; x=0.65 is right.
    expect(mapToSurface({ x: 0.35, y: 0.5 }, surface).x).toBeGreaterThan(500);
    expect(mapToSurface({ x: 0.65, y: 0.5 }, surface).x).toBeLessThan(500);
  });

  it('clamps margin-exceeding hands into range', () => {
    const p = mapToSurface({ x: 0, y: 0 }, surface);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeGreaterThanOrEqual(0);
    const q = mapToSurface({ x: 1, y: 1 }, surface);
    expect(q.x).toBeLessThanOrEqual(surface.w);
    expect(q.y).toBeLessThanOrEqual(surface.h);
  });

  it('gain makes a small hand motion cover more surface', () => {
    // Post-inversion, camera x=0.65 drives the cursor toward x=0; a higher
    // gain covers MORE of that travel — the magnitude is the point.
    const halfStep = { x: 0.65, y: 0.5 };
    expect(mapToSurface(halfStep, surface, 1.6).x).toBeLessThan(
      mapToSurface(halfStep, surface, 1.0).x,
    );
  });
});

describe('edgeFactor', () => {
  it('is 1 at the center', () => {
    expect(edgeFactor({ x: 0.5, y: 0.5 })).toBe(1);
  });

  it('is 1 everywhere past the fade band', () => {
    expect(edgeFactor({ x: 0.2, y: 0.8 })).toBe(1);
    expect(edgeFactor({ x: 0.85, y: 0.15 })).toBe(1);
  });

  it('fades to 0.5 at half the band from the edge', () => {
    // x=0.075 is 0.075 from the left edge — exactly half of the 0.15 band.
    expect(edgeFactor({ x: 0.075, y: 0.5 })).toBeCloseTo(0.5);
  });

  it('is 0 at the edge and stays 0 beyond the frame', () => {
    expect(edgeFactor({ x: 0, y: 0.5 })).toBe(0);
    // A landmark can report slightly outside 0..1; clamped, never negative.
    expect(edgeFactor({ x: -0.05, y: 0.5 })).toBe(0);
    expect(edgeFactor({ x: 1.05, y: 0.5 })).toBe(0);
  });

  it('counts the y axis too', () => {
    // x is deep inside; the 0.05 gap is the bottom edge.
    expect(edgeFactor({ x: 0.5, y: 0.95 })).toBeCloseTo(0.05 / 0.15);
  });

  it('honors a custom band', () => {
    expect(edgeFactor({ x: 0.05, y: 0.5 }, 0.1)).toBeCloseTo(0.5);
    expect(edgeFactor({ x: 0.05, y: 0.5 }, 0.2)).toBeCloseTo(0.25);
  });
});

describe('normalizeJarvisGain', () => {
  it('keeps a value already on the ladder', () => {
    expect(normalizeJarvisGain(1.3)).toBe(1.3);
    expect(normalizeJarvisGain(2.0)).toBe(2);
  });

  it('snaps off-ladder junk to the nearest rung', () => {
    expect(normalizeJarvisGain(1.4)).toBe(1.3);
    expect(normalizeJarvisGain(1.5)).toBe(1.6);
    expect(normalizeJarvisGain(9)).toBe(2.5);
    expect(normalizeJarvisGain(0)).toBe(1.0);
  });

  it('takes the default for non-numeric junk', () => {
    expect(normalizeJarvisGain(undefined)).toBe(JARVIS_DEFAULT_GAIN);
    expect(normalizeJarvisGain(NaN)).toBe(JARVIS_DEFAULT_GAIN);
    expect(normalizeJarvisGain('2')).toBe(JARVIS_DEFAULT_GAIN);
  });
});

describe('handPresent', () => {
  it('is false when no hand was ever seen', () => {
    expect(handPresent(null, 1000)).toBe(false);
  });

  it('holds within the grace window of the last sighting', () => {
    expect(handPresent(1000, 1000 + HAND_LOST_GRACE_MS)).toBe(true);
  });

  it('expires after the grace window', () => {
    expect(handPresent(1000, 1000 + HAND_LOST_GRACE_MS + 1)).toBe(false);
  });

  it('honors a custom grace', () => {
    expect(handPresent(1000, 1400, 100)).toBe(false);
    expect(handPresent(1000, 1400, 500)).toBe(true);
  });
});

describe('HandPresence', () => {
  it('starts absent and marks sightings', () => {
    const p = new HandPresence();
    expect(p.present(0)).toBe(false);
    p.mark(1000);
    expect(p.present(1000)).toBe(true);
    expect(p.present(1000 + HAND_LOST_GRACE_MS)).toBe(true);
    expect(p.present(1000 + HAND_LOST_GRACE_MS + 1)).toBe(false);
  });

  it('stays alive across gaps shorter than the grace', () => {
    const p = new HandPresence();
    p.mark(0);
    // A dropped frame or two (~50-100ms) never blinks the cursor off.
    p.mark(90);
    expect(p.present(140)).toBe(true);
  });

  it('reset returns to never-seen', () => {
    const p = new HandPresence();
    p.mark(5000);
    p.reset();
    expect(p.present(5100)).toBe(false);
  });
});

/* ----------------------------- phase 4: two-hand zoom ----------------------------- */

const obs = (x: number, y: number, pinched: boolean): { mid: { x: number; y: number }; ratio: number } => ({
  mid: { x, y },
  // A ratio that reads as pinched to the same hysteresis the pan uses.
  ratio: pinched ? PINCH_ON - 0.01 : PINCH_OFF + 0.01,
});

describe('matchHands', () => {
  it('matches each hand to its nearest previous self', () => {
    const prev = [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }];
    // A small drift on both — identity is by proximity, not array order.
    expect(matchHands(prev, [{ x: 0.22, y: 0.5 }, { x: 0.78, y: 0.5 }])).toEqual([0, 1]);
  });

  it('survives the landmarker swapping its output order', () => {
    const prev = [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }];
    // The SAME two hands, handed back reversed: each still finds its slot.
    expect(matchHands(prev, [{ x: 0.79, y: 0.5 }, { x: 0.21, y: 0.5 }])).toEqual([1, 0]);
  });
});

describe('cursorObservations', () => {
  it('maps slot 0 to its own observation and slot 1 to its own', () => {
    // obs 0 → slot 1, obs 1 → slot 0 (landmarker order flipped).
    expect(cursorObservations([1, 0])).toEqual([1, 0]);
  });

  it('keeps each ring on the same physical hand across an order swap', () => {
    // Same two hands, order swapped between frames: the attribution flips
    // with the map, so ring 1 keeps following the same physical hand.
    expect(cursorObservations([0, 1])).toEqual([0, 1]);
    expect(cursorObservations([1, 0])).toEqual([1, 0]);
  });

  it('falls back to observation 0 for an unmatched slot 0', () => {
    // Slot 0's hand vanished; the primary cursor follows the visible one.
    expect(cursorObservations([1])).toEqual([0, 0]);
    expect(cursorObservations([])).toEqual([0, -1]);
  });

  it('answers -1 for hand 2 when only one hand is seen', () => {
    expect(cursorObservations([0])).toEqual([0, -1]);
  });
});

describe('zoomDistance', () => {
  it('is aspect-corrected: x is scaled by width/height before the hypot', () => {
    // Two hands spread horizontally on a 16:9 frame. Uncorrected, the
    // distance is stretched ~1.8×; the aspect factor puts it in y's units.
    expect(zoomDistance({ x: 0.1, y: 0.5 }, { x: 0.6, y: 0.5 }, 16 / 9)).toBeCloseTo(0.5 * (16 / 9));
  });

  it('leaves a purely vertical spread alone', () => {
    expect(zoomDistance({ x: 0.5, y: 0.2 }, { x: 0.5, y: 0.7 }, 16 / 9)).toBeCloseTo(0.5);
  });
});

describe('OneEuroScalar', () => {
  it('passes the first sample through untouched', () => {
    expect(new OneEuroScalar().filter(0.5, 0)).toBe(0.5);
  });

  it('kills jitter at rest and follows motion', () => {
    const rest = new OneEuroScalar();
    rest.filter(0, 0);
    let last = 0;
    for (let i = 1; i <= 30; i++) last = rest.filter(i % 2 ? 0.01 : -0.01, i * 33);
    expect(Math.abs(last)).toBeLessThan(0.005);

    const moving = new OneEuroScalar();
    moving.filter(0, 0);
    let rampEnd = 0;
    for (let i = 1; i <= 60; i++) rampEnd = moving.filter(i * 0.02, i * 33);
    // A steady ramp keeps up to within the filter's (fixed, ~0.15s) time
    // lag — the same contract the 2D filter's test holds it to.
    expect(rampEnd).toBeGreaterThan(1.2 * 0.9);
  });

  it('reset makes the next sample a first sample', () => {
    const f = new OneEuroScalar();
    f.filter(0, 0);
    f.reset();
    expect(f.filter(1, 1000)).toBe(1);
  });
});

describe('TwoHandZoom mode machine', () => {
  const spread = (t: TwoHandZoom, x0: number, x1: number, ms: number) =>
    t.update([obs(x0, 0.5, true), obs(x1, 0.5, true)], 1, ms);

  it('stays idle until ZOOM_ENTER_FRAMES consecutive both-pinched frames', () => {
    const t = new TwoHandZoom();
    // Frame 1 seeds the slots and reads both pinched — stability frame one.
    expect(spread(t, 0.3, 0.7, 0).mode).toBe('idle');
    expect(spread(t, 0.3, 0.7, 33).mode).toBe('idle');
    // The third consecutive stable frame is the one that engages.
    expect(spread(t, 0.3, 0.7, 66).mode).toBe('zoom');
    expect(ZOOM_ENTER_FRAMES).toBe(3);
  });

  it('the entry frame carries ratio 1 — the baseline is the entry distance', () => {
    const t = new TwoHandZoom();
    for (let i = 0; i < ZOOM_ENTER_FRAMES - 1; i++) spread(t, 0.3, 0.7, i * 33);
    const entry = spread(t, 0.3, 0.7, 99);
    expect(entry.mode).toBe('zoom');
    expect(entry.zoom!.ratio).toBe(1);
  });

  it('exits when either pinch releases, and blocks pan through the cooldown', () => {
    const t = new TwoHandZoom();
    for (let i = 0; i < ZOOM_ENTER_FRAMES; i++) spread(t, 0.3, 0.7, i * 33);
    // One hand opens: zoom is over, even though the other still pinches.
    const out = t.update([obs(0.3, 0.5, true), obs(0.7, 0.5, false)], 1, 132);
    expect(out.mode).toBe('idle');
    expect(out.zoom).toBeNull();
    expect(out.panBlocked).toBe(true);
    // The cooldown, not a lifetime: past it, pan is allowed again.
    expect(t.update([obs(0.3, 0.5, true)], 1, 132 + ZOOM_PAN_COOLDOWN_MS + 1).panBlocked).toBe(false);
  });

  it('re-baselines after a dropout: re-entering measures from the new spread', () => {
    const t = new TwoHandZoom();
    for (let i = 0; i < ZOOM_ENTER_FRAMES; i++) spread(t, 0.4, 0.6, i * 33);
    // Hard dropout — a hand leaves the frame entirely.
    expect(t.update([], 1, 132).mode).toBe('idle');
    // Hands come back ALREADY at a much wider spread, pinched, and re-enter.
    for (let i = 0; i < ZOOM_ENTER_FRAMES - 1; i++) spread(t, 0.1, 0.9, 500 + i * 33);
    const entry = spread(t, 0.1, 0.9, 599);
    expect(entry.mode).toBe('zoom');
    // The ratio is 1 at the NEW spread, not still carrying the old zoom.
    expect(entry.zoom!.ratio).toBe(1);
  });

  it('counts frames honestly: one genuinely open pinch resets the stability count', () => {
    const t = new TwoHandZoom();
    spread(t, 0.3, 0.7, 0);
    spread(t, 0.3, 0.7, 33);
    // A fumble — one hand opens for a frame, BOTH hands still seen. That is
    // a real miss, not a dropout: the count starts over (no decay credit).
    t.update([obs(0.3, 0.5, true), obs(0.7, 0.5, false)], 1, 66);
    expect(spread(t, 0.3, 0.7, 99).mode).toBe('idle');
    expect(spread(t, 0.3, 0.7, 132).mode).toBe('idle');
    expect(spread(t, 0.3, 0.7, 165).mode).toBe('zoom');
  });

  it('forgives a detection dropout: climb, lose a hand for a frame, climb — enters', () => {
    const t = new TwoHandZoom();
    // Two stability frames.
    spread(t, 0.3, 0.7, 0);
    spread(t, 0.3, 0.7, 33);
    // Hand 2 blinks out of DETECTION (not open — gone). The count decays
    // by ZOOM_ENTER_DECAY (2 → 1) instead of resetting to zero: a hand
    // that blinks does not restart the climb.
    t.update([obs(0.3, 0.5, true)], 1, 66);
    // One both-pinched frame restores the count (1 → 2)…
    expect(spread(t, 0.3, 0.7, 99).mode).toBe('idle');
    // …and the next one enters — one frame sooner than reset-to-zero,
    // and the ENTER condition itself stayed honest throughout.
    expect(spread(t, 0.3, 0.7, 132).mode).toBe('zoom');
    expect(ZOOM_ENTER_DECAY).toBe(1);
  });

  it('a dropout at the top of the climb costs one frame, not the whole count', () => {
    const t = new TwoHandZoom();
    // Climb to one below entry (count 2 of 3).
    for (let i = 0; i < ZOOM_ENTER_FRAMES - 1; i++) spread(t, 0.3, 0.7, i * 33);
    // One dropped frame decays to 1 — it does NOT annihilate the climb.
    t.update([], 1, 99);
    // Two both-pinched frames restore the count to 2… (reset-to-zero would
    // still be at 1 here)
    expect(spread(t, 0.3, 0.7, 132).mode).toBe('idle');
    expect(spread(t, 0.3, 0.7, 165).mode).toBe('idle');
    // …and the third enters. Net cost of the dropout: one frame, not the
    // whole climb.
    expect(spread(t, 0.3, 0.7, 198).mode).toBe('zoom');
  });

  it('a second hand entering while one is tracked gets its own pinch detector', () => {
    const t = new TwoHandZoom();
    // Only hand 1 visible and pinching (pan posture) — one slot seeded.
    t.update([obs(0.3, 0.5, true)], 1, 0);
    // Hand 2 enters the frame ALREADY pinched. This used to index
    // tracks[-1] and throw every frame; now it seeds a fresh slot with its
    // own detector, so both-pinched is reachable without both hands having
    // entered the frame together.
    expect(t.update([obs(0.3, 0.5, true), obs(0.7, 0.5, true)], 1, 33).mode).toBe('idle');
    expect(t.update([obs(0.3, 0.5, true), obs(0.7, 0.5, true)], 1, 66).mode).toBe('idle');
    const out = t.update([obs(0.3, 0.5, true), obs(0.7, 0.5, true)], 1, 99);
    expect(out.mode).toBe('zoom');
    expect(out.slots[0].pinching).toBe(true);
    expect(out.slots[1].pinching).toBe(true);
  });

  it('never throws when more observations arrive than there are slots', () => {
    const t = new TwoHandZoom();
    t.update([obs(0.3, 0.5, true)], 1, 0);
    // Three hands on a two-slot machine: the unmatched extra is dropped.
    expect(() =>
      t.update([obs(0.3, 0.5, true), obs(0.7, 0.5, true), obs(0.5, 0.2, true)], 1, 33),
    ).not.toThrow();
  });

  it('matches hands across an order swap mid-zoom without a ratio spike', () => {
    const t = new TwoHandZoom();
    for (let i = 0; i < ZOOM_ENTER_FRAMES; i++) spread(t, 0.4, 0.6, i * 33);
    // Same physical hands, output order flipped: zoom keeps walking smoothly
    // toward the true ratio instead of treating the swap as a distance spike.
    let frame = t.update(
      [obs(0.6, 0.5, true), obs(0.4, 0.5, true)],
      1,
      ZOOM_ENTER_FRAMES * 33 + 1,
    );
    expect(frame.mode).toBe('zoom');
    expect(frame.zoom!.ratio).toBeCloseTo(1, 2);
    // And tracking follows the physical hand: holding still keeps ratio 1.
    frame = t.update([obs(0.6, 0.5, true), obs(0.4, 0.5, true)], 1, ZOOM_ENTER_FRAMES * 33 + 2);
    expect(frame.zoom!.ratio).toBeCloseTo(1, 2);
  });

  it('slots pinch hysteresis per matched hand, not per array position', () => {
    const t = new TwoHandZoom();
    // Hand A pinches and enters zoom with hand B.
    for (let i = 0; i < ZOOM_ENTER_FRAMES; i++) spread(t, 0.3, 0.7, i * 33);
    // A released-then-reclosed pinch does NOT re-arm zoom from stale state —
    // the exit already happened and the count restarts.
    t.update([obs(0.3, 0.5, false), obs(0.7, 0.5, true)], 1, 132);
    const reclosed = t.update([obs(0.3, 0.5, true), obs(0.7, 0.5, true)], 1, 165);
    expect(reclosed.mode).toBe('idle');
  });
});

describe('TwoHandZoom zoom signal', () => {
  const enter = (t: TwoHandZoom, x0: number, x1: number, ms: number) => {
    for (let i = 0; i < ZOOM_ENTER_FRAMES; i++) t.update([obs(x0, 0.5, true), obs(x1, 0.5, true)], 1, ms + i * 33);
    return ms + (ZOOM_ENTER_FRAMES - 1) * 33;
  };

  it('spreading hands drives the ratio up at no more than the per-frame clamp', () => {
    const t = new TwoHandZoom();
    const entryMs = enter(t, 0.35, 0.65, 0);
    // A hard yank: hands jump to 5× the entry spread in one frame.
    const frame = t.update([obs(0.0, 0.5, true), obs(1.0, 0.5, true)], 1, entryMs + 33);
    expect(frame.zoom!.ratio).toBeCloseTo(Math.exp(ZOOM_LOG_STEP_MAX), 5);
    // Rate-limited walking means repeated identical frames keep going.
    let last = frame;
    for (let i = 2; i <= 10; i++) {
      last = t.update([obs(0.0, 0.5, true), obs(1.0, 0.5, true)], 1, entryMs + i * 33);
    }
    expect(last.zoom!.ratio).toBeGreaterThan(frame.zoom!.ratio);
    expect(last.zoom!.ratio).toBeLessThan(Math.exp(Math.log(5) + 0.001));
  });

  it('is a rate limit, not a dead zone: a sustained spread keeps zooming', () => {
    const t = new TwoHandZoom();
    const entryMs = enter(t, 0.4, 0.6, 0);
    let f = t.update([obs(0.3, 0.5, true), obs(0.7, 0.5, true)], 1, entryMs + 33);
    const first = f.zoom!.ratio;
    f = t.update([obs(0.3, 0.5, true), obs(0.7, 0.5, true)], 1, entryMs + 66);
    expect(f.zoom!.ratio).toBeGreaterThan(first);
  });

  it('a trembling hold at the baseline zooms nothing', () => {
    const t = new TwoHandZoom();
    const entryMs = enter(t, 0.4, 0.6, 0);
    let worst = 0;
    for (let i = 1; i <= 20; i++) {
      // ±0.005 normalized jitter on each hand, alternating.
      const j = i % 2 ? 0.005 : -0.005;
      const f = t.update([obs(0.4 + j, 0.5 + j, true), obs(0.6 - j, 0.5 - j, true)], 1, entryMs + i * 33);
      worst = Math.max(worst, Math.abs(f.zoom!.ratio - 1));
    }
    expect(worst).toBeLessThan(0.03);
  });

  it('unspreading back to the entry distance returns the ratio to 1 — no ratchet', () => {
    const t = new TwoHandZoom();
    const entryMs = enter(t, 0.4, 0.6, 0);
    // Spread wide for a while…
    for (let i = 1; i <= 10; i++) {
      t.update([obs(0.0, 0.5, true), obs(1.0, 0.5, true)], 1, entryMs + i * 33);
    }
    // …then return exactly to the entry spread and HOLD: the applied walk
    // comes home, frame by frame, to the baseline — no ratchet residue.
    let home = null;
    for (let i = 1; i <= 30; i++) {
      home = t.update([obs(0.4, 0.5, true), obs(0.6, 0.5, true)], 1, entryMs + 333 + i * 33);
    }
    expect(home!.zoom!.ratio).toBeCloseTo(1, 1);
  });
});

describe('twoHandZoomViewport', () => {
  const start = { viewport: v(0, 0, 1), mid: { x: 500, y: 300 } };

  it('keeps the entry midpoint anchored while zooming', () => {
    const out = twoHandZoomViewport(start, { ratio: 2, mid: start.mid });
    expect(out.scale).toBe(2);
    // The board point under the midpoint at entry stays under it: the
    // midpoint's own motion is zero, so the translation added is zero.
    expect(out.x).toBeCloseTo(-500);
    expect(out.y).toBeCloseTo(-300);
  });

  it('adds the midpoint translation on top of the zoom', () => {
    const out = twoHandZoomViewport(start, { ratio: 2, mid: { x: 560, y: 330 } });
    expect(out.scale).toBe(2);
    expect(out.x).toBeCloseTo(-500 + 60);
    expect(out.y).toBeCloseTo(-300 + 30);
  });

  it('holds the clamp bounds 0.25 / 2.5', () => {
    const maxed = twoHandZoomViewport({ ...start, viewport: v(0, 0, 2.4) }, { ratio: 2, mid: start.mid });
    expect(maxed.scale).toBe(VIEW_MAX_SCALE);
    const mined = twoHandZoomViewport({ ...start, viewport: v(0, 0, 0.26) }, { ratio: 0.1, mid: start.mid });
    expect(mined.scale).toBe(VIEW_MIN_SCALE);
  });

  it('is a round trip: ratio 1 and no midpoint motion is the entry viewport', () => {
    const startAt = { viewport: v(-120, 80, 1.3), mid: { x: 400, y: 200 } };
    expect(twoHandZoomViewport(startAt, { ratio: 1, mid: startAt.mid })).toEqual(startAt.viewport);
  });
});

describe('pinchEdgeScroll / integrateEdgeScroll (phase 5: pinch-pan edge auto-scroll)', () => {
  const SURFACE = { w: 1200, h: 800 };
  // Same -0 normalization as the implementation: negating 0 yields -0.
  const neg = (p: { x: number; y: number }) => ({ x: -p.x || 0, y: -p.y || 0 });

  it('answers zero when the pan gate is closed — anywhere, even at the edge', () => {
    // Gated off (pinch released, or zoom owning the gesture) the cursor
    // could sit ON the edge and the answer is still stillness.
    expect(pinchEdgeScroll({ x: 0, y: 0 }, SURFACE, false)).toEqual({ x: 0, y: 0 });
    expect(pinchEdgeScroll({ x: 1200, y: 800 }, SURFACE, false)).toEqual({ x: 0, y: 0 });
    expect(pinchEdgeScroll({ x: 3, y: 799 }, SURFACE, false)).toEqual({ x: 0, y: 0 });
  });

  it('gated on, is edgeScrollVelocity INVERTED — no duplicated arithmetic', () => {
    // Interior: dead zone.
    expect(pinchEdgeScroll({ x: 600, y: 400 }, SURFACE, true)).toEqual({ x: 0, y: 0 });
    // Both edges at once: the corner asks both axes.
    expect(pinchEdgeScroll({ x: 10, y: 10 }, SURFACE, true)).toEqual(
      neg(edgeScrollVelocity({ x: 10, y: 10 }, SURFACE)),
    );
    // Mid-ramp and at the edge itself, every axis sign.
    for (const p of [
      { x: EDGE_ZONE_PX / 2, y: 400 },
      { x: 0, y: 400 },
      { x: 1200, y: 400 },
      { x: 600, y: 800 },
      { x: 1195, y: 5 },
    ]) {
      expect(pinchEdgeScroll(p, SURFACE, true)).toEqual(neg(edgeScrollVelocity(p, SURFACE)));
    }
  });

  it('the inversion follows the GRAB, not the REVEAL: hand pulling down keeps the board coming down', () => {
    // Kyle's live test: pinch and pull the board downward — the hand rides
    // toward the TOP edge. The drag convention would reveal content ABOVE
    // (scroll up); a grab must keep the board moving down, the direction of
    // the pull. Top-edge reach answers a downward pull with downward travel.
    const atTop = pinchEdgeScroll({ x: 600, y: 5 }, SURFACE, true);
    expect(atTop.x).toBe(0);
    expect(atTop.y).toBeGreaterThan(0); // +y velocity = board travel downward
    // Mirror case: pulling the board up (hand at the bottom edge) keeps
    // travel upward.
    const atBottom = pinchEdgeScroll({ x: 600, y: 795 }, SURFACE, true);
    expect(atBottom.y).toBeLessThan(0);
  });

  it('a cursor pinned past the surface bound holds full speed (gated on)', () => {
    // mapToSurface clamps, but the helper does not depend on that: past the
    // edge is full speed, inverted like any other answer.
    expect(pinchEdgeScroll({ x: -50, y: 400 }, SURFACE, true).x).toBe(EDGE_MAX_SPEED);
    expect(pinchEdgeScroll({ x: 1300, y: 400 }, SURFACE, true).x).toBe(-EDGE_MAX_SPEED);
  });

  it('integrates velocity over dt: pan toward right/bottom moves translate left', () => {
    // 300 px/s for a 100ms step = 30 surface px of board travel.
    const out = integrateEdgeScroll(v(0, 0, 1), { x: 300, y: -100 }, 100);
    expect(out.scale).toBe(1);
    expect(out.x).toBeCloseTo(-30);
    expect(out.y).toBeCloseTo(10);
  });

  it('caps dt at 100ms — a stalled frame cannot jump the board', () => {
    // 900 px/s at a true 1s step would be 900px; capped it is 90.
    const capped = integrateEdgeScroll(v(0, 0, 1), { x: EDGE_MAX_SPEED, y: 0 }, 1000);
    expect(capped.x).toBeCloseTo(-90);
    // Just under the cap integrates fully.
    const under = integrateEdgeScroll(v(0, 0, 1), { x: EDGE_MAX_SPEED, y: 0 }, 99);
    expect(under.x).toBeCloseTo(-89.1);
  });

  it('a one-minute hold at the edge is the ramp speed times elapsed time', () => {
    // The integration is the plain Euler step the drag version runs: same
    // velocity each frame, dt-scaled, additive.
    let vp = v(0, 0, 1);
    for (let i = 0; i < 60; i++) vp = integrateEdgeScroll(vp, { x: 0, y: EDGE_MAX_SPEED }, 100);
    expect(vp.y).toBeCloseTo(-60 * EDGE_MAX_SPEED * 0.1);
  });
});

