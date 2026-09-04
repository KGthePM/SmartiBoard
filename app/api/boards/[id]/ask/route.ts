import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { guardBoard } from '@/lib/access';
import { resolveConfig } from '@/lib/ai/config';
import { ASK_MAX_TOKENS, ASK_SYSTEM_PROMPT, askInstruction, fitHistory } from '@/lib/ai/ask-prompt';
import { clampQuestion, QUESTION_MAX, scopeBoard, splitAnswer } from '@/lib/ai/ask';
import { openaiStreamDeltas, type ChatMessage } from '@/lib/ai/openai';
import { causeChain } from '@/lib/ai/upstream';
import { canAsk } from '@/lib/ai/trigger';
import { loadBoard } from '@/lib/db';
import { parseBoard, type NodeId } from '@/lib/graph';

export const runtime = 'nodejs';

/**
 * Ask (v5.4): questions about a board, answered read-only. Structurally the
 * ideas route — the same refusal ladder in the same order (the ordering IS
 * the security property), the same dual abort wiring, the same
 * provider-vs-flavor split — with a simpler frame contract, because the
 * answer is prose rather than a list of parseable lines:
 *   data: {"type":"delta","text":"…"}
 *   data: {"type":"done","kept":N,"total":M}
 *   data: {"type":"error","reason":"…"}
 *
 * `splitAnswer` holds back a trailing partial `[[nodeId]]` citation marker so
 * the panel never renders half of one that is still arriving; `done` carries
 * the card counts so the panel can say "answered from N of M cards" without
 * re-deriving a budget it was never the authority on.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  // Above the privacy check on purpose: a caller with no right to this board
  // must not be able to tell "privacy is on" from "no such board."
  const denied = guardBoard(req, id);
  if (denied) return denied;

  // Privacy Mode, before a provider is even resolved. The stored board is the
  // authority; the client declining to ask is a client being polite.
  if (loadBoard(id).privacy) {
    return NextResponse.json({ answer: null, reason: 'privacy' });
  }

  const cfg = resolveConfig();
  if (!cfg) {
    // Bring-your-own-key: no configuration is a valid configuration.
    return NextResponse.json({ answer: null, reason: 'no_api_key' });
  }

  let body: {
    board?: unknown;
    question?: unknown;
    history?: unknown;
    scope?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const board = parseBoard(id, body.board);
  // The other half of the privacy check: autosave lags the toggle, and that
  // window must not leak. Either flag is enough to refuse.
  if (board.privacy) {
    return NextResponse.json({ answer: null, reason: 'privacy' });
  }

  // The floor. The panel gates on the same predicate; a board with nothing to
  // read has no answer, objective included.
  if (!canAsk(board)) {
    return NextResponse.json({ answer: null, reason: 'too_thin' });
  }

  // The question is the first untrusted free-text string in the app that
  // reaches a model turn, so the cap is enforced here, not only in the
  // textarea's maxLength. Clamped, not rejected — but an empty one has no
  // answer to give.
  const question = clampQuestion(typeof body.question === 'string' ? body.question : '');
  if (!question) {
    return NextResponse.json({ answer: null, reason: 'empty_question' });
  }

  // History and scope arrive from the client, so both are fitted here too:
  // turns capped and halves trimmed (fitHistory), ids filtered to cards that
  // exist. An empty scope is the whole board — the common case.
  const history = fitHistory(parseHistory(body.history));
  const scope = parseScope(body.scope, board.nodes.map((n) => n.id));
  const scoped = scopeBoard(board, scope);
  const { instruction, kept, total } = askInstruction(scoped, question);
  const encoder = new TextEncoder();

  // Aborted on client disconnect from either path: req.signal, or the
  // ReadableStream's cancel() — whichever fires first.
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
       * Prose, streamed as prose — with one holdback: a trailing partial
       * `[[…` citation marker is kept until it closes or the run ends, the
       * ideas route's doctrine for half a JSON line. The panel re-parses the
       * accumulated text itself (`parseAnswer`), so what it receives is always
       * marker-complete.
       */
      let buffer = '';
      let sent = 0;

      const feed = (delta: string) => {
        buffer += delta;
        const { safe, rest } = splitAnswer(buffer);
        buffer = rest;
        if (!safe) return;
        sent += safe.length;
        send({ type: 'delta', text: safe });
      };

      /**
       * The same rule the ideas route learned the hard way: a run that
       * produced nothing is a failure, not an answer — a `done` frame with no
       * text leaves the panel silently blank. The usual cause is a reasoning
       * model whose thinking ate max_tokens before the first character.
       */
      const finish = (stopReason: string | null): Record<string, unknown> => {
        // The tail can no longer become a citation; it is prose, send it.
        if (buffer) {
          sent += buffer.length;
          send({ type: 'delta', text: buffer });
          buffer = '';
        }
        if (sent > 0) return { type: 'done', kept, total };
        console.error('[ask] no answer from', cfg.model, '- stop_reason:', stopReason);
        return { type: 'error', reason: stopReason === 'max_tokens' ? 'truncated' : 'empty' };
      };

      try {
        // Multi-turn: the prior exchange rides as real turns, so the board is
        // serialized once per request and only Q/A text accumulates.
        const turns: ChatMessage[] = [
          ...history.flatMap((t) => [
            { role: 'user' as const, content: t.question },
            { role: 'assistant' as const, content: t.answer },
          ]),
          { role: 'user' as const, content: instruction },
        ];

        if (cfg.flavor === 'anthropic') {
          const client = new Anthropic({
            apiKey: cfg.apiKey!,
            baseURL: cfg.baseUrl || undefined,
            timeout: 60_000,
          });

          type ModelStream = ReturnType<Anthropic['messages']['stream']>;

          // Same split as /suggest and /ideas: adaptive thinking, effort
          // tuning, and prompt caching are Anthropic-the-company extras a
          // compat endpoint may reject — third parties get plain streaming.
          const params: Anthropic.MessageStreamParams =
            cfg.provider === 'anthropic'
              ? {
                  model: cfg.model,
                  max_tokens: ASK_MAX_TOKENS,
                  thinking: { type: 'adaptive' },
                  output_config: {
                    // Someone asked and is watching, so a fuller read is worth
                    // the extra latency. Same rung as the ideas route.
                    effort: 'medium',
                  },
                  system: [
                    { type: 'text', text: ASK_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
                  ],
                  messages: turns,
                }
              : {
                  model: cfg.model,
                  max_tokens: ASK_MAX_TOKENS,
                  // Thinking off, explicitly. A compat endpoint that reasons
                  // by default (GLM on z.ai's Coding Plan does, always) burns
                  // the whole budget on a thinking block before the first
                  // character — a panel that never fills.
                  thinking: { type: 'disabled' },
                  system: ASK_SYSTEM_PROMPT,
                  messages: turns,
                };

          const model: ModelStream = client.messages.stream(
            params,
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
            system: ASK_SYSTEM_PROMPT,
            messages: turns,
            maxTokens: ASK_MAX_TOKENS,
            signal: upstream.signal,
          })) {
            feed(delta);
          }
          send(finish(null));
        }
      } catch (err) {
        // An abort is the client leaving, not a failure — nobody to tell.
        if (!aborted) {
          console.error('[ask] stream failed:', causeChain(err));
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

/** Untrusted history → {question, answer} pairs. Junk is dropped in silence. */
function parseHistory(v: unknown): { question: string; answer: string }[] {
  if (!Array.isArray(v)) return [];
  const turns: { question: string; answer: string }[] = [];
  for (const t of v) {
    if (typeof t !== 'object' || t === null) continue;
    const q = (t as { question?: unknown }).question;
    const a = (t as { answer?: unknown }).answer;
    if (typeof q !== 'string' || typeof a !== 'string') continue;
    turns.push({ question: q.slice(0, QUESTION_MAX), answer: a });
  }
  return turns;
}

/** Untrusted scope → ids that exist on this board. Unknown ids drop. */
function parseScope(v: unknown, validIds: NodeId[]): NodeId[] {
  if (!Array.isArray(v)) return [];
  const valid = new Set(validIds);
  return v.filter((s): s is NodeId => typeof s === 'string' && valid.has(s));
}
