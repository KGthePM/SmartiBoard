import { NextResponse } from 'next/server';
import { clearSettingsApiKey, loadSettings, saveSettings } from '@/lib/db';
import { keyHint, PRESETS, type ProviderId } from '@/lib/ai/providers';
import { DEBOUNCE_MS, normalizeGhostDelay } from '@/lib/ai/trigger';
import { DEFAULT_THEME, normalizeTheme } from '@/lib/theme';
import { DEFAULT_COLLAPSE_MODE, normalizeCollapseMode } from '@/lib/collapse';

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
    ghostDelayMs: s.ghostDelayMs,
    theme: s.theme,
    collapseMode: s.collapseMode,
    hasKey: Boolean(s.apiKey.trim()),
    keyHint: keyHint(s.apiKey),
  };
}

export async function GET() {
  return NextResponse.json({ settings: masked() });
}

export async function PUT(req: Request) {
  let body: {
    provider?: unknown;
    apiKey?: unknown;
    baseUrl?: unknown;
    model?: unknown;
    ghostDelayMs?: unknown;
    theme?: unknown;
    collapseMode?: unknown;
  };
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

  // Off-ladder junk lands on the default rather than rejecting the save: the
  // window is a preference, and a stale client's odd number must not wedge the
  // ghost or block the provider fields it rode in with. An absent value keeps
  // the stored one — same doctrine as the key: the form sends what it holds.
  const stored = loadSettings();
  const ghostDelayMs =
    body.ghostDelayMs === undefined ? (stored?.ghostDelayMs ?? DEBOUNCE_MS) : normalizeGhostDelay(body.ghostDelayMs);

  // Same rule for the theme, and the same reason: it is a preference riding
  // along with the provider fields, and an unknown value must not fail the
  // save it arrived with — nor leave the app on a data-theme no stylesheet
  // answers to.
  const theme = body.theme === undefined ? (stored?.theme ?? DEFAULT_THEME) : normalizeTheme(body.theme);

  // And once more for what a done card does with its space. Nothing about it
  // can fail a save: it is a view of content the board already carries.
  const collapseMode =
    body.collapseMode === undefined
      ? (stored?.collapseMode ?? DEFAULT_COLLAPSE_MODE)
      : normalizeCollapseMode(body.collapseMode);

  saveSettings({
    provider: body.provider as ProviderId,
    ...(apiKey !== undefined ? { apiKey } : {}),
    baseUrl: str(body.baseUrl, 2048),
    model: str(body.model, 200),
    ghostDelayMs,
    theme,
    collapseMode,
  });

  return NextResponse.json({ settings: masked() });
}

export async function DELETE() {
  clearSettingsApiKey();
  return NextResponse.json({ settings: masked() });
}
