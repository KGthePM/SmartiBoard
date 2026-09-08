import { describe, expect, it } from 'vitest';
import type { Viewport } from './graph';
import { VIEW_MAX_SCALE, VIEW_MIN_SCALE } from './graph';
import {
  HAND_LOST_GRACE_MS,
  PINCH_OFF,
  PINCH_ON,
  OneEuro,
  PinchDetector,
  HandPresence,
  handPresent,
  handZoomViewport,
  mapToSurface,
  panViewport,
  pinchState,
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

  it('mirrors camera x so right is right', () => {
    // Camera x=0.35 is left-of-center in the feed; the cursor must land left.
    expect(mapToSurface({ x: 0.35, y: 0.5 }, surface).x).toBeLessThan(500);
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
    const halfStep = { x: 0.65, y: 0.5 };
    expect(mapToSurface(halfStep, surface, 1.6).x).toBeGreaterThan(
      mapToSurface(halfStep, surface, 1.0).x,
    );
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

