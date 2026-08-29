import { describe, expect, it } from 'vitest';
import { createNode, emptyBoard, type Board } from '../graph';
import { serializeBoard } from './prompt';

function board(texts: string[]): Board {
  const b = emptyBoard('t');
  b.nodes = texts.map((t, i) => createNode({ id: `n${i}`, x: 0, y: 0, text: t }));
  return b;
}

describe('serializeBoard', () => {
  it('never shows formatting markers to the model', () => {
    const out = serializeBoard(
      board(['**pricing** *risk*', '{{red|churn}}', 'plain ~~idea~~']),
      [],
    );
    expect(out).toContain('pricing risk');
    expect(out).toContain('churn');
    expect(out).toContain('plain idea');
    expect(out).not.toMatch(/\*\*|\{\{|~~|__/);
  });

  it('keeps anchors as ids so placement still works', () => {
    const out = serializeBoard(board(['a', 'b']), []);
    expect(out).toContain('- n0 [user]: a');
    expect(out).toContain('- n1 [user]: b');
  });

  it('tells the model which ideas are crossed off', () => {
    const b = board(['a', 'b']);
    b.nodes[1] = { ...b.nodes[1], done: true };
    const out = serializeBoard(b, []);
    expect(out).toContain('- n0 [user]: a');
    expect(out).toContain('- n1 [user, done]: b');
    expect(out).toContain('considers finished');
  });

  it('adds no done legend when nothing is crossed off', () => {
    const out = serializeBoard(board(['a', 'b']), []);
    expect(out).not.toContain('done');
  });

  it('lists dismissed suggestions for the model to avoid', () => {
    const out = serializeBoard(board(['a', 'b', 'c']), ['pricing tier']);
    expect(out).toContain('- pricing tier');
  });
});

describe('the objective in the prompt', () => {
  it('leads the board, so the model is framed before it sees an idea', () => {
    const b = { ...board(['pricing', 'churn']), objective: 'Win back churned design teams.' };
    const out = serializeBoard(b, []);
    expect(out).toContain("What this board is for, in the person's own words:");
    expect(out).toContain('Win back churned design teams.');
    expect(out.indexOf('Win back churned')).toBeLessThan(out.indexOf('Ideas on the board:'));
  });

  it('leaves no trace when unset — an empty header invites the model to fill it', () => {
    const out = serializeBoard(board(['pricing', 'churn']), []);
    expect(out).not.toContain('What this board is for');
    expect(out.startsWith('Ideas on the board:')).toBe(true);
  });

  it('is not treated as an idea: node ids still anchor proposals', () => {
    const b = { ...board(['pricing', 'churn']), objective: 'Win back churned teams.' };
    const out = serializeBoard(b, []);
    expect(out).toContain('- n0 [user]: pricing');
    expect(out).toContain('- n1 [user]: churn');
  });
});
