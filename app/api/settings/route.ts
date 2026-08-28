import { NextResponse } from 'next/server';
import { clearSettingsApiKey, loadSettings, saveSettings } from '@/lib/db';
import { keyHint, PRESETS, type ProviderId } from '@/lib/ai/providers';

export const runtime = 'nodejs';

/**
 * The Settings panel's backend. The one rule that shapes it: the API key is
 * write-only. It arrives here once per save, lands in the local SQLite file,
 * and is read again only when a model call is actually made — GET never
 * returns it, not even to the panel that saved it. The panel shows a hint
 * (last four characters) so the user can tell a key is set and which one.
 */

/** Everything the UI may know about the stored configuration. */
function masked() {
  const s = loadSettings();
  if (!s) return null;
  return {
    provider: s.provider,
    baseUrl: s.baseUrl,
    model: s.model,
    hasKey: Boolean(s.apiKey.trim()),
    keyHint: keyHint(s.apiKey),
  };
}

export async function GET() {
  return NextResponse.json({ settings: masked() });
}

export async function PUT(req: Request) {
  let body: { provider?: unknown; apiKey?: unknown; baseUrl?: unknown; model?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  if (typeof body.provider !== 'string' || !(body.provider in PRESETS)) {
    return NextResponse.json({ error: 'unknown provider' }, { status: 400 });
  }

  // An absent apiKey keeps the stored one — the form leaves the field blank
  // rather than echoing the key back for editing. An explicit empty string
  // clears it.
  const apiKey =
    body.apiKey === undefined
      ? undefined
      : typeof body.apiKey === 'string'
        ? body.apiKey.trim().slice(0, 4096)
        : '';

  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

  saveSettings({
    provider: body.provider as ProviderId,
    ...(apiKey !== undefined ? { apiKey } : {}),
    baseUrl: str(body.baseUrl, 2048),
    model: str(body.model, 200),
  });

  return NextResponse.json({ settings: masked() });
}

export async function DELETE() {
  clearSettingsApiKey();
  return NextResponse.json({ settings: masked() });
}
