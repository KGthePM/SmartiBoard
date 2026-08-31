'use client';

import { useEffect, useState } from 'react';
import type { ModelInfo } from '@/lib/ai/openai';
import { PRESETS, PROVIDERS, type ProviderId } from '@/lib/ai/providers';
import { DEBOUNCE_MS, GHOST_DELAY_OFF, GHOST_DELAY_STEPS_MS } from '@/lib/ai/trigger';
import { useBoard } from '@/lib/store';
import { DEFAULT_THEME, THEME_LABELS, THEMES, type ThemeId } from '@/lib/theme';
import {
  COLLAPSE_LABELS,
  COLLAPSE_MODES,
  DEFAULT_COLLAPSE_MODE,
  normalizeCollapseMode,
  type CollapseMode,
} from '@/lib/collapse';

/**
 * Where the user says which model co-authors their boards.
 *
 * The rule that shapes this panel: the key is write-only. It goes to the
 * server once and never comes back — the field is blank on open even when a
 * key is stored, and "blank" means "keep what's there" rather than "clear it".
 * A last-four hint is the only evidence the panel ever sees, which is enough to
 * answer "is a key set, and is it the one I think?" and nothing more.
 *
 * Provider config belongs to the install, not to a board, so this is reachable
 * from any board and reads the same everywhere.
 */

type Masked = {
  provider: ProviderId;
  baseUrl: string;
  model: string;
  ghostDelayMs: number;
  theme: ThemeId;
  collapseMode: CollapseMode;
  hasKey: boolean;
  keyHint: string | null;
};

/**
 * The ghost frequency rungs, as the dropdown shows them. The ghost fires once
 * per material change — never on a wall clock — so each rung names the window
 * of stillness that precedes it, which is the only honest phrasing of "how
 * often" this design permits.
 */
const GHOST_DELAY_LABELS: Record<number, string> = {
  [DEBOUNCE_MS]: 'After 4s of stillness (default)',
  10000: 'After 10s of stillness',
  30000: 'After 30s of stillness',
  60000: 'After 1 min of stillness',
  [GHOST_DELAY_OFF]: 'Off — never on its own',
};

type TestState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'ok'; model: string }
  | { phase: 'bad'; reason: string; detail?: string };

const REASONS: Record<string, string> = {
  no_config: 'Not enough to go on — fill in the fields below.',
  auth: 'The provider rejected the key.',
  unreachable: "Couldn't reach that address. Is the server running?",
  model: 'That model name was not found.',
  unsupported: "That endpoint doesn't list its models — type the name instead.",
  no_models: 'The provider listed no models — type the name instead.',
  error: 'The provider returned an error.',
};

/**
 * The escape hatch out of the dropdown, as a <select> value. A control
 * character so it can never collide with a real model id.
 */
const FREE_TEXT = '\u0000';

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [provider, setProvider] = useState<ProviderId>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(PRESETS.anthropic.defaultBaseUrl);
  const [model, setModel] = useState(PRESETS.anthropic.defaultModel);
  const [stored, setStored] = useState<Masked | null>(null);
  const [ghostDelay, setGhostDelay] = useState<number>(DEBOUNCE_MS);
  const [theme, setTheme] = useState<ThemeId>(DEFAULT_THEME);
  const [collapseMode, setCollapseMode] = useState<CollapseMode>(DEFAULT_COLLAPSE_MODE);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<TestState>({ phase: 'idle' });
  /** null means free-text mode: either nothing loaded yet, or the user opted out. */
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [listing, setListing] = useState(false);

  const preset = PRESETS[provider];
  /** A key already saved for *this* provider — switching away stops crediting it. */
  const keptKey = Boolean(stored?.hasKey && stored.provider === provider);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d: { settings: Masked | null }) => {
        if (cancelled) return;
        if (d.settings) {
          const p = PRESETS[d.settings.provider] ?? PRESETS.anthropic;
          setStored(d.settings);
          setProvider(p.id);
          // A blank stored field means "whatever the preset says" — show that,
          // so the panel never presents an empty box as if nothing were set.
          setBaseUrl(d.settings.baseUrl || p.defaultBaseUrl);
          setModel(d.settings.model || p.defaultModel);
          // Already normalized on read by the server, so it is a legal rung.
          setGhostDelay(d.settings.ghostDelayMs);
          setTheme(d.settings.theme);
          setCollapseMode(d.settings.collapseMode);
        }
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * Switching provider refills the endpoint and model with that provider's
   * defaults. Edits belonged to the provider they were made under — carrying
   * `claude-opus-5` over to Ollama would only produce a confusing failure.
   */
  const pickProvider = (id: ProviderId) => {
    const next = PRESETS[id];
    setProvider(id);
    setApiKey('');
    setTest({ phase: 'idle' });
    setModels(null);
    setBaseUrl(stored?.provider === id ? stored.baseUrl || next.defaultBaseUrl : next.defaultBaseUrl);
    setModel(stored?.provider === id ? stored.model || next.defaultModel : next.defaultModel);
  };

  /** The form as the API wants it. A blank key is omitted, not sent as ''. */
  const payload = () => ({
    provider,
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    baseUrl: baseUrl.trim(),
    model: model.trim(),
    ghostDelayMs: ghostDelay,
    theme,
    collapseMode,
  });

  /**
   * Ask the provider what this key can reach. Strictly button-driven — opening
   * the panel or typing a key must never call out on its own.
   */
  const loadModels = async () => {
    setListing(true);
    setTest({ phase: 'idle' });
    try {
      const res = await fetch('/api/settings/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Everything payload() sends except the model — that is what is being asked for.
        body: JSON.stringify({
          provider,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          baseUrl: baseUrl.trim(),
        }),
      });
      const d = (await res.json()) as {
        ok?: boolean;
        models?: ModelInfo[];
        reason?: string;
        detail?: string;
      };
      if (!d.ok) {
        setTest({ phase: 'bad', reason: d.reason ?? 'error', detail: d.detail });
      } else if (!d.models?.length) {
        // A dropdown with nothing in it is worse than the box they already had.
        setTest({ phase: 'bad', reason: 'no_models' });
      } else {
        setModels(d.models);
        // Only fill a blank field. A model already typed or saved stays put even
        // when the provider didn't list it — silently reassigning it is the one
        // thing this feature must not do.
        if (!model.trim()) setModel(d.models[0].id);
      }
    } catch {
      setTest({ phase: 'bad', reason: 'error' });
    } finally {
      setListing(false);
    }
  };

  const runTest = async () => {
    setTest({ phase: 'running' });
    try {
      const res = await fetch('/api/settings/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload()),
      });
      const d = (await res.json()) as {
        ok?: boolean;
        model?: string;
        reason?: string;
        detail?: string;
      };
      setTest(
        d.ok
          ? { phase: 'ok', model: d.model ?? model }
          : { phase: 'bad', reason: d.reason ?? 'error', detail: d.detail },
      );
    } catch {
      setTest({ phase: 'bad', reason: 'error' });
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload()),
      });
      const d = (await res.json()) as { settings: Masked | null };
      if (d.settings) setStored(d.settings);
      // The store is the suggest loop's only channel to this setting — write
      // the server's (normalized) value so the new window applies live,
      // without a reload. Off, too: the loop re-reads it every tick.
      if (typeof d.settings?.ghostDelayMs === 'number') {
        useBoard.getState().setGhostDelay(d.settings.ghostDelayMs);
      }
      // The theme's only channel is the attribute the server stamped on <html>
      // at load — there is nothing in the store to update, because nothing in
      // JS reads it. Writing it here is what makes the change land without a
      // reload; the next request will render with it already set.
      if (d.settings?.theme) document.documentElement.dataset.theme = d.settings.theme;
      // Folding goes through the store like the ghost's window, not through an
      // attribute like the theme: the canvas reads it in JS to decide the
      // geometry the cards and the edges between them are drawn at.
      if (typeof d.settings?.collapseMode === 'string') {
        useBoard.getState().setCollapseMode(normalizeCollapseMode(d.settings.collapseMode));
      }
      onClose();
    } catch {
      setSaving(false);
      setTest({ phase: 'bad', reason: 'error', detail: "couldn't save" });
    }
  };

  const forget = async () => {
    const res = await fetch('/api/settings', { method: 'DELETE' });
    const d = (await res.json()) as { settings: Masked | null };
    setStored(d.settings);
    setApiKey('');
    setTest({ phase: 'idle' });
    setModels(null);
  };

  // The anthropic flavor's endpoint is baked into each preset (or left to the
  // SDK, for Anthropic itself); there is nothing useful to type.
  const showBaseUrl = preset.flavor === 'openai';
  const showKey = preset.needsKey || provider === 'custom';
  const canSave =
    ready && !saving && Boolean(model.trim()) && (!showBaseUrl || Boolean(baseUrl.trim()));
  // Listing needs everything a call needs except the model — that is the point.
  const canList =
    ready &&
    !listing &&
    (!showBaseUrl || Boolean(baseUrl.trim())) &&
    (!preset.needsKey || Boolean(apiKey.trim()) || keptKey);
  /** A saved-but-unlisted model still belongs in the list, at the top. */
  const options =
    models && model.trim() && !models.some((m) => m.id === model)
      ? [{ id: model }, ...models]
      : (models ?? []);

  return (
    <div className="settings-back" onPointerDown={onClose}>
      <div
        className="settings"
        role="dialog"
        aria-label="AI provider settings"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="settings-head">
          <span className="settings-title">Model</span>
          <button className="settings-x" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="settings-body">
          <label className="settings-field">
            <span className="settings-label">Provider</span>
            <select
              className="settings-select"
              value={provider}
              onChange={(e) => pickProvider(e.target.value as ProviderId)}
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          {showKey ? (
            <div className="settings-field">
              {/* A div, not a label: the "Forget key" button lives in here, and
                  clicking it must not also poke the input a label would wrap. */}
              <label className="settings-label" htmlFor="settings-key">
                API key
                {preset.needsKey ? '' : ' (optional)'}
              </label>
              <input
                id="settings-key"
                className="settings-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                placeholder={keptKey ? `saved · ${stored?.keyHint ?? ''}` : 'sk-…'}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  // A different key may see a different catalogue.
                  setModels(null);
                }}
              />
              {keptKey ? (
                <span className="settings-hint">
                  Leave blank to keep it.{' '}
                  <button className="settings-link" onClick={() => void forget()}>
                    Forget key
                  </button>
                </span>
              ) : null}
            </div>
          ) : null}

          {showBaseUrl ? (
            <label className="settings-field">
              <span className="settings-label">Endpoint</span>
              <input
                className="settings-input"
                autoComplete="off"
                spellCheck={false}
                value={baseUrl}
                placeholder="http://localhost:11434/v1"
                onChange={(e) => {
                  setBaseUrl(e.target.value);
                  // The loaded list belongs to the endpoint it came from.
                  setModels(null);
                }}
              />
            </label>
          ) : null}

          <div className="settings-field">
            {/* A div, not a label, for the same reason as the key field: the
                Load button must not double as a click on the input. */}
            <span className="settings-label-row">
              <label className="settings-label" htmlFor="settings-model">
                Model
              </label>
              <button
                className="settings-link"
                onClick={() => void loadModels()}
                disabled={!canList}
              >
                {listing ? 'Loading…' : 'Load models'}
              </button>
            </span>
            {models ? (
              <select
                id="settings-model"
                className="settings-select"
                value={model}
                onChange={(e) => {
                  if (e.target.value === FREE_TEXT) {
                    setModels(null);
                    return;
                  }
                  setModel(e.target.value);
                  setTest({ phase: 'idle' });
                }}
              >
                {options.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label ? `${m.id} · ${m.label}` : m.id}
                  </option>
                ))}
                <option value={FREE_TEXT}>Type a name…</option>
              </select>
            ) : (
              <input
                id="settings-model"
                className="settings-input"
                autoComplete="off"
                spellCheck={false}
                value={model}
                placeholder={preset.defaultModel || 'model name'}
                onChange={(e) => setModel(e.target.value)}
              />
            )}
          </div>

          <label className="settings-field">
            <span className="settings-label">Ghost suggestions</span>
            <select
              className="settings-select"
              value={String(ghostDelay)}
              onChange={(e) => setGhostDelay(Number(e.target.value))}
            >
              {[DEBOUNCE_MS, ...GHOST_DELAY_STEPS_MS.filter((ms) => ms !== DEBOUNCE_MS), GHOST_DELAY_OFF].map(
                (ms) => (
                  <option key={ms} value={String(ms)}>
                    {GHOST_DELAY_LABELS[ms]}
                  </option>
                ),
              )}
            </select>
            <span className="settings-hint">
              How long the board sits still after an edit before the ghost may offer one suggestion. Off
              turns the unsolicited ghost off everywhere — the Ideas button (⌘.) still works.
            </span>
          </label>

          <label className="settings-field">
            <span className="settings-label">Theme</span>
            <select
              className="settings-select"
              value={theme}
              onChange={(e) => setTheme(e.target.value as ThemeId)}
            >
              {THEMES.map((t) => (
                <option key={t} value={t}>
                  {THEME_LABELS[t]}
                </option>
              ))}
            </select>
            <span className="settings-hint">
              How the board looks, on this machine — every board, not just this one. It changes nothing the
              AI sees.
            </span>
          </label>

          <label className="settings-field">
            <span className="settings-label">Completed cards</span>
            <select
              className="settings-select"
              value={collapseMode}
              onChange={(e) => setCollapseMode(normalizeCollapseMode(e.target.value))}
            >
              {COLLAPSE_MODES.map((m) => (
                <option key={m} value={m}>
                  {COLLAPSE_LABELS[m]}
                </option>
              ))}
            </select>
            <span className="settings-hint">
              What a card crossed off with ✓ does with the space it is taking — a single clipped line, or
              a dot wearing just the ▸. Either way it is only a way of looking at the board: the card
              keeps its text, its size, and its place, and the ▸ on it opens it again. Like the theme,
              this is every board on this machine.
            </span>
          </label>

          <p className="settings-note">
            Stored on this machine, in the same file as your boards. The key is never sent to the browser and
            never leaves for anywhere but the provider you picked.
          </p>

          <p className="settings-credit">
            <a
              href="https://smartiboard.netlify.app/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Website
            </a>
            <span aria-hidden="true">·</span>
            <a
              href="https://smartiboard.netlify.app/support.html"
              target="_blank"
              rel="noopener noreferrer"
            >
              Support &amp; FAQ
            </a>
          </p>

          {test.phase === 'ok' ? (
            <p className="settings-result ok">Connected · {test.model}</p>
          ) : null}
          {test.phase === 'bad' ? (
            <p className="settings-result bad">
              {REASONS[test.reason] ?? REASONS.error}
              {test.detail ? <span className="settings-detail">{test.detail}</span> : null}
            </p>
          ) : null}
        </div>

        <div className="settings-foot">
          <button className="settings-test" onClick={() => void runTest()} disabled={!canSave}>
            {test.phase === 'running' ? 'Testing…' : 'Test'}
          </button>
          <button className="settings-save" onClick={() => void save()} disabled={!canSave}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
