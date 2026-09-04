import { describe, expect, it } from 'vitest';
import { createNode, emptyBoard, type Board, type Edge } from '../graph';
import {
  ASK_HISTORY_TURNS,
  ASK_SYSTEM_PROMPT,
  askInstruction,
  fitHistory,
  fitMaxNodes,
  HISTORY_ANSWER_MAX,
} from './ask-prompt';
import { clampQuestion, QUESTION_MAX } from './ask';

function board(texts: string[]): Board {
  const b = emptyBoard('t');
  b.nodes = texts.map((t, i) => createNode({ id: `n${i}`, x: 0, y: 0, text: t }));
  return b;
}

function edge(from: string, to: string, i: number): Edge {
  return { id: `e${i}`, from, to, layer: 'user' };
}

describe('ASK_SYSTEM_PROMPT', () => {
  it('states the citation format and the read-only rule', () => {
    expect(ASK_SYSTEM_PROMPT).toContain('[[nodeId]]');
    expect(ASK_SYSTEM_PROMPT).toContain('Never propose changes to the board');
    expect(ASK_SYSTEM_PROMPT).toContain(`doesn't say`);
  });
});

describe('fitHistory', () => {
  it('keeps only the last ASK_HISTORY_TURNS turns', () => {
    const turns = [1, 2, 3, 4, 5].map((i) => ({ question: `q${i}`, answer: `a${i}` }));
    expect(fitHistory(turns)).toEqual([
      { question: 'q3', answer: 'a3' },
      { question: 'q4', answer: 'a4' },
      { question: 'q5', answer: 'a5' },
    ]);
    expect(ASK_HISTORY_TURNS).toBe(3);
  });

  it('trims a replayed answer to HISTORY_ANSWER_MAX — a client is only a client', () => {
    const long = 'x'.repeat(HISTORY_ANSWER_MAX * 3);
    const fitted = fitHistory([{ question: 'q', answer: long }]);
    expect(fitted[0].answer.length).toBe(HISTORY_ANSWER_MAX);
  });

  it('re-clamps the replayed questions, closing the prompt-injection-by-history path', () => {
    const long = 'q'.repeat(QUESTION_MAX + 500);
    const fitted = fitHistory([{ question: long, answer: 'a' }]);
    expect(fitted[0].question).toBe(clampQuestion(long));
  });
});

describe('fitMaxNodes', () => {
  it('returns null when the whole board fits — no truncation, no disclosure', () => {
    expect(fitMaxNodes(board(['a', 'b', 'c']))).toBeNull();
  });

  it('stops counting once the node lines pass the budget, and agrees with the serializer about which cards survive', () => {
    // ~83 tokens per card line × 500 cards ≈ 41.5K — past the 40K ceiling.
    const over = board(Array.from({ length: 500 }, (_, i) => `file${i}.ts ${'s'.repeat(300)}`));
    const max = fitMaxNodes(over);
    expect(max).not.toBeNull();
    expect(max!).toBeGreaterThan(0);
    expect(max!).toBeLessThan(500);

    // The cards the serializer keeps under that maxNodes are the same cards
    // the walk counted: the first `max` substantive nodes, in board order.
    const { kept, total } = askInstruction(over, 'where is auth?');
    expect(kept).toBe(max);
    expect(total).toBe(500);
  });

  it('an enormous edge count eats the budget before any node is counted', () => {
    const b = board(['a', 'b']);
    // ~60K tokens of edge endpoints alone — past the ceiling with zero nodes.
    for (let i = 0; i < 5000; i += 1) {
      b.edges.push(edge(`prefix-that-is-long-${i % 2}`, `other-prefix-${i}`, i));
    }
    expect(fitMaxNodes(b)).toBe(0);
  });

  it('skips empty cards the way the serializer does — they cost no budget', () => {
    const b = board(['   ', 'a']);
    expect(fitMaxNodes(b)).toBeNull();
  });
});

describe('askInstruction', () => {
  it('leads with the serialized board and ends with the question', () => {
    const { instruction } = askInstruction(board(['a', 'b']), 'where does auth happen?');
    expect(instruction.startsWith('Ideas on the board:')).toBe(true);
    expect(instruction.endsWith('Question about this board: where does auth happen?')).toBe(true);
  });

  it('renders edges by id — the scale knob the folder map needs', () => {
    const b = board(['a', 'b']);
    b.edges = [edge('n0', 'n1', 0)];
    const { instruction } = askInstruction(b, 'q');
    expect(instruction).toContain('- n0 — n1');
    expect(instruction).not.toContain('- a — b');
  });

  it('clamps the question into the turn', () => {
    const { instruction } = askInstruction(board(['a']), 'x'.repeat(QUESTION_MAX + 50));
    expect(instruction.endsWith(`Question about this board: ${'x'.repeat(QUESTION_MAX)}`)).toBe(
      true,
    );
  });

  it('reports kept === total when nothing was dropped', () => {
    const { kept, total } = askInstruction(board(['a', 'b', 'c']), 'q');
    expect(kept).toBe(3);
    expect(total).toBe(3);
  });

  it('reports the honest counts under truncation, and the serializer discloses the drop', () => {
    const b = board(Array.from({ length: 500 }, (_, i) => `file${i}.ts ${'s'.repeat(300)}`));
    const { instruction, kept, total } = askInstruction(b, 'q');
    expect(kept).toBeLessThan(total);
    expect(instruction).toContain(`(${total - kept} more card`);
  });
});
