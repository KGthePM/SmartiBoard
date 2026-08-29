import { describe, expect, it } from 'vitest';
import { VIEW_MAX_SCALE, VIEW_MIN_SCALE, type Viewport } from './graph';
import { clampScale, distance, midpoint, pinchViewport, zoomAround } from './gesture';

const v = (x: number, y: number, scale: number): Viewport => ({ x, y, scale });

/** Where a board point currently sits on the surface, under a given viewport. */
const project = (view: Viewport, p: { x: number; y: number }) => ({
  x: p.x * view.scale + view.x,
  y: p.y * view.scale + view.y,
});

describe('distance / midpoint', () => {
  it('measure the obvious things', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(midpoint({ x: 0, y: 0 }, { x: 10, y: 4 })).toEqual({ x: 5, y: 2 });
  });
});

describe('clampScale', () => {
  it('holds the viewport limits at both ends', () => {
    expect(clampScale(0.0001)).toBe(VIEW_MIN_SCALE);
    expect(clampScale(99)).toBe(VIEW_MAX_SCALE);
    expect(clampScale(1)).toBe(1);
  });
});

describe('zoomAround', () => {
  it('keeps the board point under the anchor still under it', () => {
    const before = v(120, -40, 0.8);
    const at = { x: 300, y: 220 };
    // The board point currently at the anchor.
    const board = { x: (at.x - before.x) / before.scale, y: (at.y - before.y) / before.scale };

    const after = zoomAround(before, at, 1.6);
    const moved = project(after, board);
    expect(moved.x).toBeCloseTo(at.x, 6);
    expect(moved.y).toBeCloseTo(at.y, 6);
  });

  it('is a no-op at the same scale', () => {
    const before = v(12, 34, 1.25);
    expect(zoomAround(before, { x: 90, y: 90 }, 1.25)).toEqual(before);
  });

  it('clamps rather than passing the limits through', () => {
    expect(zoomAround(v(0, 0, 1), { x: 10, y: 10 }, 40).scale).toBe(VIEW_MAX_SCALE);
    expect(zoomAround(v(0, 0, 1), { x: 10, y: 10 }, 0.01).scale).toBe(VIEW_MIN_SCALE);
  });
});

describe('pinchViewport', () => {
  const start = { dist: 200, mid: { x: 400, y: 300 }, viewport: v(60, 20, 1) };

  it('is the identity while nothing has changed', () => {
    expect(pinchViewport(start, { dist: start.dist, mid: start.mid })).toEqual(start.viewport);
  });

  it('spreading the fingers zooms about the midpoint', () => {
    const board = {
      x: (start.mid.x - start.viewport.x) / start.viewport.scale,
      y: (start.mid.y - start.viewport.y) / start.viewport.scale,
    };
    const after = pinchViewport(start, { dist: 300, mid: start.mid });
    expect(after.scale).toBeCloseTo(1.5, 6);

    // The pinched point does not slide out from under the fingers.
    const moved = project(after, board);
    expect(moved.x).toBeCloseTo(start.mid.x, 6);
    expect(moved.y).toBeCloseTo(start.mid.y, 6);
  });

  it('sliding both fingers pans without zooming', () => {
    const after = pinchViewport(start, { dist: start.dist, mid: { x: 460, y: 275 } });
    expect(after.scale).toBe(start.viewport.scale);
    expect(after.x).toBeCloseTo(start.viewport.x + 60, 6);
    expect(after.y).toBeCloseTo(start.viewport.y - 25, 6);
  });

  it('returning to the starting spread returns the viewport', () => {
    // Scaling from the start, not per frame, is what makes this true.
    const away = pinchViewport(start, { dist: 340, mid: { x: 500, y: 200 } });
    const back = pinchViewport(start, { dist: start.dist, mid: start.mid });
    expect(away).not.toEqual(start.viewport);
    expect(back).toEqual(start.viewport);
  });

  it('respects the scale clamp', () => {
    expect(pinchViewport(start, { dist: 4000, mid: start.mid }).scale).toBe(VIEW_MAX_SCALE);
    expect(pinchViewport(start, { dist: 1, mid: start.mid }).scale).toBe(VIEW_MIN_SCALE);
  });

  it('two fingers in the same place pan instead of dividing by zero', () => {
    const degenerate = { dist: 0, mid: { x: 100, y: 100 }, viewport: v(0, 0, 1) };
    const after = pinchViewport(degenerate, { dist: 0, mid: { x: 130, y: 90 } });
    expect(after.scale).toBe(1);
    expect(after).toEqual({ scale: 1, x: 30, y: -10 });
  });
});
