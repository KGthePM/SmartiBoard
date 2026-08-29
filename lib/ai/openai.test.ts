import { describe, expect, it } from 'vitest';
import { parseModelList, sseDataLines } from './openai';

/** A byte stream that hands out exactly the chunk boundaries the test wants. */
function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect(s: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of sseDataLines(s)) out.push(line);
  return out;
}

describe('sseDataLines', () => {
  it('reassembles a line split across chunk boundaries', async () => {
    // The whole reason this function is separate from the parser above it:
    // real providers split JSON payloads mid-token, and a naive per-chunk
    // split turns one delta into two unparseable halves.
    expect(await collect(stream('data: {"a"', ':1}\n'))).toEqual(['{"a":1}']);
  });

  it('reads several lines out of one chunk', async () => {
    expect(await collect(stream('data: one\ndata: two\ndata: three\n'))).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  it('tolerates CRLF endings', async () => {
    expect(await collect(stream('data: one\r\ndata: two\r\n'))).toEqual(['one', 'two']);
  });

  it('ignores everything that is not a data line', async () => {
    // Comment keepalives (': ping') and event/id fields are protocol noise.
    expect(await collect(stream(': ping\n\nevent: message\ndata: real\n\n'))).toEqual(['real']);
  });

  it('yields a final line that arrived without a trailing newline', async () => {
    // Some servers close the connection right after the last payload.
    expect(await collect(stream('data: first\ndata: last'))).toEqual(['first', 'last']);
  });

  it('yields the [DONE] sentinel like any other line', async () => {
    // Interpreting it is the caller's job, not the splitter's.
    expect(await collect(stream('data: x\ndata: [DONE]\n'))).toEqual(['x', '[DONE]']);
  });

  it('has nothing to yield for an empty stream', async () => {
    expect(await collect(stream())).toEqual([]);
  });
});

describe('parseModelList', () => {
  it('reads the OpenAI-shaped envelope that z.ai and Ollama both return', () => {
    const models = parseModelList({
      object: 'list',
      data: [
        { id: 'glm-4.6', object: 'model' },
        { id: 'glm-4.5-air', object: 'model' },
      ],
    });
    expect(models).toEqual([{ id: 'glm-4.5-air' }, { id: 'glm-4.6' }]);
  });

  // Servers list models in whatever order they please; a picker needs one that
  // does not reshuffle between loads.
  it('sorts by id and drops duplicates', () => {
    const models = parseModelList({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] });
    expect(models.map((m) => m.id)).toEqual(['a', 'b']);
  });

  // A blank row in the dropdown is worse than a short list.
  it('drops entries with no usable id', () => {
    const models = parseModelList({ data: [{ id: 'ok' }, { id: 42 }, { id: '  ' }, null, 'nope'] });
    expect(models).toEqual([{ id: 'ok' }]);
  });

  it('returns nothing rather than throwing on a body it does not recognize', () => {
    expect(parseModelList({})).toEqual([]);
    expect(parseModelList({ data: null })).toEqual([]);
    expect(parseModelList(null)).toEqual([]);
    expect(parseModelList('models')).toEqual([]);
  });
});
