import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, normalizeTheme, THEME_LABELS, THEMES } from './theme';

describe('normalizeTheme', () => {
  it('passes every real theme through', () => {
    for (const t of THEMES) expect(normalizeTheme(t)).toBe(t);
  });

  it('lands junk on the default rather than rejecting', () => {
    // A bad row or a stale client must not leave the app with a data-theme no
    // stylesheet answers to.
    for (const bad of [null, undefined, 42, {}, [], true, '', 'sepia']) {
      expect(normalizeTheme(bad)).toBe(DEFAULT_THEME);
    }
  });

  it('does not normalize casing or whitespace into a theme', () => {
    // The value is written by us and read as an exact attribute selector; a
    // near-miss is a bug upstream, not something to guess at.
    expect(normalizeTheme('DARK')).toBe(DEFAULT_THEME);
    expect(normalizeTheme('neon ')).toBe(DEFAULT_THEME);
  });

  it('defaults to light — never the operating system preference', () => {
    expect(DEFAULT_THEME).toBe('light');
  });
});

describe('THEME_LABELS', () => {
  it('names every theme', () => {
    for (const t of THEMES) expect(THEME_LABELS[t]).toBeTruthy();
  });
});
