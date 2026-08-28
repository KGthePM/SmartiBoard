import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { resolveConfig } from '@/lib/ai/config';
import { openaiStreamDeltas } from '@/lib/ai/openai';
import { SUMMARY_MAX_TOKENS, SUMMARY_SYSTEM_PROMPT, summaryInstruction } from '@/lib/ai/summary-prompt';
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

      try {
        if (cfg.flavor === 'anthropic') {
          const client = new Anthropic({
            apiKey: cfg.apiKey!,
            baseURL: cfg.baseUrl || undefined,
          });

          // (The MessageStream type isn't exported by the SDK root, so it's inferred.)
          type ModelStream = ReturnType<Anthropic['messages']['stream']>;
          const model: ModelStream = client.messages.stream(
            {
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
            },
            // One abort path for both flavors: req.signal or stream cancel().
            { signal: upstream.signal },
          );

          // A refusal never streams text; the stop reason is the only tell.
          let stopReason: string | null = null;

          for await (const event of model) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              send({ type: 'delta', text: event.delta.text });
            } else if (event.type === 'message_delta' && event.delta.stop_reason) {
              stopReason = event.delta.stop_reason;
            }
          }
          send(stopReason === 'refusal' ? { type: 'error', reason: 'refusal' } : { type: 'done' });
        } else {
          for await (const delta of openaiStreamDeltas(cfg, {
            system: SUMMARY_SYSTEM_PROMPT,
            user: instruction,
            maxTokens: SUMMARY_MAX_TOKENS,
            signal: upstream.signal,
          })) {
            send({ type: 'delta', text: delta });
          }
          send({ type: 'done' });
        }
      } catch (err) {
        // An abort is the client leaving, not a failure — nobody to tell.
        if (!aborted) {
          console.error('[summarize] stream failed', err);
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
