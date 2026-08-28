'use client';

import { useEffect, useState } from 'react';
import { PRESETS, PROVIDERS, type ProviderId } from '@/lib/ai/providers';

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
  hasKey: boolean;
  keyHint: string | null;
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
  error: 'The provider returned an error.',
};

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [provider, setProvider] = useState<ProviderId>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(PRESETS.anthropic.defaultBaseUrl);
  const [model, setModel] = useState(PRESETS.anthropic.defaultModel);
  const [stored, setStored] = useState<Masked | null>(null);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<TestState>({ phase: 'idle' });

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
    setBaseUrl(stored?.provider === id ? stored.baseUrl || next.defaultBaseUrl : next.defaultBaseUrl);
    setModel(stored?.provider === id ? stored.model || next.defaultModel : next.defaultModel);
  };

  /** The form as the API wants it. A blank key is omitted, not sent as ''. */
  const payload = () => ({
    provider,
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    baseUrl: baseUrl.trim(),
    model: model.trim(),
  });

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
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload()),
      });
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
  };

  // Anthropic talks to the SDK's own endpoint; there is nothing useful to type.
  const showBaseUrl = preset.flavor === 'openai';
  const showKey = preset.needsKey || provider === 'custom';
  const canSave = ready && !saving && Boolean(model.trim()) && (!showBaseUrl || Boolean(baseUrl.trim()));

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
                onChange={(e) => setApiKey(e.target.value)}
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
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </label>
          ) : null}

          <label className="settings-field">
            <span className="settings-label">Model</span>
            <input
              className="settings-input"
              autoComplete="off"
              spellCheck={false}
              value={model}
              placeholder={preset.defaultModel || 'model name'}
              onChange={(e) => setModel(e.target.value)}
            />
          </label>

          <p className="settings-note">
            Stored on this machine, in the same file as your boards. The key is never sent to
            the browser and never leaves for anywhere but the provider you picked.
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
