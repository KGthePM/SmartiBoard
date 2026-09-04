import { describe, expect, it } from 'vitest';
import { createNode, emptyBoard, type Board, type Edge } from '../graph';
import {
  clampQuestion,
  parseAnswer,
  QUESTION_MAX,
  scopeBoard,
  splitAnswer,
} from './ask';

function board(texts: string[]): Board {
  const b = emptyBoard('t');
  b.nodes = texts.map((t, i) => createNode({ id: `n${i}`, x: 0, y: 0, text: t }));
  return b;
}

function edge(from: string, to: string, i: number): Edge {
  return { id: `e${i}`, from, to, layer: 'user' };
}

describe('clampQuestion', () => {
  it('clamps past the cap rather than rejecting — a long paste is not hostile', () => {
    const long = 'a'.repeat(QUESTION_MAX + 100);
    expect(clampQuestion(long)).toBe('a'.repeat(QUESTION_MAX));
  });

  it('trims, so a capped question of spaces is empty', () => {
    expect(clampQuestion('   ')).toBe('');
    expect(clampQuestion('  where does auth happen?  ')).toBe('where does auth happen?');
  });
});

describe('splitAnswer', () => {
  it('passes through text with no marker in flight', () => {
    expect(splitAnswer('plain prose, no brackets')).toEqual({
      safe: 'plain prose, no brackets',
      rest: '',
    });
  });

  it('holds back a trailing partial marker — it has not finished arriving', () => {
    expect(splitAnswer('auth lives in [[lib/acce')).toEqual({
      safe: 'auth lives in ',
      rest: '[[lib/acce',
    });
    expect(splitAnswer('a [[n1] b [[n2')).toEqual({ safe: 'a [[n1] b ', rest: '[[n2' });
  });

  it('releases everything once the marker closes', () => {
    expect(splitAnswer('auth lives in [[lib/access]]')).toEqual({
      safe: 'auth lives in [[lib/access]]',
      rest: '',
    });
  });

  it('ignores a lone opening bracket — that is prose, not a marker', () => {
    expect(splitAnswer('array index [i] and [[n1')).toEqual({
      safe: 'array index [i] and ',
      rest: '[[n1',
    });
  });
});

describe('parseAnswer', () => {
  it('splits prose and citations into segments', () => {
    expect(parseAnswer('auth is [[n0]], config in [[n1]].', ['n0', 'n1'])).toEqual([
      { kind: 'text', text: 'auth is ' },
      { kind: 'cite', id: 'n0' },
      { kind: 'text', text: ', config in ' },
      { kind: 'cite', id: 'n1' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('drops an id that is not on the board, in silence — a hallucinated id is not a chip', () => {
    expect(parseAnswer('see [[n0]] and [[ghost]]', ['n0'])).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'cite', id: 'n0' },
      { kind: 'text', text: ' and ' },
    ]);
  });

  it('never emits an empty text segment', () => {
    const segs = parseAnswer('[[n0]][[n1]]', ['n0', 'n1']);
    expect(segs).toEqual([
      { kind: 'cite', id: 'n0' },
      { kind: 'cite', id: 'n1' },
    ]);
  });

  it('leading and trailing citations leave no empty prose at the ends', () => {
    expect(parseAnswer('[[n0]] does it', ['n0'])).toEqual([
      { kind: 'cite', id: 'n0' },
      { kind: 'text', text: ' does it' },
    ]);
    expect(parseAnswer('it is [[n0]]', ['n0'])).toEqual([
      { kind: 'text', text: 'it is ' },
      { kind: 'cite', id: 'n0' },
    ]);
  });

  it('an unclosed marker at the end of a finished answer is just prose', () => {
    expect(parseAnswer('cost is [[budget', ['budget'])).toEqual([
      { kind: 'text', text: 'cost is [[budget' },
    ]);
  });
});

describe('scopeBoard', () => {
  it('with no selection returns the board untouched — the whole-board case', () => {
    const b = board(['a', 'b']);
    expect(scopeBoard(b, [])).toBe(b);
  });

  it('keeps the selected nodes, their direct neighbours, and only edges among them', () => {
    // n0 — n1 — n2 — n3: selecting n1 keeps n0/n1/n2, drops n3.
    const b = board(['a', 'b', 'c', 'd']);
    b.edges = [edge('n0', 'n1', 0), edge('n1', 'n2', 1), edge('n2', 'n3', 2)];
    const scoped = scopeBoard(b, ['n1']);
    expect(scoped.nodes.map((n) => n.id).sort()).toEqual(['n0', 'n1', 'n2']);
    expect(scoped.edges).toEqual([{ id: 'e0', from: 'n0', to: 'n1', layer: 'user' }, { id: 'e1', from: 'n1', to: 'n2', layer: 'user' }]);
  });

  it('does not widen past one hop — a neighbour of a neighbour is not context', () => {
    const b = board(['a', 'b', 'c']);
    b.edges = [edge('n0', 'n1', 0), edge('n1', 'n2', 1)];
    const scoped = scopeBoard(b, ['n0']);
    expect(scoped.nodes.map((n) => n.id).sort()).toEqual(['n0', 'n1']);
  });

  it('an unknown id scopes to nothing rather than failing', () => {
    const b = board(['a']);
    const scoped = scopeBoard(b, ['zz']);
    expect(scoped.nodes).toEqual([]);
    expect(scoped.edges).toEqual([]);
  });

  it('carries title, objective, and privacy — the board is narrowed, not rewritten', () => {
    const b = board(['a', 'b']);
    b.objective = 'Understand the codebase.';
    b.privacy = true;
    const scoped = scopeBoard(b, ['n0']);
    expect(scoped.objective).toBe('Understand the codebase.');
    expect(scoped.privacy).toBe(true);
    expect(scoped.id).toBe(b.id);
  });
});
