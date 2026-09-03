import { describe, expect, it } from 'vitest';
import {
  folderInstruction,
  FOLDER_SUMMARY_MAX_CHARS,
  summaryFromLine,
  summaryMaxTokens,
} from './folder-prompt';

describe('summaryFromLine', () => {
  const paths = new Set(['src/a.ts', 'src/b.ts']);

  it('accepts a well-formed line and echoes the path', () => {
    expect(summaryFromLine('{"path":"src/a.ts","summary":"Boots the app."}', paths)).toEqual({
      path: 'src/a.ts',
      summary: 'Boots the app.',
    });
  });

  it('drops a line whose path was not in the batch — no card for nobody', () => {
    expect(summaryFromLine('{"path":"src/zz.ts","summary":"Nope."}', paths)).toBeNull();
    expect(summaryFromLine('{"path":"","summary":"Nope."}', paths)).toBeNull();
  });

  it('drops missing halves and collapses whitespace into one line, capped', () => {
    expect(summaryFromLine('{"path":"src/a.ts"}', paths)).toBeNull();
    expect(summaryFromLine('{"path":"src/a.ts","summary":"   "}', paths)).toBeNull();
    expect(summaryFromLine('{"summary":"No path."}', paths)).toBeNull();
    const noisy = summaryFromLine(
      `{"path":"src/a.ts","summary":"boots\\n  the\\t app"}`,
      paths,
    );
    expect(noisy?.summary).toBe('boots the app');
    const long = 'x'.repeat(FOLDER_SUMMARY_MAX_CHARS + 50);
    expect(summaryFromLine(`{"path":"src/a.ts","summary":"${long}"}`, paths)?.summary).toHaveLength(
      FOLDER_SUMMARY_MAX_CHARS,
    );
  });

  it('recovers JSON from a fence or stray prose, like every JSONL contract here', () => {
    const fenced = '```json\n{"path":"src/b.ts","summary":"Helpers."}\n```';
    expect(summaryFromLine(fenced, paths)?.path).toBe('src/b.ts');
    const chatty = 'Sure! {"path":"src/b.ts","summary":"Helpers."} hope that helps';
    expect(summaryFromLine(chatty, paths)?.path).toBe('src/b.ts');
  });

  it('is total on junk', () => {
    expect(summaryFromLine('', paths)).toBeNull();
    expect(summaryFromLine('not json', paths)).toBeNull();
    expect(summaryFromLine('{"broken":', paths)).toBeNull();
    expect(summaryFromLine('["an","array"]', paths)).toBeNull();
  });
});

describe('folderInstruction', () => {
  it('rides each file as one JSON line and ends with the contract', () => {
    const text = folderInstruction([
      { path: 'src/a.ts', content: 'import x from "./b";' },
      { path: 'src/b.ts', content: 'export const x = 1;' },
    ]);
    const lines = text.split('\n');
    expect(lines[0]).toBe('{"path":"src/a.ts","content":"import x from \\"./b\\";"}');
    expect(lines[1]).toBe('{"path":"src/b.ts","content":"export const x = 1;"}');
    expect(text).toContain('One reply line per input line');
    // Content with newlines stays inside its one line — a batch cannot
    // impersonate delimiters.
    const tricky = folderInstruction([{ path: 'a.ts', content: 'line1\nline2' }]);
    expect(tricky.split('\n')[0]).toBe('{"path":"a.ts","content":"line1\\nline2"}');
  });
});

describe('summaryMaxTokens', () => {
  it('scales with the batch and stays capped', () => {
    expect(summaryMaxTokens(1)).toBe(320);
    expect(summaryMaxTokens(20)).toBe(1650);
    expect(summaryMaxTokens(10_000)).toBe(4000);
  });
});
