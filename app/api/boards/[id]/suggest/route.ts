import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { resolveConfig } from '@/lib/ai/config';
import { openaiComplete } from '@/lib/ai/openai';
import { proposalFromText } from '@/lib/ai/parse';
import { JSON_CONTRACT, PROPOSAL_SCHEMA, SYSTEM_PROMPT, serializeBoard } from '@/lib/ai/prompt';
import { parseBoard } from '@/lib/graph';

export const runtime = 'nodejs';

/**
 * One non-blocking request per proposal. Not streamed: a ghost node needs the
 * complete structured proposal before it can render, so streaming tokens buys
 * nothing here. The requirement from the brief is that local interaction never
 * *blocks* on inference, which this satisfies — the client fires and forgets.
 *
 * The provider is whatever the user configured in Settings (with the env var
 * as the headless fallback); the two wire flavors differ only in how the
 * reply text is obtained. Parsing and validation are shared.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const cfg = resolveConfig();
  if (!cfg) {
    // Bring-your-own-key: no configuration is a valid configuration, not an
    // error. The board stays fully usable; it just doesn't co-author.
    return NextResponse.json({ proposal: null, reason: 'no_api_key' });
  }

  let body: { board?: unknown; rejected?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const board = parseBoard(id, body.board);
  const rejected = Array.isArray(body.rejected)
    ? body.rejected.filter((r): r is string => typeof r === 'string').slice(-12)
    : [];

  const user = serializeBoard(board, rejected);
  let text: string | null;

  if (cfg.flavor === 'anthropic') {
    const client = new Anthropic({ apiKey: cfg.apiKey!, baseURL: cfg.baseUrl || undefined });

    let response;
    try {
      response = await client.messages.create({
        model: cfg.model,
        max_tokens: 2000,
        thinking: { type: 'adaptive' },
        output_config: {
          // Latency matters more than depth for a single suggestion. Effort is
          // the cost lever here — not disabling thinking, which has its own
          // failure modes on this model.
          effort: 'low',
          format: { type: 'json_schema', schema: PROPOSAL_SCHEMA },
        },
        // Stable prefix gets the cache breakpoint; the volatile board goes after it.
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
      });
    } catch (err) {
      console.error('[suggest] request failed', err);
      return NextResponse.json({ proposal: null, reason: 'upstream_error' });
    }

    // Check the stop reason before reading content — a refusal has no usable body.
    if (response.stop_reason === 'refusal') {
      return NextResponse.json({ proposal: null, reason: 'refusal' });
    }
    const block = response.content.find((b) => b.type === 'text');
    text = block && block.type === 'text' ? block.text : null;
  } else {
    try {
      text = await openaiComplete(cfg, {
        system: SYSTEM_PROMPT,
        user: `${user}\n\n${JSON_CONTRACT}`,
        maxTokens: 2000,
        json: true,
      });
    } catch (err) {
      console.error('[suggest] request failed', err);
      return NextResponse.json({ proposal: null, reason: 'upstream_error' });
    }
  }

  const draft = text ? proposalFromText(text, board.nodes.map((n) => n.id)) : null;
  return NextResponse.json({ proposal: draft });
}
