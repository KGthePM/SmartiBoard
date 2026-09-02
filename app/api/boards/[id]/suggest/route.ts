import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { guardBoard } from '@/lib/access';
import type { LlmConfig } from '@/lib/ai/providers';
import { resolveConfig } from '@/lib/ai/config';
import { openaiComplete } from '@/lib/ai/openai';
import { causeChain } from '@/lib/ai/upstream';
import { proposalFromText } from '@/lib/ai/parse';
import { JSON_CONTRACT, PROPOSAL_SCHEMA, SYSTEM_PROMPT, serializeBoard } from '@/lib/ai/prompt';
import { loadBoard } from '@/lib/db';
import { newId, parseBoard, type Board } from '@/lib/graph';
import { claimGhost, publish, releaseGhost } from '@/lib/hub';

export const runtime = 'nodejs';

/** Long enough for a slow model, short enough that a dead socket isn't forever. */
const SUGGEST_TIMEOUT_MS = 60_000;

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

  // Above the privacy check on purpose: a caller with no right to this board
  // must not be able to tell "privacy is on" from "no such board".
  const denied = guardBoard(req, id);
  if (denied) return denied;

  // Privacy Mode, checked before anything is read and before a provider is even
  // resolved. The trigger declines to ask, but that is a client being polite;
  // this is the promise. The stored board is the authority precisely because
  // the caller isn't — a stale tab, a retry, or anything that is not our canvas
  // gets the same answer.
  if (loadBoard(id).privacy) {
    return NextResponse.json({ proposal: null, reason: 'privacy' });
  }

  let body: {
    board?: unknown;
    rejected?: unknown;
    clientId?: unknown;
    fingerprint?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const board = parseBoard(id, body.board);
  // The second half of the same check. Autosave lags a toggle by up to
  // AUTOSAVE_MS, so for that window the stored row still says false while the
  // board in the browser says true — and the board in the browser is the one
  // about to be sent. Either flag is enough to refuse.
  if (board.privacy) {
    return NextResponse.json({ proposal: null, reason: 'privacy' });
  }

  const rejected = Array.isArray(body.rejected)
    ? body.rejected.filter((r): r is string => typeof r === 'string').slice(-12)
    : [];

  // Anonymous callers get an id of their own rather than sharing the empty
  // string, which would let two of them renew each other's lease.
  const clientId = typeof body.clientId === 'string' && body.clientId ? body.clientId : newId('c');
  const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint : '';

  /**
   * The room's ghost, claimed before a provider is resolved and before anything
   * is spent (v4.0). `shouldRequest` permits one live ghost per board, but that
   * is a client-side policy: N clients watching one board would fire N requests
   * per change and spend the host's key N times over. A loser is told
   * `claimed` — a refusal ranked with `privacy` and `no_api_key`, not an error
   * — and goes quiet, because it stamped the fingerprint before it asked and
   * will be shown the winner's ghost on the stream.
   */
  if (!claimGhost(id, clientId, fingerprint)) {
    return NextResponse.json({ proposal: null, reason: 'claimed' });
  }

  try {
    const cfg = resolveConfig();
    if (!cfg) {
      // Bring-your-own-key: no configuration is a valid configuration, not an
      // error. The board stays fully usable; it just doesn't co-author.
      return NextResponse.json({ proposal: null, reason: 'no_api_key' });
    }

    const answer = await ask(cfg, board, rejected);
    if ('reason' in answer) return NextResponse.json({ proposal: null, reason: answer.reason });

    const draft = answer.text ? proposalFromText(answer.text, board.nodes.map((n) => n.id)) : null;
    if (!draft) return NextResponse.json({ proposal: null });

    // The room's name for this ghost, minted here so that accepting or
    // dismissing it names the same one on every screen. The winner learns it
    // from this response; everyone else learns it, and the draft, from the
    // frame — and drops this one, since it carries their own clientId.
    const proposalId = newId('p');
    publish(id, { type: 'ghost', clientId, phase: 'proposed', proposalId, draft });
    return NextResponse.json({ proposal: draft, proposalId });
  } finally {
    // However this went, the room's ghost goes back on the table. The lease
    // only has to outlive the claim itself; lib/hub.ts's timer is what covers
    // the tab that dies before ever reaching this line.
    releaseGhost(id, clientId);
  }
}

/** The model call, in whichever wire flavor the install is configured for. */
async function ask(
  cfg: LlmConfig,
  board: Board,
  rejected: string[],
): Promise<{ text: string | null } | { reason: string }> {
  const user = serializeBoard(board, rejected);

  if (cfg.flavor !== 'anthropic') {
    try {
      return {
        text: await openaiComplete(cfg, {
          system: SYSTEM_PROMPT,
          user: `${user}\n\n${JSON_CONTRACT}`,
          maxTokens: 2000,
          json: true,
          // Plain fetch has no timeout of its own; same bound as the SDK path.
          signal: AbortSignal.timeout(SUGGEST_TIMEOUT_MS),
        }),
      };
    } catch (err) {
      console.error('[suggest] request failed:', causeChain(err));
      return { reason: 'upstream_error' };
    }
  }

  // Bounded, unlike the SDK's ten-minute default: nobody is waiting on a ghost,
  // but an in-flight request blocks every later one behind the trigger's
  // in_flight gate, so a wedged connection must not outlive the session.
  const client = new Anthropic({
    apiKey: cfg.apiKey!,
    baseURL: cfg.baseUrl || undefined,
    timeout: SUGGEST_TIMEOUT_MS,
  });

  // The SDK extras — adaptive thinking, schema-constrained output, prompt
  // caching — are Anthropic-the-company features that a third party speaking
  // this wire flavor (z.ai's Coding Plan) may reject. They ride along only
  // for the real thing; everyone else gets the same plain call the openai
  // flavor makes, with the JSON contract in the message instead.
  const params: Anthropic.MessageCreateParamsNonStreaming =
    cfg.provider === 'anthropic'
      ? {
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
        }
      : {
          model: cfg.model,
          max_tokens: 2000,
          // Thinking off, explicitly: a compat endpoint that reasons by
          // default (GLM on z.ai's Coding Plan does) spends the whole budget
          // on a thinking block and stops before the JSON — a ghost that
          // never appears, indistinguishable from having nothing to add.
          thinking: { type: 'disabled' },
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: `${user}\n\n${JSON_CONTRACT}` }],
        };

  let response;
  try {
    response = await client.messages.create(params);
  } catch (err) {
    console.error('[suggest] request failed:', causeChain(err));
    return { reason: 'upstream_error' };
  }

  // Check the stop reason before reading content — a refusal has no usable body.
  if (response.stop_reason === 'refusal') return { reason: 'refusal' };
  const block = response.content.find((b) => b.type === 'text');
  return { text: block && block.type === 'text' ? block.text : null };
}
