import { describe, expect, it } from 'vitest';
import { createNode, emptyBoard, type Board } from '../graph';
import { SUMMARY_SYSTEM_PROMPT, summaryInstruction } from './summary-prompt';

function board(texts: string[]): Board {
  const b = emptyBoard('t');
  b.nodes = texts.map((t, i) => createNode({ id: `n${i}`, x: 0, y: 0, text: t }));
  return b;
}

describe('summaryInstruction', () => {
  it('never shows formatting markers to the model', () => {
    const out = summaryInstruction(board(['**pricing** *risk*', '{{red|churn}}', 'plain ~~idea~~']));
    expect(out).toContain('pricing risk');
    expect(out).toContain('churn');
    expect(out).toContain('plain idea');
    expect(out).not.toMatch(/\*\*|\{\{|~~|__/);
  });

  it('omits coordinates — layout is the user’s business', () => {
    const out = summaryInstruction(board(['a', 'b', 'c']));
    expect(out).not.toMatch(/\b\d{2,}\b/);
  });

  it('asks for a gist and observations, not a gap-fill', () => {
    const out = summaryInstruction(board(['a', 'b', 'c']));
    expect(out).toContain('gist');
    expect(out).toContain('observations');
    expect(out).not.toContain('gap-fill');
  });

  it('does not carry the ghost’s dismissal list into a read', () => {
    const out = summaryInstruction(board(['a', 'b', 'c']));
    expect(out).not.toContain('dismissed');
  });
});

describe('SUMMARY_SYSTEM_PROMPT', () => {
  it('specifies the output shape: gist line plus dash bullets', () => {
    expect(SUMMARY_SYSTEM_PROMPT).toContain('gist');
    expect(SUMMARY_SYSTEM_PROMPT).toContain('"- "');
    expect(SUMMARY_SYSTEM_PROMPT).toContain('plain text');
  });

  it('keeps the summary descriptive — advice is capped at one noticed thing', () => {
    expect(SUMMARY_SYSTEM_PROMPT).toContain('At most one observation may point forward');
    expect(SUMMARY_SYSTEM_PROMPT).not.toContain('CRITICAL');
    expect(SUMMARY_SYSTEM_PROMPT).not.toContain('MUST');
  });

  it('opens with the gist so the stream leads with meaning', () => {
    expect(SUMMARY_SYSTEM_PROMPT).toContain('begin with the gist line');
  });
});

describe('the objective in a read', () => {
  it('carries the objective through to the reader', () => {
    const b = { ...board(['a', 'b', 'c']), objective: 'Win back churned design teams.' };
    expect(summaryInstruction(b)).toContain('Win back churned design teams.');
  });

  it('tells the reader to read the board against it, without echoing it back', () => {
    expect(SUMMARY_SYSTEM_PROMPT).toContain('read the ideas against it');
    expect(SUMMARY_SYSTEM_PROMPT).toContain('never restate the objective');
  });
});
