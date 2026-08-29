import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { OpenAiError, openaiListModels, type ModelInfo } from '@/lib/ai/openai';
import { PRESETS, resolveEndpointFrom, type ProviderId } from '@/lib/ai/providers';
import { DEBOUNCE_MS } from '@/lib/ai/trigger';
import { classify, short, type UpstreamReason } from '@/lib/ai/upstream';
import { loadSettings } from '@/lib/db';

export const runtime = 'nodejs';

/**
 * "Which models can this key actually reach?" — the list behind the Model
 * dropdown in settings.
 *
 * It exists because a wrong model name and an unentitled one look identical
 * from the connection test: both come back as "that model was not found". The
 * provider already knows the answer, so ask it once, on the user's click.
 *
 * Like the connection test, the body is the *unsaved* form and a blank key
 * means "the one already stored". Unlike it, no model is needed — this call has
 * to work before a model has been chosen, which is why it resolves through
 * `resolveEndpointFrom` rather than `resolveConfigFrom`.
 *
 * Nothing about this call is automatic: it costs a round trip to the provider,
 * so it happens on the Load button and nowhere else.
 */

type ModelsResult =
  | { ok: true; models: ModelInfo[] }
  | { ok: false; reason: UpstreamReason | 'unsupported'; detail?: string };

/** Anthropic pages its model list; nobody needs more than this to pick from. */
const MAX_MODELS = 200;

/**
 * A listing failure classified like any other, with one correction: `model`
 * means "no such model", which is meaningless when no model was named. From
 * here a 404 is the endpoint — an OpenAI-shaped server that has no /models.
 */
function failed(status: number | undefined, detail: string): ModelsResult {
  const verdict = classify(status, detail);
  if (verdict.reason === 'model') {
    return { ok: false, reason: 'unsupported', detail: verdict.detail };
  }
  return { ok: false, ...verdict };
}

export async function POST(req: Request) {
  let body: { provider?: unknown; apiKey?: unknown; baseUrl?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  if (typeof body.provider !== 'string' || !(body.provider in PRESETS)) {
    return NextResponse.json({ error: 'unknown provider' }, { status: 400 });
  }

  const provider = body.provider as ProviderId;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const typed = str(body.apiKey);
  // An empty field means the stored key, but only for the provider it was
  // stored under — listing z.ai's models must not quietly use the Anthropic key.
  const stored = loadSettings();
  const apiKey = typed || (stored?.provider === provider ? stored.apiKey : '');

  const cfg = resolveEndpointFrom({
    provider,
    apiKey,
    baseUrl: str(body.baseUrl),
    model: '',
    // Resolution never reads it; the type carries the whole row.
    ghostDelayMs: DEBOUNCE_MS,
  });
  if (!cfg) {
    return NextResponse.json<ModelsResult>({ ok: false, reason: 'no_config' });
  }

  try {
    let models: ModelInfo[];
    if (cfg.flavor === 'anthropic') {
      const client = new Anthropic({ apiKey: cfg.apiKey!, baseURL: cfg.baseUrl || undefined });
      models = [];
      // The display name is the readable half ("Claude Opus 5"); the id is what
      // actually gets sent, so the picker shows both.
      for await (const m of client.models.list({ limit: 100 })) {
        models.push({ id: m.id, label: m.display_name });
        if (models.length >= MAX_MODELS) break;
      }
    } else {
      models = (await openaiListModels(cfg)).slice(0, MAX_MODELS);
    }
    return NextResponse.json<ModelsResult>({ ok: true, models });
  } catch (err) {
    if (err instanceof OpenAiError) {
      return NextResponse.json<ModelsResult>(failed(err.status, short(err.detail)));
    }
    if (err instanceof Anthropic.APIError) {
      return NextResponse.json<ModelsResult>(failed(err.status, short(err.message)));
    }
    // A fetch that never got a response — bad host, wrong port, nothing listening.
    return NextResponse.json<ModelsResult>(
      failed(undefined, short(err instanceof Error ? err.message : '')),
    );
  }
}
