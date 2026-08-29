/**
 * Themes (v2.2): what the board looks like, and nothing else.
 *
 * A theme is presentation, in the same sense `moveNode` and `resizeNode` are:
 * it spends nothing. No undo snapshot, no `lastMutationAt` bump, not in the
 * fingerprint, never in a prompt. The model has no idea which one is on, and
 * the graph is byte-identical under all three.
 *
 * It is install-level, stored in the settings row beside the provider config —
 * not per-board. A board carries what it is about; the desk lamp is a property
 * of the room. (Privacy Mode went the other way for exactly the opposite
 * reason: it is a property of the content.)
 *
 * Pure and node-free on purpose, like `lib/ai/providers.ts`: the settings UI,
 * the root layout, `lib/db.ts`, and the tests all import this one file, so the
 * legal set of themes cannot drift between them.
 */

export const THEMES = ['light', 'dark', 'neon'] as const;

export type ThemeId = (typeof THEMES)[number];

/**
 * Light, and deliberately not the operating system's preference. Following
 * `prefers-color-scheme` would repaint every existing board the first time the
 * app is opened on a machine set to dark — an appearance change nobody asked
 * for, on content they have already arranged. The theme changes when the user
 * changes it.
 */
export const DEFAULT_THEME: ThemeId = 'light';

/**
 * Snap any value to a real theme. Junk, absence, casing, and stray whitespace
 * all land on the default — the same doctrine as `normalizeGhostDelay`: a bad
 * row in the database or a stale client's PUT must never leave the app with a
 * `data-theme` no stylesheet answers to, which would render an unstyled board.
 * Shared by the route (write side) and `loadSettings` (read side) so the two
 * cannot disagree.
 */
export function normalizeTheme(v: unknown): ThemeId {
  return typeof v === 'string' && (THEMES as readonly string[]).includes(v) ? (v as ThemeId) : DEFAULT_THEME;
}

/** How the Settings dropdown names them. */
export const THEME_LABELS: Record<ThemeId, string> = {
  light: 'Light (default)',
  dark: 'Dark',
  neon: 'Neon',
};
