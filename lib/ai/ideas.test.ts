import { describe, expect, it } from 'vitest';
import { ideaFromLine, ideaKey, splitLines } from './ideas';

const IDS = ['n0', 'n1'];

describe('ideaFromLine', () => {
  it('reads a well-formed line', () => {
    const line = '{"text":"No owner for the migration","rationale":"Two cards depend on it.","anchors":["n1"]}';
    expect(ideaFromLine(line, IDS)).toEqual({
      text: 'No owner for the migration',
      rationale: 'Two cards depend on it.',
      anchors: ['n1'],
    });
  });

  it('drops an idea with no rationale', () => {
    // The rationale is the only thing the person sees when deciding whether to
    // trust the idea, so one without it is unusable, not merely cheaper.
    const line = '{"text":"No owner for the migration","rationale":"  ","anchors":[]}';
    expect(ideaFromLine(line, IDS)).toBeNull();
  });

  it('drops an idea with no text', () => {
    expect(ideaFromLine('{"text":"","rationale":"because"}', IDS)).toBeNull();
  });

  it('drops anchors the board does not have', () => {
    // Ids the model invented, or ones the user deleted while it was thinking.
    const line = '{"text":"a","rationale":"b","anchors":["n1","ghost","n0"]}';
    expect(ideaFromLine(line, IDS)!.anchors).toEqual(['n1', 'n0']);
  });

  it('survives an idea with no anchors at all', () => {
    // Legitimate on an empty board: it places from the centroid and lands
    // unconnected, which is what an unanchored idea is.
    expect(ideaFromLine('{"text":"a","rationale":"b"}', IDS)!.anchors).toEqual([]);
  });

  it('tolerates a fence or stray prose around the object', () => {
    expect(ideaFromLine('```json {"text":"a","rationale":"b"} ```', IDS)).not.toBeNull();
    expect(ideaFromLine('1. {"text":"a","rationale":"b"}', IDS)).not.toBeNull();
  });

  it('says nothing about lines that are not ideas', () => {
    // A preamble, a bare fence, a blank line: dropped in silence, never an error.
    for (const line of ['', '```', 'Here are some ideas:', '[', '{"kind":"none"}']) {
      expect(ideaFromLine(line, IDS)).toBeNull();
    }
  });
});

describe('splitLines', () => {
  it('hands back the unfinished tail instead of parsing it', () => {
    // Half a JSON object is not a rejected idea, it is one still arriving.
    expect(splitLines('{"a":1}\n{"b":')).toEqual({ lines: ['{"a":1}'], rest: '{"b":' });
  });

  it('leaves an empty tail when the buffer ends on a newline', () => {
    expect(splitLines('one\ntwo\n')).toEqual({ lines: ['one', 'two'], rest: '' });
  });

  it('holds everything back until the first newline', () => {
    expect(splitLines('partial')).toEqual({ lines: [], rest: 'partial' });
  });
});

describe('ideaKey', () => {
  it('collapses the repeats a model produces when asked for several at once', () => {
    expect(ideaKey('  No Owner   for the migration ')).toBe(ideaKey('no owner for the migration'));
  });

  it('keeps genuinely different ideas apart', () => {
    expect(ideaKey('no owner')).not.toBe(ideaKey('no budget'));
  });
});
