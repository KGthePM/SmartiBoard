import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPTIONS,
  findMatches,
  markMatches,
  planReplaceAll,
  replaceInText,
  type Match,
  type SearchOptions,
} from './search';
import { createNode, emptyBoard, type Board, type IdeaNode } from './graph';
import { parseRichText, stripMarks } from './richtext';

function board(nodes: Partial<IdeaNode>[], objective = ''): Board {
  const b = emptyBoard('t');
  b.objective = objective;
  b.nodes = nodes.map((n, i) => createNode({ x: 0, y: i * 100, id: `n${i}`, ...n }));
  return b;
}

const opts = (o: Partial<SearchOptions> = {}): SearchOptions => ({ ...DEFAULT_OPTIONS, ...o });

/** The plain text of a match, for readable assertions. */
function texts(b: Board, ms: Match[]): string[] {
  return ms.map(({ target, start, end }) => {
    const src =
      target.kind === 'objective'
        ? b.objective
        : stripMarks(b.nodes.find((n) => n.id === target.id)!.text);
    return src.slice(start, end);
  });
}

describe('findMatches', () => {
  it('finds nothing for an empty query, however full the board', () => {
    expect(findMatches(board([{ text: 'pricing' }]), '', opts())).toEqual([]);
  });

  it('matches what the reader sees, not what is stored', () => {
    // The markers are invisible on the card, so they must be invisible here.
    const b = board([{ text: 'the **pricing** page' }]);
    const ms = findMatches(b, 'pricing page', opts());
    expect(ms).toHaveLength(1);
    expect(texts(b, ms)).toEqual(['pricing page']);
  });

  it('is case-insensitive by default and exact when asked', () => {
    const b = board([{ text: 'Pricing and pricing' }]);
    expect(findMatches(b, 'pricing', opts())).toHaveLength(2);
    expect(findMatches(b, 'pricing', opts({ caseSensitive: true }))).toHaveLength(1);
  });

  it('honours whole-word, and keeps scanning past a rejected boundary', () => {
    const b = board([{ text: 'repricing and pricing' }]);
    const ms = findMatches(b, 'pricing', opts({ wholeWord: true }));
    expect(ms).toHaveLength(1);
    // The one it kept is the standalone word, not the tail of "repricing".
    expect(ms[0].start).toBe(14);
  });

  it('treats the whole-word boundary as letters and digits in any script', () => {
    const b = board([{ text: 'prix-fixe and prixé' }]);
    expect(findMatches(b, 'prix', opts({ wholeWord: true }))).toHaveLength(1);
  });

  it('never overlaps matches', () => {
    // "aa" in "aaa" is one hit, not two.
    expect(findMatches(board([{ text: 'aaa' }]), 'aa', opts())).toHaveLength(1);
  });

  it('reads the board top to bottom, the objective first', () => {
    const b = board(
      [
        { text: 'lower card: pricing', y: 200 },
        { text: 'upper card: pricing', y: 10 },
      ],
      'objective: pricing',
    );
    const ms = findMatches(b, 'pricing', opts());
    expect(ms.map((m) => m.target)).toEqual([
      { kind: 'objective' },
      { kind: 'node', id: 'n1' },
      { kind: 'node', id: 'n0' },
    ]);
  });

  it('orders cards on the same row from left to right', () => {
    const b = board([
      { text: 'right pricing', x: 500, y: 0 },
      { text: 'left pricing', x: 0, y: 0 },
    ]);
    expect(findMatches(b, 'pricing', opts()).map((m) => m.target)).toEqual([
      { kind: 'node', id: 'n1' },
      { kind: 'node', id: 'n0' },
    ]);
  });

  it('searches crossed-off cards — done is still content', () => {
    expect(findMatches(board([{ text: 'pricing', done: true }]), 'pricing', opts())).toHaveLength(1);
  });

  it('searches accepted cards as well as the user’s own', () => {
    const b = board([{ text: 'pricing', layer: 'accepted' }]);
    expect(findMatches(b, 'pricing', opts())).toHaveLength(1);
  });

  it('reads the objective as plain text, markers and all', () => {
    // The objective is typed into a bare textarea and never parsed, so `**`
    // there is two asterisks, not a marker.
    const b = board([], 'ship **fast**');
    expect(findMatches(b, '**fast**', opts())).toHaveLength(1);
    expect(findMatches(b, 'ship fast', opts())).toHaveLength(0);
  });

  it('flags a match that straddles formatting as unreplaceable', () => {
    const b = board([{ text: 'he**llo** world' }]);
    const [m] = findMatches(b, 'hello', opts());
    expect(m.replaceable).toBe(false);
  });

  it('leaves a match inside one run replaceable, markers or not', () => {
    const b = board([{ text: '**hello** world' }]);
    expect(findMatches(b, 'hello', opts())[0].replaceable).toBe(true);
    expect(findMatches(b, 'world', opts())[0].replaceable).toBe(true);
  });
});

describe('replaceInText', () => {
  it('rewrites the stored text and keeps the markup', () => {
    const b = board([{ text: 'the **pricing** page' }]);
    const out = replaceInText(b.nodes[0].text, findMatches(b, 'pricing', opts()), 'billing');
    expect(out).toBe('the **billing** page');
    expect(stripMarks(out)).toBe('the billing page');
  });

  it('applies several matches in one pass without shifting the later ones', () => {
    const b = board([{ text: 'a **a** a' }]);
    expect(replaceInText(b.nodes[0].text, findMatches(b, 'a', opts()), 'zz')).toBe('zz **zz** zz');
  });

  it('leaves an unreplaceable match byte-identical', () => {
    const b = board([{ text: 'he**llo** hello' }]);
    const ms = findMatches(b, 'hello', opts());
    expect(ms.map((m) => m.replaceable)).toEqual([false, true]);
    expect(replaceInText(b.nodes[0].text, ms, 'bye')).toBe('he**llo** bye');
  });

  it('treats non-rich text literally', () => {
    expect(replaceInText('a **b** a', findMatches(board([], 'a **b** a'), 'a', opts()), 'z', false))
      .toBe('z **b** z');
  });
});

describe('planReplaceAll', () => {
  it('counts what it did and what it refused', () => {
    const b = board(
      [{ text: 'he**llo** there' }, { text: 'hello again' }],
      'say hello',
    );
    const plan = planReplaceAll(b, 'hello', opts(), 'hi');
    expect(plan.replaced).toBe(2);
    expect(plan.skipped).toBe(1);
    expect(plan.objective).toBe('say hi');
    // Only the card that actually changed is in the batch.
    expect(plan.nodes).toEqual([{ id: 'n1', text: 'hi again' }]);
  });

  it('reports no objective edit when the objective was untouched', () => {
    const plan = planReplaceAll(board([{ text: 'hello' }], 'nothing here'), 'hello', opts(), 'hi');
    expect(plan.objective).toBeNull();
  });

  it('is a no-op plan when nothing matches', () => {
    expect(planReplaceAll(board([{ text: 'hello' }]), 'zzz', opts(), 'hi')).toEqual({
      nodes: [],
      objective: null,
      replaced: 0,
      skipped: 0,
    });
  });

  it('keeps every card’s markup across a board-wide rename', () => {
    const b = board([
      { text: '**pricing** tiers' },
      { text: '{{red|pricing}} risk' },
      { text: 'plain pricing' },
    ]);
    const plan = planReplaceAll(b, 'pricing', opts(), 'billing');
    expect(plan.nodes.map((n) => n.text)).toEqual([
      '**billing** tiers',
      '{{red|billing}} risk',
      'plain billing',
    ]);
    // What the reader sees is exactly the old text with the word swapped.
    for (const n of plan.nodes) {
      const before = stripMarks(b.nodes.find((x) => x.id === n.id)!.text);
      expect(stripMarks(n.text)).toBe(before.replace('pricing', 'billing'));
    }
  });
});

describe('markMatches', () => {
  it('returns the segments untouched when there is nothing to mark', () => {
    const segs = parseRichText('**bold** plain');
    expect(markMatches(segs, [], null)).toBe(segs);
  });

  it('splits a segment around the match', () => {
    const b = board([{ text: 'the pricing page' }]);
    const out = markMatches(parseRichText(b.nodes[0].text), findMatches(b, 'pricing', opts()), 0);
    expect(out).toEqual([
      { text: 'the ' },
      { text: 'pricing', hit: 'active' },
      { text: ' page' },
    ]);
  });

  it('marks only the active match as active', () => {
    const b = board([{ text: 'a a a' }]);
    const out = markMatches(parseRichText(b.nodes[0].text), findMatches(b, 'a', opts()), 1);
    expect(out.filter((s) => s.hit).map((s) => s.hit)).toEqual(['on', 'active', 'on']);
  });

  it('carries the segment’s own marks onto both halves of a split', () => {
    const b = board([{ text: '**the pricing page**' }]);
    const out = markMatches(parseRichText(b.nodes[0].text), findMatches(b, 'pricing', opts()), null);
    expect(out).toEqual([
      { text: 'the ', bold: true },
      { text: 'pricing', bold: true, hit: 'on' },
      { text: ' page', bold: true },
    ]);
  });

  it('spans a match that crosses a formatting boundary', () => {
    const b = board([{ text: 'he**llo**' }]);
    const out = markMatches(parseRichText(b.nodes[0].text), findMatches(b, 'hello', opts()), 0);
    expect(out).toEqual([
      { text: 'he', hit: 'active' },
      { text: 'llo', bold: true, hit: 'active' },
    ]);
  });

  it('still renders exactly the stripped text', () => {
    // The same invariant parseRichText holds, extended through the split: a
    // highlight must never add or drop a character.
    const samples = [
      'a **b** *c* __d__ ~~e~~ {{red|f}}',
      '**a *b* {{green|c}}** tail',
      'literal ** and * stars',
      'aaa',
    ];
    for (const text of samples) {
      const b = board([{ text }]);
      for (const q of ['a', 'b', ' ', 'star']) {
        const out = markMatches(parseRichText(text), findMatches(b, q, opts()), 0);
        expect(out.map((s) => s.text).join('')).toBe(stripMarks(text));
        // And never an empty span, which would render as a stray tinted sliver.
        expect(out.every((s) => s.text.length > 0)).toBe(true);
      }
    }
  });
});
