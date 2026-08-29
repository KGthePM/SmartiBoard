import { describe, expect, it } from 'vitest';
import {
  normalizeReactions,
  REACTIONS,
  REACTION_GLYPH,
  REACTION_LABEL,
  toggleReaction,
} from './reactions';

describe('normalizeReactions', () => {
  it('passes a real list through in REACTIONS order', () => {
    expect(normalizeReactions([...REACTIONS])).toEqual([...REACTIONS]);
  });

  it('reorders to the canonical order, whatever order they were clicked in', () => {
    // Two cards carrying the same marks must render identically.
    expect(normalizeReactions(['down', 'love'])).toEqual(['love', 'down']);
    expect(normalizeReactions(['love', 'down'])).toEqual(['love', 'down']);
  });

  it('drops unknown keys rather than rendering a blank chip', () => {
    expect(normalizeReactions(['love', 'shrug', 'fire'])).toEqual(['love', 'fire']);
    expect(normalizeReactions(['nope'])).toEqual([]);
  });

  it('collapses duplicates', () => {
    expect(normalizeReactions(['love', 'love', 'love'])).toEqual(['love']);
  });

  it('degrades anything malformed to none, like parseBoard', () => {
    for (const bad of [null, undefined, 42, {}, true, 'love', '']) {
      expect(normalizeReactions(bad)).toEqual([]);
    }
  });

  it('survives a mixed array of junk', () => {
    expect(normalizeReactions([null, 3, {}, 'fire', ['love']])).toEqual(['fire']);
  });

  it('returns a fresh array, never the input', () => {
    const input = ['love'];
    expect(normalizeReactions(input)).not.toBe(input);
  });
});

describe('toggleReaction', () => {
  it('adds a mark that is absent and removes one that is present', () => {
    expect(toggleReaction([], 'fire')).toEqual(['fire']);
    expect(toggleReaction(['fire'], 'fire')).toEqual([]);
  });

  it('keeps the canonical order however the marks arrive', () => {
    let list = toggleReaction([], 'down');
    list = toggleReaction(list, 'love');
    list = toggleReaction(list, 'bang');
    expect(list).toEqual(['love', 'bang', 'down']);
  });

  it('touches only the mark named', () => {
    expect(toggleReaction(['love', 'down'], 'down')).toEqual(['love']);
  });

  it('is pure: the input list is never mutated', () => {
    const before: Array<(typeof REACTIONS)[number]> = ['love'];
    toggleReaction(before, 'fire');
    expect(before).toEqual(['love']);
  });

  it('round-trips — the same key twice is a no-op', () => {
    for (const key of REACTIONS) {
      expect(toggleReaction(toggleReaction(['bang'], key), key)).toEqual(['bang']);
    }
  });
});

describe('the set itself', () => {
  it('gives every reaction a glyph and a name', () => {
    for (const key of REACTIONS) {
      expect(REACTION_GLYPH[key]).toBeTruthy();
      expect(REACTION_LABEL[key]).toBeTruthy();
    }
  });

  it('stays small enough for a card to hold', () => {
    // The strip sits under a card at the 120px width floor. Growing this set
    // is a layout decision, not a data one — see .reactions in globals.css.
    expect(REACTIONS).toHaveLength(5);
    expect(new Set(REACTIONS).size).toBe(REACTIONS.length);
  });
});
