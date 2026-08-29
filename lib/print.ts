/**
 * Printing (v2.5): the board on paper. Pure geometry — no DOM, no store — so
 * it tests in node like the rest of lib.
 *
 * The printed thing is never the live canvas. `printPlan` slices the board's
 * bounds into page-sized windows; the sheets that render them are a separate
 * React subtree mounted only for the duration of a print (see
 * components/canvas/PrintSheets.tsx and Board's beforeprint listener).
 *
 * Paper sizes are expressed in CSS pixels at the browser's fixed 96-to-the-
 * inch mapping, which is what every print engine maps CSS px against — no
 * attempt is made to detect the actual sheet, because the constants below
 * sit inside both of the common ones.
 */

import { unionRect, type IdeaNode } from './graph';

/**
 * The sheet size: the smaller intersection of A4 (703×1032 printable) and
 * Letter (725×965 printable) portrait at 12mm @page margins — minus a little
 * headroom, because a sheet one pixel taller than the printable area spills
 * onto a second page and breaks the one-sheet-one-page mapping. The @page
 * margin itself lives in the stylesheet; these constants are computed to
 * agree with it.
 */
export const PRINT_PAGE_W = 695;
export const PRINT_PAGE_H = 950;

/**
 * How small the board may shrink before it tiles instead. One page is the
 * norm: a single sheet at this floor covers a board up to ~1738×2290 css-px,
 * which is nearly every real board, and one page is worth small type. But
 * below this the smallest font rung (12px) prints under 5px — a diagram of a
 * board rather than a printout of one — so past the floor the scale holds
 * and the page count grows instead.
 */
export const MIN_PRINT_SCALE = 0.4;

/** The name bar on the first sheet. Row 0's window is shorter by exactly this. */
export const PRINT_HEADER_H = 34;

/** One page's window into the board, in board coordinates. */
export type PrintWindow = {
  col: number;
  row: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type PrintPlan = {
  scale: number;
  cols: number;
  rows: number;
  windows: PrintWindow[];
};

/** ceil that tolerates float noise: a width that is exactly two windows is two. */
function ceilPages(total: number, per: number): number {
  return Math.max(1, Math.ceil(total / per - 1e-9));
}

/**
 * The whole print decision in one function:
 *
 * - A board that fits a single page prints as one page, however much it has
 *   to shrink to do so down to MIN_PRINT_SCALE — one page is the norm, not
 *   the poster case. It never *upscales*: you print the size you authored.
 * - A board too sprawling for even that — a one-page fit below
 *   MIN_PRINT_SCALE — holds at the floor and tiles: the bounds are sliced
 *   into exact page windows, no gaps and no overlaps, so a card straddling a
 *   boundary prints partially on each sheet and tapes back together.
 * - The first sheet carries the name bar, so row 0's window is shorter; the
 *   tiled grid is centered as a whole, which gives the poster its margins and
 *   the edge sheets of a tile set their balance.
 */
export function printPlan(nodes: IdeaNode[]): PrintPlan {
  const bounds = unionRect(nodes);
  if (!bounds) {
    // Nothing to frame — one sheet, the name, and blank paper. The same
    // shape as any other plan so the renderer has no empty-board branch.
    return {
      scale: 1,
      cols: 1,
      rows: 1,
      windows: [{ col: 0, row: 0, x: 0, y: 0, w: PRINT_PAGE_W, h: PRINT_PAGE_H - PRINT_HEADER_H }],
    };
  }

  // The one-page fit, constrained by the first sheet's shortened window.
  const fit = Math.min(PRINT_PAGE_W / bounds.w, (PRINT_PAGE_H - PRINT_HEADER_H) / bounds.h);
  const scale = Math.min(1, Math.max(MIN_PRINT_SCALE, fit));

  const winW = PRINT_PAGE_W / scale;
  const cols = ceilPages(bounds.w, winW);

  const h0 = (PRINT_PAGE_H - PRINT_HEADER_H) / scale;
  const hn = PRINT_PAGE_H / scale;
  const rows = bounds.h <= h0 ? 1 : 1 + ceilPages(bounds.h - h0, hn);

  // Center the whole grid: the slack of the last row/column becomes margin on
  // both sides rather than a lopsided edge. Every window shifts by the same
  // offset, so the tiling's no-gaps property is untouched.
  const gridW = cols * winW;
  const gridH = h0 + (rows - 1) * hn;
  const ox = (gridW - bounds.w) / 2;
  const oy = (gridH - bounds.h) / 2;

  const windows: PrintWindow[] = [];
  for (let row = 0; row < rows; row++) {
    const y = bounds.y - oy + (row === 0 ? 0 : h0 + (row - 1) * hn);
    const h = row === 0 ? h0 : hn;
    for (let col = 0; col < cols; col++) {
      windows.push({ col, row, x: bounds.x - ox + col * winW, y, w: winW, h });
    }
  }
  return { scale, cols, rows, windows };
}
