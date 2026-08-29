import { describe, expect, it } from 'vitest';
import { createNode, emptyBoard, type Board } from '../graph';
import { ideasInstruction } from './ideas-prompt';

function board(texts: string[]): Board {
  const b = emptyBoard('t');
  b.nodes = texts.map((t, i) => createNode({ id: `n${i}`, x: 0, y: 0, text: t }));
  return b;
}

describe('ideasInstruction', () => {
  it('asks about the whole board when nothing is selected', () => {
    const out = ideasInstruction(board(['pricing', 'onboarding']), null);
    expect(out).toContain('Offer ideas for this board.');
    expect(out).not.toContain('Branch from');
  });

  it('leads with the objective, like every other behavior', () => {
    // serializeBoardContent is shared, so the generator and the ghost can never
    // disagree about what is on the board.
    const b = { ...board(['pricing']), objective: 'Launch in the EU first' };
    expect(ideasInstruction(b, null)).toContain('Launch in the EU first');
  });

  it('names the seed card and its id when one is selected', () => {
    const out = ideasInstruction(board(['pricing', 'onboarding']), 'n1');
    expect(out).toContain('Branch from this one idea: n1: onboarding');
  });

  it('strips formatting markers out of the seed, as the board view does', () => {
    const out = ideasInstruction(board(['**pricing** is {{red|hard}}']), 'n0');
    expect(out).toContain('Branch from this one idea: n0: pricing is hard');
    expect(out).not.toContain('{{red|');
  });

  it('falls back to the whole board when the seed is gone or empty', () => {
    // The card may have been deleted, or emptied, while the panel was open.
    expect(ideasInstruction(board(['pricing']), 'n9')).toContain('Offer ideas for this board.');
    expect(ideasInstruction(board(['   ']), 'n0')).toContain('Offer ideas for this board.');
  });

  it('carries the JSONL contract, since no schema constrains this call', () => {
    expect(ideasInstruction(board(['pricing']), null)).toContain('one JSON object per line');
  });
});
