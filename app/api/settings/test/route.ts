import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { OpenAiError, openaiComplete } from '@/lib/ai/openai';
import { PRESETS, resolveConfigFrom, type ProviderId } from '@/lib/ai/providers';
import { loadSettings } from '@/lib/db';

export const runtime = 'nodejs';

/**
 * "Does this configuration actually work?" — the one place in the product that
 * reports an AI failure out loud.
 *
 * It exists because both real AI behaviors fail quietly by design: the ghost
 * simply never appears, and the summary says only "couldn't summarize". That
 * is right for the board and useless for setup, where a typo'd port or a stale
 * key is indistinguishable from a model that had nothing to add.
 *
 * The body is the *unsaved* form, so a configuration can be tested before it is
 * committed. A blank key means "use the one already stored", matching the save
 * path — the panel never holds the real key, so it cannot send it back.
 */

type TestResult =
  | { ok: true; model: string }
  | { ok: false; reason: 'no_config' | 'auth' | 'unreachable' | 'model' | 'error'; detail?: string };

/**
 * One line, never the key. Providers wrap the useful sentence in a JSON error
 * envelope (and the SDK prefixes it with the status), so dig the message out
 * when there is one — "API key is invalid" is worth showing, the envelope isn't.
 */
function short(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const brace = flat.indexOf('{');
  if (brace !== -1) {
    try {
      const body = JSON.parse(flat.slice(brace)) as {
        error?: { message?: unknown };
        message?: unknown;
      };
      const msg = body.error?.message ?? body.message;
      if (typeof msg === 'string' && msg.trim()) return msg.trim().slice(0, 200);
    } catch {
      // Not JSON, or truncated JSON — the raw text is still better than nothing.
    }
  }
  return flat.slice(0, 200);
}

/**
 * Status codes mean roughly the same thing everywhere: 401/403 is the key,
 * 404 is the endpoint or the model name. Anything with no status at all never
 * reached a server — a wrong host or a local model server that isn't running,
 * which is the single most common Ollama mistake.
 */
function classify(status: number | undefined, detail: string): TestResult {
  if (status === undefined) return { ok: false, reason: 'unreachable', detail };
  if (status === 401 || status === 403) return { ok: false, reason: 'auth', detail };
  if (status === 404 || (status === 400 && /model/i.test(detail))) {
    return { ok: false, reason: 'model', detail };
  }
  return { ok: false, reason: 'error', detail: `${status} · ${detail}` };
}

export async function POST(req: Request) {
  let body: { provider?: unknown; apiKey?: unknown; baseUrl?: unknown; model?: unknown };
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
  // stored under — testing z.ai must not quietly use the Anthropic key.
  const stored = loadSettings();
  const apiKey = typed || (stored?.provider === provider ? stored.apiKey : '');

  const cfg = resolveConfigFrom(
    { provider, apiKey, baseUrl: str(body.baseUrl), model: str(body.model) },
    undefined,
  );
  if (!cfg) {
    return NextResponse.json<TestResult>({ ok: false, reason: 'no_config' });
  }

  // The smallest call each wire flavor allows: one token, no thinking, no
  // schema. This is a reachability and credentials check, not a quality check.
  try {
    if (cfg.flavor === 'anthropic') {
      const client = new Anthropic({ apiKey: cfg.apiKey!, baseURL: cfg.baseUrl || undefined });
      await client.messages.create({
        model: cfg.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });
    } else {
      await openaiComplete(cfg, { system: 'Reply with one word.', user: 'hi', maxTokens: 1 });
    }
    return NextResponse.json<TestResult>({ ok: true, model: cfg.model });
  } catch (err) {
    if (err instanceof OpenAiError) {
      return NextResponse.json(classify(err.status, short(err.detail)));
    }
    if (err instanceof Anthropic.APIError) {
      return NextResponse.json(classify(err.status, short(err.message)));
    }
    // A fetch that never got a response — bad host, wrong port, nothing listening.
    return NextResponse.json(classify(undefined, short(err instanceof Error ? err.message : '')));
  }
}
