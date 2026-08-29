import { describe, expect, it } from 'vitest';
import {
  parseRichText,
  sourceRange,
  stripMarks,
  stripMarksWithMap,
  toggleColor,
  toggleWrap,
} from './richtext';

describe('parseRichText', () => {
  it('returns nothing for empty text', () => {
    expect(parseRichText('')).toEqual([]);
  });

  it('passes plain text through unmarked', () => {
    expect(parseRichText('just an idea')).toEqual([{ text: 'just an idea' }]);
  });

  it('parses each mark', () => {
    expect(parseRichText('**bold**')).toEqual([{ text: 'bold', bold: true }]);
    expect(parseRichText('*italic*')).toEqual([{ text: 'italic', italic: true }]);
    expect(parseRichText('__underline__')).toEqual([{ text: 'underline', underline: true }]);
    expect(parseRichText('~~strike~~')).toEqual([{ text: 'strike', strike: true }]);
    expect(parseRichText('{{red|note}}')).toEqual([{ text: 'note', color: 'red' }]);
  });

  it('splits mixed text into segments', () => {
    expect(parseRichText('a **b** c')).toEqual([
      { text: 'a ' },
      { text: 'b', bold: true },
      { text: ' c' },
    ]);
  });

  it('nests marks', () => {
    expect(parseRichText('**a *b* c**')).toEqual([
      { text: 'a ', bold: true },
      { text: 'b', bold: true, italic: true },
      { text: ' c', bold: true },
    ]);
    expect(parseRichText('{{blue|**x**}}')).toEqual([{ text: 'x', bold: true, color: 'blue' }]);
  });

  it('lets the innermost color win in nested colors', () => {
    expect(parseRichText('{{red|a {{blue|b}} c}}')).toEqual([
      { text: 'a ', color: 'red' },
      { text: 'b', color: 'blue' },
      { text: ' c', color: 'red' },
    ]);
  });

  it('keeps unmatched markers literal', () => {
    expect(parseRichText('**bold')).toEqual([{ text: '**bold' }]);
    expect(parseRichText('bold**')).toEqual([{ text: 'bold**' }]);
    expect(parseRichText('an ~ odd}} brace')).toEqual([{ text: 'an ~ odd}} brace' }]);
  });

  it('does not emphasize around spaces — arithmetic stays literal', () => {
    expect(parseRichText('3 * 4 * 5')).toEqual([{ text: '3 * 4 * 5' }]);
    expect(parseRichText('a ** b ** c')).toEqual([{ text: 'a ** b ** c' }]);
  });

  it('ignores colors outside the palette', () => {
    expect(parseRichText('{{purple|x}}')).toEqual([{ text: '{{purple|x}}' }]);
  });

  it('renders exactly the stripped text across segments', () => {
    const samples = [
      'a **b** *c* __d__ ~~e~~ {{red|f}}',
      '**a *b* {{green|c}}** tail',
      'literal ** and * stars',
      '',
    ];
    for (const s of samples) {
      expect(parseRichText(s).map((seg) => seg.text).join('')).toBe(stripMarks(s));
    }
  });
});

describe('stripMarks', () => {
  it('removes matched markers', () => {
    expect(stripMarks('**a** *b* __c__ ~~d~~ {{red|e}}')).toBe('a b c d e');
  });

  it('keeps unmatched markers as literal text', () => {
    expect(stripMarks('2**3 and 4 * 5')).toBe('2**3 and 4 * 5');
    expect(stripMarks('**unclosed')).toBe('**unclosed');
  });

  it('empties to empty', () => {
    expect(stripMarks('')).toBe('');
  });
});

describe('toggleWrap', () => {
  it('wraps a selection', () => {
    expect(toggleWrap('say hello now', 4, 9, '**', '**')).toEqual({
      text: 'say **hello** now',
      start: 4,
      end: 13,
    });
  });

  it('keeps edge whitespace outside the markers', () => {
    expect(toggleWrap('a b c', 1, 4, '**', '**')).toEqual({
      text: 'a **b** c',
      start: 2,
      end: 7,
    });
  });

  it('unwraps when the selection includes the markers', () => {
    expect(toggleWrap('**hello** world', 0, 9, '**', '**')).toEqual({
      text: 'hello world',
      start: 0,
      end: 5,
    });
  });

  it('unwraps when the markers hug the selection', () => {
    expect(toggleWrap('**hello** world', 2, 7, '**', '**')).toEqual({
      text: 'hello world',
      start: 0,
      end: 5,
    });
  });

  it('is a no-op on an empty selection', () => {
    expect(toggleWrap('hello', 2, 2, '**', '**')).toEqual({ text: 'hello', start: 2, end: 2 });
  });
});

describe('toggleColor', () => {
  it('wraps a selection', () => {
    expect(toggleColor('note this', 0, 4, 'red')).toEqual({
      text: '{{red|note}} this',
      start: 0,
      end: 12,
    });
  });

  it('unwraps the same color', () => {
    expect(toggleColor('{{red|note}} this', 0, 13, 'red')).toEqual({
      text: 'note this',
      start: 0,
      end: 4,
    });
  });

  it('swaps a different color in place', () => {
    expect(toggleColor('{{red|note}} this', 0, 13, 'blue')).toEqual({
      text: '{{blue|note}} this',
      start: 0,
      end: 13,
    });
  });

  it('unwraps when the markers hug the selection', () => {
    expect(toggleColor('{{red|note}} this', 6, 10, 'red')).toEqual({
      text: 'note this',
      start: 0,
      end: 4,
    });
  });

  it('flattens a different-color pair inside the selection instead of nesting', () => {
    // The reported bug: selecting `dd text {{amber|formatting}}` and applying
    // green used to nest markers — A{{green|dd text {{amber|formatting}}}}.
    expect(toggleColor('Add text {{amber|formatting}}', 1, 29, 'green')).toEqual({
      text: 'A{{green|dd text formatting}}',
      start: 1,
      end: 29,
    });
  });

  it('flattens inner pairs when swapping the color that wraps the selection', () => {
    expect(toggleColor('{{green|a {{amber|b}} c}} x', 0, 25, 'blue')).toEqual({
      text: '{{blue|a b c}} x',
      start: 0,
      end: 14,
    });
  });

  it('flattens inner pairs when swapping via markers hugging the selection', () => {
    expect(toggleColor('{{red|a {{amber|b}} c}} x', 6, 21, 'blue')).toEqual({
      text: '{{blue|a b c}} x',
      start: 0,
      end: 14,
    });
  });

  it('unwrapping the outer color reveals the inner one', () => {
    expect(toggleColor('{{green|a {{amber|b}} c}} x', 0, 25, 'green')).toEqual({
      text: 'a {{amber|b}} c x',
      start: 0,
      end: 15,
    });
  });

  it('keeps emphasis markers inside the selection', () => {
    expect(toggleColor('say **bold** thing', 4, 12, 'red')).toEqual({
      text: 'say {{red|**bold**}} thing',
      start: 4,
      end: 20,
    });
  });
});

const SAMPLES = [
  'a **b** *c* __d__ ~~e~~ {{red|f}}',
  '**a *b* {{green|c}}** tail',
  'literal ** and * stars',
  '2**3 and 4 * 5',
  'plain',
  '',
];

describe('stripMarksWithMap', () => {
  it('agrees with stripMarks on the plain text', () => {
    for (const s of SAMPLES) {
      expect(stripMarksWithMap(s).plain).toBe(stripMarks(s));
    }
  });

  it('gives one source index per plain character', () => {
    for (const s of SAMPLES) {
      const { plain, map } = stripMarksWithMap(s);
      expect(map).toHaveLength(plain.length);
      // Every mapped index points at the very character it stands for.
      map.forEach((at, i) => expect(s[at]).toBe(plain[i]));
    }
  });

  it('steps over matched markers', () => {
    // `**bold**` — the b of "bold" is the third character of the source.
    expect(stripMarksWithMap('**bold**')).toEqual({ plain: 'bold', map: [2, 3, 4, 5] });
    expect(stripMarksWithMap('{{red|x}}')).toEqual({ plain: 'x', map: [6] });
  });

  it('maps unmatched markers to themselves — they are literal text', () => {
    const { plain, map } = stripMarksWithMap('2 * 3');
    expect(plain).toBe('2 * 3');
    expect(map).toEqual([0, 1, 2, 3, 4]);
  });

  it('is monotonic, so a plain range can never map backwards', () => {
    for (const s of SAMPLES) {
      const { map } = stripMarksWithMap(s);
      for (let i = 1; i < map.length; i += 1) expect(map[i]).toBeGreaterThan(map[i - 1]);
    }
  });
});

describe('sourceRange', () => {
  it('locates a range that sits inside one run of text', () => {
    const { map } = stripMarksWithMap('**hello** world');
    // "hello" is plain 0..5, source 2..7.
    expect(sourceRange(map, 0, 5)).toEqual([2, 7]);
    // "world" is plain 6..11, source 10..15 — the markers before it shift it.
    expect(sourceRange(map, 6, 11)).toEqual([10, 15]);
  });

  it('refuses a range that straddles a matched marker pair', () => {
    // `he**llo**` reads as "hello", but splicing 0..5 would orphan the closing **.
    const { plain, map } = stripMarksWithMap('he**llo**');
    expect(plain).toBe('hello');
    expect(sourceRange(map, 0, 5)).toBeNull();
    // The half that lives inside the bold run is still spliceable.
    expect(sourceRange(map, 2, 5)).toEqual([4, 7]);
  });

  it('is unbothered by markers that merely sit beside the range', () => {
    const { map } = stripMarksWithMap('say **hello**');
    expect(sourceRange(map, 4, 9)).toEqual([6, 11]);
  });

  it('returns null for an empty or out-of-bounds range', () => {
    const { map } = stripMarksWithMap('abc');
    expect(sourceRange(map, 1, 1)).toBeNull();
    expect(sourceRange(map, 0, 9)).toBeNull();
    expect(sourceRange(map, -1, 2)).toBeNull();
  });
});
