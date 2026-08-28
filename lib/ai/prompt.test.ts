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

  it('lists dismissed suggestions for the model to avoid', () => {
    const out = serializeBoard(board(['a', 'b', 'c']), ['pricing tier']);
    expect(out).toContain('- pricing tier');
  });
});
