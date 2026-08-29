import { describe, expect, it } from 'vitest';
import { createNode, NODE_H, NODE_W, type IdeaNode } from './graph';
import {
  MIN_PRINT_SCALE,
  PRINT_HEADER_H,
  PRINT_PAGE_H,
  PRINT_PAGE_W,
  printPlan,
} from './print';

function node(id: string, x: number, y: number, w = NODE_W, h = NODE_H): IdeaNode {
  return createNode({ id, x, y, w, h });
}

/** The plan's windows must cover every card between them, with no gaps. */
function coversAll(windows: ReturnType<typeof printPlan>['windows'], nodes: IdeaNode[]) {
  const minX = Math.min(...windows.map((w) => w.x));
  const minY = Math.min(...windows.map((w) => w.y));
  const maxX = Math.max(...windows.map((w) => w.x + w.w));
  const maxY = Math.max(...windows.map((w) => w.y + w.h));
  return nodes.every(
    (n) => n.x >= minX && n.y >= minY && n.x + n.w <= maxX && n.y + n.h <= maxY,
  );
}

describe('printPlan', () => {
  it('gives an empty board one blank sheet — printing nothing must not crash', () => {
    const plan = printPlan([]);
    expect(plan).toEqual({
      scale: 1,
      cols: 1,
      rows: 1,
      windows: [
        { col: 0, row: 0, x: 0, y: 0, w: PRINT_PAGE_W, h: PRINT_PAGE_H - PRINT_HEADER_H },
      ],
    });
  });

  it('never upscales: a small board prints at the size it was authored', () => {
    const plan = printPlan([node('a', 0, 0), node('b', 400, 300)]);
    expect(plan.scale).toBe(1);
    expect(plan.cols).toBe(1);
    expect(plan.rows).toBe(1);
    expect(coversAll(plan.windows, [node('a', 0, 0), node('b', 400, 300)])).toBe(true);
  });

  it('shrinks to one page while the fit stays readable', () => {
    // Exactly the width that fits at 0.9 — so the plan takes that scale
    // rather than tiling at the floor.
    const w = PRINT_PAGE_W / 0.9;
    const plan = printPlan([node('a', 0, 0, w, 96)]);
    expect(plan.scale).toBeCloseTo(0.9, 9);
    expect(plan.cols).toBe(1);
    expect(plan.rows).toBe(1);
  });

  it('keeps a mid-size board on one page — the fit decides, not an old floor', () => {
    // A one-page fit of 0.5 tiled under the old 0.75 floor; the floor is
    // lower now, so the same board prints as a single smaller page.
    const w = PRINT_PAGE_W / 0.5;
    const plan = printPlan([node('a', 0, 0, w, 96)]);
    expect(plan.scale).toBeCloseTo(0.5, 9);
    expect(plan.cols).toBe(1);
    expect(plan.rows).toBe(1);
    expect(plan.windows).toHaveLength(1);
  });

  it('holds the floor and tiles when one page would go unreadable', () => {
    const nodes = [
      node('a', 0, 0, 200, 96),
      node('b', 4000, 4000, 200, 96),
    ];
    const plan = printPlan(nodes);
    expect(plan.scale).toBe(MIN_PRINT_SCALE);
    expect(plan.cols).toBeGreaterThan(1);
    expect(plan.rows).toBeGreaterThan(1);
    expect(plan.windows).toHaveLength(plan.cols * plan.rows);
    expect(coversAll(plan.windows, nodes)).toBe(true);
  });

  it('tiles with no gaps or overlaps: windows share their edges exactly', () => {
    const plan = printPlan([node('a', 0, 0, 200, 96), node('b', 3000, 3000, 200, 96)]);
    expect(plan.rows).toBeGreaterThan(1);
    for (let row = 0; row < plan.rows; row++) {
      for (let col = 0; col < plan.cols; col++) {
        const w = plan.windows[row * plan.cols + col];
        expect(w.row).toBe(row);
        expect(w.col).toBe(col);
        if (col > 0) {
          const left = plan.windows[row * plan.cols + col - 1];
          expect(w.x).toBeCloseTo(left.x + left.w, 9);
        }
      }
    }
    for (let col = 0; col < plan.cols; col++) {
      for (let row = 1; row < plan.rows; row++) {
        const above = plan.windows[(row - 1) * plan.cols + col];
        const w = plan.windows[row * plan.cols + col];
        expect(w.y).toBeCloseTo(above.y + above.h, 9);
      }
    }
  });

  it('shortens only row 0 by the name bar, in printed pixels', () => {
    const plan = printPlan([node('a', 0, 0, 200, 96), node('b', 3000, 3000, 200, 96)]);
    plan.windows.forEach((w) => {
      const printedH = w.h * plan.scale;
      if (w.row === 0) {
        expect(printedH).toBeCloseTo(PRINT_PAGE_H - PRINT_HEADER_H, 9);
      } else {
        expect(printedH).toBeCloseTo(PRINT_PAGE_H, 9);
      }
      expect(w.w * plan.scale).toBeCloseTo(PRINT_PAGE_W, 9);
    });
  });

  it('treats a width of exactly N windows as N columns, not N+1', () => {
    // Float noise must not buy an almost-empty trailing column or row.
    const winW = PRINT_PAGE_W / MIN_PRINT_SCALE;
    const plan = printPlan([node('a', 0, 0, winW * 2, 96)]);
    expect(plan.scale).toBe(MIN_PRINT_SCALE);
    expect(plan.cols).toBe(2);
  });

  it('fits inside one page of printable area, whatever the page count', () => {
    // The invariant the @page margin depends on: no window can exceed the
    // sheet it renders into.
    const plan = printPlan([node('a', 0, 0, 200, 96), node('b', 5000, 5000, 200, 96)]);
    plan.windows.forEach((w) => {
      expect(w.w * plan.scale).toBeLessThanOrEqual(PRINT_PAGE_W + 1e-6);
      expect(w.h * plan.scale).toBeLessThanOrEqual(PRINT_PAGE_H + 1e-6);
    });
  });
});
