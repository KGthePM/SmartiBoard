import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { guardBoard } from '@/lib/access';
import { resolveConfig } from '@/lib/ai/config';
import { IDEAS_MAX_TOKENS, IDEAS_SYSTEM_PROMPT, ideasInstruction } from '@/lib/ai/ideas-prompt';
import { IDEAS_MAX, ideaFromLine, ideaKey, splitLines } from '@/lib/ai/ideas';
import { openaiStreamDeltas } from '@/lib/ai/openai';
import { causeChain } from '@/lib/ai/upstream';
import { canGenerateIdeas } from '@/lib/ai/trigger';
import { loadBoard } from '@/lib/db';
import { parseBoard } from '@/lib/graph';

export const runtime = 'nodejs';

/**
 * The user-invoked behavior (v2.0), replacing /summarize. Where the ghost needs
 * one complete structured proposal before it can render, and the summary was
 * prose, this is a list — so it streams, and each idea is emitted the moment
 * its line is complete rather than at the end of the run. Frames are SSE:
 *   data: {"type":"idea","idea":{"text":…,"rationale":…,"anchors":[…]}}
 *   data: {"type":"done"}
 *   data: {"type":"error","reason":"…"}
 * Refusals — privacy, no provider, nothing to read — are plain JSON,
 * distinguishable by content-type. Both wire flavors emit the same frames;
 * only the upstream differs.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  // Above the privacy check on purpose: a caller with no right to this board
  // must not be able to tell "privacy is on" from "no such board".
  const denied = guardBoard(req, id);
  if (denied) return denied;

  // Privacy Mode, before a provider is even resolved. The stored board is the
  // authority precisely because the caller isn't: the client declining to ask
  // is a client being polite, and this is the promise. Same shape as the other
  // non-SSE answers below.
  if (loadBoard(id).privacy) {
    return NextResponse.json({ ideas: null, reason: 'privacy' });
  }

  const cfg = resolveConfig();
  if (!cfg) {
    // Bring-your-own-key: no configuration is a valid configuration, not an
    // error. Same contract as /suggest.
    return NextResponse.json({ ideas: null, reason: 'no_api_key' });
  }

  let body: { board?: unknown; seedId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const board = parseBoard(id, body.board);
  // The other half of the privacy check: autosave lags the toggle, so for that
  // window the stored row says false while the board in the browser — the one
  // about to be sent — says true. Either flag is enough to refuse.
  if (board.privacy) {
    return NextResponse.json({ ideas: null, reason: 'privacy' });
  }

  // The floor. The panel gates on the same predicate, so reaching this is a
  // stale tab or something that is not our canvas; either way, spending a
  // request on a board with nothing in it and no objective helps no one.
  if (!canGenerateIdeas(board)) {
    return NextResponse.json({ ideas: null, reason: 'too_thin' });
  }

  const seedId =
    typeof body.seedId === 'string' && board.nodes.some((n) => n.id === body.seedId)
      ? body.seedId
      : null;

  const instruction = ideasInstruction(board, seedId);
  const validIds = board.nodes.map((n) => n.id);
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
       * The stream is text; the ideas are the lines inside it. Everything the
       * model says that isn't a well-formed line — a fence, a preamble, a
       * trailing apology — is dropped silently here rather than becoming an
       * error, because none of it is the person's problem.
       */
      let buffer = '';
      let sent = 0;
      const seen = new Set<string>();

      const consume = (line: string) => {
        if (sent >= IDEAS_MAX) return;
        const idea = ideaFromLine(line, validIds);
        if (!idea) return;
        const key = ideaKey(idea.text);
        // Models asked for several ideas at once repeat themselves; the panel
        // should not show the same card twice.
        if (seen.has(key)) return;
        seen.add(key);
        sent += 1;
        send({ type: 'idea', idea });
      };

      const feed = (delta: string) => {
        buffer += delta;
        const { lines, rest } = splitLines(buffer);
        buffer = rest;
        for (const line of lines) consume(line);
      };

      /**
       * A run that produced no idea at all is a failure, not an empty list — a
       * done frame there leaves the panel silently blank. The usual cause is a
       * reasoning model whose thinking ate max_tokens before the first line, so
       * the stop reason is worth both the frame and the log line.
       */
      const finish = (stopReason: string | null): Record<string, unknown> => {
        // The last line may have arrived without a trailing newline.
        if (buffer.trim()) consume(buffer);
        buffer = '';
        if (sent > 0) return { type: 'done' };
        console.error('[ideas] no ideas from', cfg.model, '- stop_reason:', stopReason);
        return { type: 'error', reason: stopReason === 'max_tokens' ? 'truncated' : 'empty' };
      };

      try {
        if (cfg.flavor === 'anthropic') {
          // The timer wraps the fetch up to response headers only, so this
          // bounds how long a silent upstream can hold the panel open — it
          // cannot cut a stream that is already delivering ideas.
          const client = new Anthropic({
            apiKey: cfg.apiKey!,
            baseURL: cfg.baseUrl || undefined,
            timeout: 60_000,
          });

          // (The MessageStream type isn't exported by the SDK root, so it's inferred.)
          type ModelStream = ReturnType<Anthropic['messages']['stream']>;

          // Same split as /suggest: adaptive thinking, effort tuning, and prompt
          // caching are Anthropic-the-company extras a compat endpoint (z.ai's
          // Coding Plan) may reject — third parties get plain streaming. Note
          // that neither branch asks for structured output: the JSONL contract
          // lives in the message, because a schema would make us wait for one
          // complete object and that is exactly what the panel is not doing.
          const params: Anthropic.MessageStreamParams =
            cfg.provider === 'anthropic'
              ? {
                  model: cfg.model,
                  max_tokens: IDEAS_MAX_TOKENS,
                  thinking: { type: 'adaptive' },
                  output_config: {
                    // The ghost runs at 'low' because nobody is waiting on it.
                    // Here someone asked and is watching the panel, so a fuller
                    // read is worth the extra latency. Tunable.
                    effort: 'medium',
                  },
                  // Stable prefix cached, volatile board after it.
                  system: [
                    { type: 'text', text: IDEAS_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
                  ],
                  messages: [{ role: 'user', content: instruction }],
                }
              : {
                  model: cfg.model,
                  max_tokens: IDEAS_MAX_TOKENS,
                  // Thinking off, explicitly. A compat endpoint that reasons by
                  // default (GLM on z.ai's Coding Plan does, always) spends the
                  // whole budget on a thinking block and stops at max_tokens
                  // before a single line — a panel that never fills.
                  thinking: { type: 'disabled' },
                  system: IDEAS_SYSTEM_PROMPT,
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
              feed(event.delta.text);
            } else if (event.type === 'message_delta' && event.delta.stop_reason) {
              stopReason = event.delta.stop_reason;
            }
          }
          if (stopReason === 'refusal') send({ type: 'error', reason: 'refusal' });
          else send(finish(stopReason));
        } else {
          for await (const delta of openaiStreamDeltas(cfg, {
            system: IDEAS_SYSTEM_PROMPT,
            user: instruction,
            maxTokens: IDEAS_MAX_TOKENS,
            signal: upstream.signal,
          })) {
            feed(delta);
          }
          send(finish(null));
        }
      } catch (err) {
        // An abort is the client leaving, not a failure — nobody to tell.
        if (!aborted) {
          console.error('[ideas] stream failed:', causeChain(err));
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
