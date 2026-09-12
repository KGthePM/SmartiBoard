import { describe, expect, it } from 'vitest';
import { NOTE_MAX, normalizeNotes } from './notes';

describe('normalizeNotes', () => {
  it('passes a well-formed list through, capping nothing that fits', () => {
    const input = [
      { id: 'a', text: 'first' },
      { id: 'b', text: 'second' },
    ];
    expect(normalizeNotes(input)).toEqual(input);
  });

  it('keeps write order — a note has no other order', () => {
    const input = [
      { id: 'b', text: 'second' },
      { id: 'a', text: 'first' },
    ];
    expect(normalizeNotes(input)).toEqual(input);
  });

  it('clamps text to NOTE_MAX', () => {
    const long = 'x'.repeat(NOTE_MAX + 50);
    const [note] = normalizeNotes([{ id: 'a', text: long }]);
    expect(note.text).toHaveLength(NOTE_MAX);
    expect(note.text).toBe('x'.repeat(NOTE_MAX));
  });

  it('drops a duplicate id, keeping the first occurrence', () => {
    expect(
      normalizeNotes([
        { id: 'a', text: 'first' },
        { id: 'a', text: 'second' },
      ]),
    ).toEqual([{ id: 'a', text: 'first' }]);
  });

  it('drops entries missing a string id or text', () => {
    expect(
      normalizeNotes([
        { id: 'a', text: 'ok' },
        { id: 1, text: 'bad id' },
        { id: 'b' },
        { text: 'no id' },
        null,
        'nope',
        42,
      ]),
    ).toEqual([{ id: 'a', text: 'ok' }]);
  });

  it('degrades anything malformed to none, like parseBoard', () => {
    for (const bad of [null, undefined, 42, {}, true, 'note', '']) {
      expect(normalizeNotes(bad)).toEqual([]);
    }
  });

  it('returns a fresh array, never the input', () => {
    const input = [{ id: 'a', text: 'x' }];
    expect(normalizeNotes(input)).not.toBe(input);
  });
});
