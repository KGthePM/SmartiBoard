import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { resolveConfig } from '@/lib/ai/config';
import { openaiStreamDeltas } from '@/lib/ai/openai';
import { SUMMARY_MAX_TOKENS, SUMMARY_SYSTEM_PROMPT, summaryInstruction } from '@/lib/ai/summary-prompt';
import { causeChain } from '@/lib/ai/upstream';
import { loadBoard } from '@/lib/db';
import { parseBoard } from '@/lib/graph';

export const runtime = 'nodejs';

/**
 * The user-invoked counterpart to /suggest. Where the ghost needs one complete
 * structured proposal before it can render (so it doesn't stream), a summary is
 * prose a person is actively waiting to read — so it streams. Frames are SSE:
 *   data: {"type":"delta","text":"…"}   per text delta
 *   data: {"type":"done"}
 *   data: {"type":"error","reason":"…"} refusal/upstream failure
 * The no-configuration case is a plain JSON response, distinguishable by
 * content-type. Both wire flavors emit the same frames; only the upstream
 * differs.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  // Privacy Mode refuses here too, and this is the half that makes the promise
  // whole: a summary is user-invoked, but it still ships the entire board
  // upstream. Silencing the ghost while ⌘. stayed open would be a privacy
  // toggle that isn't one. Plain JSON, same non-SSE shape as no_api_key below.
  if (loadBoard(id).privacy) {
    return NextResponse.json({ summary: null, reason: 'privacy' });
  }

  const cfg = resolveConfig();
  if (!cfg) {
    // No provider configured: valid, not an error — same contract as /suggest.
    return NextResponse.json({ summary: null, reason: 'no_api_key' });
  }

  let body: { board?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const board = parseBoard(id, body.board);
  // Covers the autosave window, same as /suggest.
  if (board.privacy) {
    return NextResponse.json({ summary: null, reason: 'privacy' });
  }

  const instruction = summaryInstruction(board);
  const encoder = new TextEncoder();

  // Aborted on client disconnect from either path: req.signal, or the
  // ReadableStream's cancel() — whichever fires first. Covers the SDK stream
  // and the fetch-based one alike.
  const upstream = new AbortController();
  let aborted = false;
  const abortUpstream = () => {
    aborted = true;
    upstream.abort();
  };
  req.signal.addEventListener('abort', abortUpstream);

  const source = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (frame: Record<string, unknown>) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        } catch {
          open = false;
        }
      };

      /**
       * A stream that ends without a single text token is a failure, not an
       * empty summary — a done frame there leaves the panel silently blank.
       * The usual cause is a reasoning model whose thinking ate max_tokens
       * (its deltas are dropped: the summary is prose, not a monologue), so
       * the stop reason is worth both the frame and the log line.
       */
      let sawText = false;
      const finish = (stopReason: string | null): Record<string, unknown> => {
        if (sawText) return { type: 'done' };
        console.error('[summarize] no text from', cfg.model, '- stop_reason:', stopReason);
        return { type: 'error', reason: stopReason === 'max_tokens' ? 'truncated' : 'empty' };
      };

      try {
        if (cfg.flavor === 'anthropic') {
          // The timer wraps the fetch up to response headers only, so this
          // bounds how long a silent upstream can hold the panel open — it
          // cannot cut a stream that is already delivering prose.
          const client = new Anthropic({
            apiKey: cfg.apiKey!,
            baseURL: cfg.baseUrl || undefined,
            timeout: 60_000,
          });

          // (The MessageStream type isn't exported by the SDK root, so it's inferred.)
          type ModelStream = ReturnType<Anthropic['messages']['stream']>;

          // Same split as /suggest: adaptive thinking, effort tuning, and
          // prompt caching are Anthropic-the-company extras a compat endpoint
          // (z.ai's Coding Plan) may reject — third parties get plain streaming.
          const params: Anthropic.MessageStreamParams =
            cfg.provider === 'anthropic'
              ? {
                  model: cfg.model,
                  max_tokens: SUMMARY_MAX_TOKENS,
                  thinking: { type: 'adaptive' },
                  output_config: {
                    // The ghost runs at 'low' because nobody is waiting on it. Here
                    // someone asked and is watching, so a fuller read is worth the
                    // extra latency. Tunable.
                    effort: 'medium',
                  },
                  // Same cache shape as /suggest: stable prefix cached, board after it.
                  system: [
                    { type: 'text', text: SUMMARY_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
                  ],
                  messages: [{ role: 'user', content: instruction }],
                }
              : {
                  model: cfg.model,
                  max_tokens: SUMMARY_MAX_TOKENS,
                  // Thinking off, explicitly. A compat endpoint that reasons by
                  // default (GLM on z.ai's Coding Plan does, always) spends the
                  // whole budget on a thinking block and stops at max_tokens
                  // before a single text token — a summary that never arrives.
                  thinking: { type: 'disabled' },
                  system: SUMMARY_SYSTEM_PROMPT,
                  messages: [{ role: 'user', content: instruction }],
                };

          const model: ModelStream = client.messages.stream(
            params,
            // One abort path for both flavors: req.signal or stream cancel().
            { signal: upstream.signal },
          );

          // A refusal never streams text; the stop reason is the only tell.
          let stopReason: string | null = null;

          for await (const event of model) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              sawText = true;
              send({ type: 'delta', text: event.delta.text });
            } else if (event.type === 'message_delta' && event.delta.stop_reason) {
              stopReason = event.delta.stop_reason;
            }
          }
          if (stopReason === 'refusal') send({ type: 'error', reason: 'refusal' });
          else send(finish(stopReason));
        } else {
          for await (const delta of openaiStreamDeltas(cfg, {
            system: SUMMARY_SYSTEM_PROMPT,
            user: instruction,
            maxTokens: SUMMARY_MAX_TOKENS,
            signal: upstream.signal,
          })) {
            sawText = true;
            send({ type: 'delta', text: delta });
          }
          send(finish(null));
        }
      } catch (err) {
        // An abort is the client leaving, not a failure — nobody to tell.
        if (!aborted) {
          console.error('[summarize] stream failed:', causeChain(err));
          send({ type: 'error', reason: 'upstream_error' });
        }
      } finally {
        req.signal.removeEventListener('abort', abortUpstream);
        try {
          controller.close();
        } catch {
          // Already cancelled by the disconnect that caused the abort.
        }
      }
    },
    cancel() {
      abortUpstream();
    },
  });

  return new Response(source, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
    },
  });
}
