import Anthropic from '@anthropic-ai/sdk';
import { NextResponse } from 'next/server';
import { OpenAiError, openaiComplete } from '@/lib/ai/openai';
import { PRESETS, resolveConfigFrom, type ProviderId } from '@/lib/ai/providers';
import { DEBOUNCE_MS } from '@/lib/ai/trigger';
import { classify, short, type UpstreamReason } from '@/lib/ai/upstream';
import { loadSettings } from '@/lib/db';
import { DEFAULT_THEME } from '@/lib/theme';
import { DEFAULT_COLLAPSE_MODE } from '@/lib/collapse';

export const runtime = 'nodejs';

/**
 * "Does this configuration actually work?" — with its sibling /models, one of
 * the two places in the product that report an AI failure out loud, and the
 * only one that reports on a real completion.
 *
 * It exists because both real AI behaviors fail quietly by design: the ghost
 * simply never appears, and the ideas panel says only "couldn't come up with
 * anything for this board". That
 * is right for the board and useless for setup, where a typo'd port or a stale
 * key is indistinguishable from a model that had nothing to add.
 *
 * The body is the *unsaved* form, so a configuration can be tested before it is
 * committed. A blank key means "use the one already stored", matching the save
 * path — the panel never holds the real key, so it cannot send it back.
 */

type TestResult =
  | { ok: true; model: string }
  | { ok: false; reason: UpstreamReason; detail?: string };

/** classify() gives the verdict; a failed test is always `ok: false`. */
function failed(status: number | undefined, detail: string): TestResult {
  return { ok: false, ...classify(status, detail) };
}

export async function POST(req: Request) {
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(60_000)]);
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
    {
      provider,
      apiKey,
      baseUrl: str(body.baseUrl),
      model: str(body.model),
      // Resolution never reads it; the type carries the whole row.
      ghostDelayMs: DEBOUNCE_MS,
      theme: DEFAULT_THEME,
      collapseMode: DEFAULT_COLLAPSE_MODE,
    },
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
      await client.messages.create(
        {
          model: cfg.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        },
        { signal },
      );
    } else {
      await openaiComplete(cfg, { system: 'Reply with one word.', user: 'hi', maxTokens: 1, signal });
    }
    return NextResponse.json<TestResult>({ ok: true, model: cfg.model });
  } catch (err) {
    if (signal.aborted) {
      return NextResponse.json<TestResult>({ ok: false, reason: 'error' }, { status: 499 });
    }
    if (err instanceof OpenAiError) {
      return NextResponse.json<TestResult>(failed(err.status, short(err.detail)));
    }
    if (err instanceof Anthropic.APIError) {
      return NextResponse.json<TestResult>(failed(err.status, short(err.message)));
    }
    // A fetch that never got a response — bad host, wrong port, nothing listening.
    return NextResponse.json<TestResult>(
      failed(undefined, short(err instanceof Error ? err.message : '')),
    );
  }
}
