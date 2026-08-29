import { describe, expect, it } from 'vitest';
import { clampSize, NODE_MIN_H, NODE_MIN_W } from './graph';

describe('clampSize', () => {
  it('rounds to whole pixels and leaves room-sized values alone', () => {
    expect(clampSize(240.4, 120.6)).toEqual({ w: 240, h: 121 });
    expect(clampSize(NODE_MIN_W + 60, NODE_MIN_H + 40)).toEqual({
      w: NODE_MIN_W + 60,
      h: NODE_MIN_H + 40,
    });
  });

  it('clamps at the minimums, whatever comes in', () => {
    expect(clampSize(12, -40)).toEqual({ w: NODE_MIN_W, h: NODE_MIN_H });
    expect(clampSize(NaN, NaN)).toEqual({ w: NODE_MIN_W, h: NODE_MIN_H });
  });
});
