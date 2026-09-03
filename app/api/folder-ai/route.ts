import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { guardManage } from '@/lib/access';
import { resolveConfig } from '@/lib/ai/config';
import {
  FOLDER_SYSTEM_PROMPT,
  folderInstruction,
  summaryFromLine,
  summaryMaxTokens,
} from '@/lib/ai/folder-prompt';
import { openaiStreamDeltas } from '@/lib/ai/openai';
import { causeChain } from '@/lib/ai/upstream';

export const runtime = 'nodejs';

/** The batch ceilings the client chunks by, enforced again here — the client
 *  is a courtesy, the route is the boundary (same doctrine as sync's 413). */
const MAX_BATCH_FILES = 32;
const MAX_BATCH_CHARS = 1_000_000;

/**
 * The folder import's AI pass (phase 2): a batch of file contents in, one
 * streamed summary line per file out — the ideas route's idiom, install-scoped
 * because no board exists yet. This is the egress moment's far side: the
 * consent screen in the modal is the promise ("these contents leave this
 * machine on your key"), and this route is where that happens, so it asks
 * nothing else and stores nothing — paths in, lines out, nothing persisted.
 *
 * Frames are SSE, one per accepted summary line:
 *   data: {"type":"summary","path":…,"summary":…}
 *   data: {"type":"done"}
 *   data: {"type":"error","reason":"…"}
 * Refusals answer plain JSON, distinguishable by content-type. There is no
 * privacy check to make: Privacy Mode is a property of a board and none
 * exists — the consent screen is the gate, which is why it shows real
 * numbers before this route is ever reached.
 */
export async function POST(req: Request) {
  const denied = guardManage(req);
  if (denied) return denied;

  const cfg = resolveConfig();
  if (!cfg) {
    // Bring-your-own-key: no configuration is a valid configuration. The
    // modal treats this answer as "links only", which is its other half.
    return NextResponse.json({ summaries: null, reason: 'no_api_key' });
  }

  let body: { files?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  if (!Array.isArray(body.files) || body.files.length === 0) {
    return NextResponse.json({ error: 'no files' }, { status: 400 });
  }
  if (body.files.length > MAX_BATCH_FILES) {
    return NextResponse.json({ error: 'too many files' }, { status: 413 });
  }

  const files: Array<{ path: string; content: string }> = [];
  let chars = 0;
  for (const entry of body.files) {
    if (typeof entry !== 'object' || entry === null) {
      return NextResponse.json({ error: 'invalid file' }, { status: 400 });
    }
    const { path, content } = entry as Record<string, unknown>;
    if (typeof path !== 'string' || !path.trim() || path.length > 512) {
      return NextResponse.json({ error: 'invalid file' }, { status: 400 });
    }
    if (typeof content !== 'string') {
      return NextResponse.json({ error: 'invalid file' }, { status: 400 });
    }
    chars += content.length;
    if (chars > MAX_BATCH_CHARS) {
      return NextResponse.json({ error: 'batch too large' }, { status: 413 });
    }
    files.push({ path, content });
  }

  const validPaths = new Set(files.map((f) => f.path));
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
       * The stream is text; the summaries are the lines inside it. A fence,
       * a preamble, a line about a file that was not sent — all dropped in
       * silence here, exactly like the ideas route, because none of it is
       * the person's problem. The first line for a path wins; a model that
       * answers a file twice does not get to revise itself.
       */
      let buffer = '';
      let sent = 0;
      const seen = new Set<string>();

      const consume = (line: string) => {
        const summary = summaryFromLine(line, validPaths);
        if (!summary || seen.has(summary.path)) return;
        seen.add(summary.path);
        sent += 1;
        send({ type: 'summary', path: summary.path, summary: summary.summary });
      };

      const feed = (delta: string) => {
        buffer += delta;
        for (;;) {
          const i = buffer.indexOf('\n');
          if (i === -1) break;
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          if (line.trim()) consume(line);
        }
      };

      /**
       * A batch that produced no line at all is a failure, not an empty list
       * — the client would mark files summarized that never were. Same
       * stop-reason handling as the ideas route.
       */
      const finish = (stopReason: string | null): Record<string, unknown> => {
        if (buffer.trim()) consume(buffer);
        buffer = '';
        if (sent > 0) return { type: 'done' };
        console.error('[folder-ai] no summaries from', cfg.model, '- stop_reason:', stopReason);
        return { type: 'error', reason: stopReason === 'max_tokens' ? 'truncated' : 'empty' };
      };

      try {
        const instruction = folderInstruction(files);
        const maxTokens = summaryMaxTokens(files.length);

        if (cfg.flavor === 'anthropic') {
          // The timer wraps the fetch up to response headers only — it bounds
          // how long a silent upstream can hold the pass open, and cannot cut
          // a stream that is already delivering lines.
          const client = new Anthropic({
            apiKey: cfg.apiKey!,
            baseURL: cfg.baseUrl || undefined,
            timeout: 60_000,
          });

          // (The MessageStream type isn't exported by the SDK root, so it's inferred.)
          type ModelStream = ReturnType<Anthropic['messages']['stream']>;

          // Same split as /suggest and /ideas: adaptive thinking, effort, and
          // prompt caching are Anthropic-the-company extras a compat endpoint
          // may reject. Caching matters more here than anywhere else in the
          // app — the system prompt is byte-identical across every batch of a
          // long pass, and each cache hit is file-content tokens not re-sent.
          const params: Anthropic.MessageStreamParams =
            cfg.provider === 'anthropic'
              ? {
                  model: cfg.model,
                  max_tokens: maxTokens,
                  thinking: { type: 'adaptive' },
                  output_config: {
                    // Someone is watching the staging list, same as the ideas
                    // panel — a fuller read beats a fast guess.
                    effort: 'medium',
                  },
                  system: [
                    {
                      type: 'text',
                      text: FOLDER_SYSTEM_PROMPT,
                      cache_control: { type: 'ephemeral' },
                    },
                  ],
                  messages: [{ role: 'user', content: instruction }],
                }
              : {
                  model: cfg.model,
                  max_tokens: maxTokens,
                  // Thinking off, explicitly: a compat endpoint that reasons
                  // by default spends the whole budget before the first line.
                  thinking: { type: 'disabled' },
                  system: FOLDER_SYSTEM_PROMPT,
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
            system: FOLDER_SYSTEM_PROMPT,
            user: instruction,
            maxTokens,
            signal: upstream.signal,
          })) {
            feed(delta);
          }
          send(finish(null));
        }
      } catch (err) {
        // An abort is the client leaving, not a failure — nobody to tell.
        if (!aborted) {
          console.error('[folder-ai] stream failed:', causeChain(err));
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
