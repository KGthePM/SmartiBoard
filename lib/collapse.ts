/**
 * Folding done cards (v2.8, and the dot in v2.9): a view of `done`, not a
 * second piece of state.
 *
 * A board that gets used fills up with crossed-off cards, and a done card costs
 * exactly as much canvas as a live one. So, behind a setting, a done card
 * minimizes — to a one-line stub, or, for people who wanted the space back in
 * earnest, to a 28px dot wearing nothing but the ▸ that opens it again.
 *
 * The rule that decides everything else is that there is no `collapsed` field
 * on `IdeaNode`. A card is folded iff the install setting says to fold, the
 * node is already `done`, and the person has not peeked at it — an install
 * setting, a fact the node already carried, and a session-only override that
 * lives beside the selection. So there is no board-JSON change, no migration,
 * and nothing new for the model to see: folding spends nothing. No undo
 * snapshot, no `lastMutationAt` bump, not in the fingerprint, not in the
 * prompt, never a token. `done` itself keeps its own doctrine untouched.
 *
 * The setting is install-level, beside the theme and for the same reason: how
 * tightly a finished card packs is a property of the room, not of the content.
 * (Privacy Mode went the other way, being a property of the content.)
 *
 * Pure and node-free like `lib/theme.ts`: the settings UI, the settings route,
 * `lib/db.ts`, the canvas, and the tests all import this one file, so the rule
 * cannot drift between them.
 */

import type { IdeaNode, Rect } from './graph';

/**
 * What a done card does with the space it is taking. `full` is the setting
 * being off; the other two are the two folds.
 */
export const COLLAPSE_MODES = ['full', 'line', 'dot'] as const;
export type CollapseMode = (typeof COLLAPSE_MODES)[number];

/**
 * How a card that *is* folded gets drawn. The same two names as the modes that
 * produce them, minus `full`, which is the absence of a fold rather than a kind
 * of one — so the canvas carries `CollapseView | null` and a null needs no
 * special case anywhere it is read.
 */
export type CollapseView = Exclude<CollapseMode, 'full'>;

export const COLLAPSE_LABELS: Record<CollapseMode, string> = {
  full: 'Stay full size (default)',
  line: 'Fold to a single line',
  dot: 'Fold to a dot',
};

/**
 * Off, and deliberately so — the same reading as Light being the default
 * theme. Silently folding every done card on every existing board the first
 * time the app opens is an appearance change nobody asked for, on content
 * they have already arranged.
 */
export const DEFAULT_COLLAPSE_MODE: CollapseMode = 'full';

/**
 * The stub's height. Below `NODE_MIN_H`, which is fine and not a contradiction:
 * that floor guards a *manual resize*, where a card has to fit a word and a
 * toolbar row. Nothing here is a resize — `node.h` is never written, so
 * expanding restores the exact size the card had.
 */
export const COLLAPSED_H = 28;

/**
 * The dot, square and then rounded in CSS — the same 28 in both directions, so
 * a folded card is the size of one line whichever fold you chose.
 *
 * This is the one place the dot parts company with the stub, which keeps its
 * width. Narrowing was ruled out in v2.8 on the grounds that it would shuffle
 * the columns the person arranged; the dot narrows anyway, because reclaiming
 * that width is the whole of what was asked for, and it costs less than the
 * ruling assumed: a card is anchored at its top-left, so every column keeps its
 * left edge and only the right edge pulls in. `node.w` is still never written.
 */
export const DOT_SIZE = 28;

/**
 * Snap any value to a real mode. Junk and absence land on the default, the
 * same doctrine as `normalizeTheme` and `normalizeGhostDelay`, and shared the
 * same way: the PUT route (write side) and `loadSettings` (read side) both call
 * it, so a bad row in the database cannot disagree with a stale client's PUT.
 */
export function normalizeCollapseMode(v: unknown): CollapseMode {
  return COLLAPSE_MODES.includes(v as CollapseMode) ? (v as CollapseMode) : DEFAULT_COLLAPSE_MODE;
}

/**
 * The settings row's `collapse_done` column, both ways.
 *
 * v2.8 stored a 0/1 boolean there. v2.9 needs three values, and puts them in
 * the same INTEGER column rather than adding one: `0 = full, 1 = line,
 * 2 = dot`, which reads every existing row correctly — an install that chose
 * folding is on 1, and 1 is the single line it already had. So there is still
 * no migration, and the encoding lives here beside the rule rather than being
 * spelled out in `lib/db.ts`.
 */
export function modeFromRow(v: unknown): CollapseMode {
  return normalizeCollapseMode(COLLAPSE_MODES[typeof v === 'number' ? v : -1]);
}

export function modeToRow(mode: CollapseMode): number {
  return Math.max(0, COLLAPSE_MODES.indexOf(mode));
}

/**
 * The whole feature in one expression: how this card is drawn right now, or
 * null for an ordinary card. Note the order — the setting first, so an install
 * that never turned this on pays nothing for it and behaves exactly as it did
 * before v2.8.
 */
export function cardView(
  node: Pick<IdeaNode, 'id' | 'done'>,
  mode: CollapseMode,
  expanded: ReadonlySet<string>,
): CollapseView | null {
  return mode !== 'full' && node.done && !expanded.has(node.id) ? mode : null;
}

/**
 * What the card actually occupies on the board right now — the one measure the
 * canvas draws from, so the card, the edges that meet it, and the rubber band
 * that catches it all agree. A stub keeps its width and gives up its height; a
 * dot gives up both. Neither writes the node, which is why expanding restores
 * the card exactly as it was.
 */
export function viewRect(
  node: Pick<IdeaNode, 'x' | 'y' | 'w' | 'h'>,
  view: CollapseView | null | undefined,
): Rect {
  if (view === 'dot') return { x: node.x, y: node.y, w: DOT_SIZE, h: DOT_SIZE };
  if (view === 'line') return { x: node.x, y: node.y, w: node.w, h: COLLAPSED_H };
  return { x: node.x, y: node.y, w: node.w, h: node.h };
}
