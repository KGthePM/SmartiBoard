import { describe, expect, it } from 'vitest';
import {
  CARD_BODY_MAX,
  CARD_TITLE_MAX,
  cardFromLine,
  HOW_CARDS_MAX,
  HOW_CARDS_MIN,
  howInstruction,
  howMaxTokens,
} from './how-prompt';

describe('cardFromLine', () => {
  const paths = new Set(['lib/sync.ts', 'lib/store.ts']);

  it('accepts a well-formed line', () => {
    expect(
      cardFromLine(
        '{"title":"Autosave loop","body":"Diffs against the acked board and POSTs ops.","files":["lib/sync.ts"]}',
        paths,
      ),
    ).toEqual({
      title: 'Autosave loop',
      body: 'Diffs against the acked board and POSTs ops.',
      files: ['lib/sync.ts'],
    });
  });

  it('drops unknown files from the files list, keeps the card', () => {
    const card = cardFromLine(
      '{"title":"Autosave loop","body":"Diffs against the acked board and POSTs ops.","files":["lib/sync.ts","not/sent.ts"]}',
      new Set(['lib/sync.ts']),
    );
    expect(card).not.toBeNull();
    expect(card!.files).toEqual(['lib/sync.ts']);
  });

  it('keeps the card when every file is unknown — files is just empty', () => {
    const card = cardFromLine(
      '{"title":"Autosave loop","body":"Diffs against the acked board.","files":["nope.ts"]}',
      paths,
    );
    expect(card).toEqual({ title: 'Autosave loop', body: 'Diffs against the acked board.', files: [] });
  });

  it('treats a non-array files field as no files', () => {
    const card = cardFromLine(
      '{"title":"Autosave loop","body":"Diffs against the board.","files":"lib/sync.ts"}',
      paths,
    );
    expect(card).toEqual({ title: 'Autosave loop', body: 'Diffs against the board.', files: [] });
  });

  it('drops a line with an empty title or body — a card needs both halves', () => {
    expect(cardFromLine('{"title":"","body":"Something.","files":[]}', paths)).toBeNull();
    expect(cardFromLine('{"title":"A title","body":"  ","files":[]}', paths)).toBeNull();
    expect(cardFromLine('{"title":"A title","files":[]}', paths)).toBeNull();
    expect(cardFromLine('{"body":"Something.","files":[]}', paths)).toBeNull();
  });

  it('slices over-cap title and body instead of dropping the card', () => {
    const longTitle = 't'.repeat(CARD_TITLE_MAX + 50);
    const longBody = 'b'.repeat(CARD_BODY_MAX + 500);
    const card = cardFromLine(
      `{"title":"${longTitle}","body":"${longBody}","files":["lib/sync.ts"]}`,
      paths,
    );
    expect(card).not.toBeNull();
    expect(card!.title).toHaveLength(CARD_TITLE_MAX);
    expect(card!.body).toHaveLength(CARD_BODY_MAX);
  });

  it('collapses whitespace in title and body into one line', () => {
    const card = cardFromLine(
      '{"title":"Autosave\\n  loop","body":"Diffs\\tagainst\\nthe board."}',
      paths,
    );
    expect(card?.title).toBe('Autosave loop');
    expect(card?.body).toBe('Diffs against the board.');
  });

  it('recovers JSON from a fence or stray prose, like every JSONL contract here', () => {
    const fenced = '```json\n{"title":"Store","body":"Holds the board.","files":["lib/store.ts"]}\n```';
    expect(cardFromLine(fenced, paths)?.title).toBe('Store');
    const chatty = 'Sure! {"title":"Store","body":"Holds the board.","files":["lib/store.ts"]} hope that helps';
    expect(cardFromLine(chatty, paths)?.title).toBe('Store');
  });

  it('drops fence-only and preamble-only lines in silence', () => {
    expect(cardFromLine('```', paths)).toBeNull();
    expect(cardFromLine('Here are the cards you asked for:', paths)).toBeNull();
  });

  it('is total on junk', () => {
    expect(cardFromLine('', paths)).toBeNull();
    expect(cardFromLine('not json', paths)).toBeNull();
    expect(cardFromLine('{"broken":', paths)).toBeNull();
    expect(cardFromLine('["an","array"]', paths)).toBeNull();
  });
});

describe('howInstruction', () => {
  it('rides each file as one JSON line, doc files first with the note field', () => {
    const text = howInstruction(
      [
        { path: 'lib/sync.ts', content: 'export const sync = 1;' },
        { path: 'AGENTS.md', content: '# Guide' },
      ],
      { docPaths: new Set(['AGENTS.md']) },
    );
    const lines = text.split('\n').filter((l) => l.startsWith('{"path"'));
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first.path).toBe('AGENTS.md');
    expect(first.note).toBe("the author's own guide to this project");
    expect(second.path).toBe('lib/sync.ts');
    expect(second.note).toBeUndefined();
    expect(second.content).toBe('export const sync = 1;');
  });

  it('renders tree and imports sections when provided, before the file lines', () => {
    const text = howInstruction([{ path: 'a.ts', content: 'x' }], {
      tree: ['a.ts', 'lib/b.ts'],
      imports: [['a.ts', 'lib/b.ts']] as Array<[string, string]>,
    });
    const lines = text.split('\n');
    const treeIdx = lines.indexOf('tree: a.ts');
    const importIdx = lines.indexOf('imports: a.ts -> lib/b.ts');
    const fileIdx = lines.findIndex((l) => l.startsWith('{"path"'));
    expect(treeIdx).toBeGreaterThanOrEqual(0);
    expect(importIdx).toBeGreaterThan(treeIdx);
    expect(fileIdx).toBeGreaterThan(importIdx);
  });

  it('omits the tree and imports sections when not provided', () => {
    const text = howInstruction([{ path: 'a.ts', content: 'x' }]);
    expect(text).not.toContain('tree:');
    expect(text).not.toContain('imports:');
  });

  it('ends with the per-turn contract', () => {
    const text = howInstruction([{ path: 'a.ts', content: 'x' }]);
    expect(text.trimEnd().split('\n').pop()).toMatch(/^\{"title"/);
  });

  it('slices a giant file content to 20,000 chars so one doc cannot blow the instruction', () => {
    const huge = 'y'.repeat(25_000);
    const text = howInstruction([{ path: 'AGENTS.md', content: huge }]);
    const fileLine = text.split('\n').find((l) => l.startsWith('{"path"'))!;
    const parsed = JSON.parse(fileLine) as { content: string };
    expect(parsed.content).toHaveLength(20_000);
    expect(parsed.content).toBe(huge.slice(0, 20_000));
  });
});

describe('howMaxTokens', () => {
  it('scales with the card target and stays capped', () => {
    expect(howMaxTokens(1)).toBe(500);
    expect(howMaxTokens(12)).toBe(3250);
    expect(howMaxTokens(12)).toBeGreaterThan(3000);
    expect(howMaxTokens(12)).toBeLessThan(4000);
    expect(howMaxTokens(10_000)).toBe(4000);
  });
});

describe('card budget constants', () => {
  it('exports the agreed card shape limits', () => {
    expect(CARD_TITLE_MAX).toBe(80);
    expect(CARD_BODY_MAX).toBe(600);
    expect(HOW_CARDS_MIN).toBe(3);
    expect(HOW_CARDS_MAX).toBe(16);
  });
});
