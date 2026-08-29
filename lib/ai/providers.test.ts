import { describe, expect, it } from 'vitest';
import {
  keyHint,
  PRESETS,
  resolveConfigFrom,
  resolveEndpointFrom,
  type StoredSettings,
} from './providers';

const row = (over: Partial<StoredSettings> = {}): StoredSettings => ({
  provider: 'anthropic',
  apiKey: '',
  baseUrl: '',
  model: '',
  ...over,
});

describe('resolveConfigFrom', () => {
  it('prefers the saved row over the environment key', () => {
    // The env var is the headless fallback. Once someone has opened Settings
    // and chosen something, that choice is the configuration.
    const cfg = resolveConfigFrom(row({ apiKey: 'sk-saved' }), 'sk-from-env');
    expect(cfg?.apiKey).toBe('sk-saved');
  });

  it('falls back to the environment key when nothing is saved', () => {
    const cfg = resolveConfigFrom(null, 'sk-from-env');
    expect(cfg).toEqual({
      provider: 'anthropic',
      flavor: 'anthropic',
      apiKey: 'sk-from-env',
      baseUrl: '',
      model: PRESETS.anthropic.defaultModel,
    });
  });

  it('is unconfigured when there is neither a row nor an env key', () => {
    // Not an error state — the board is fully usable without a model.
    expect(resolveConfigFrom(null, undefined)).toBeNull();
  });

  it('does not rescue a local-model row with an Anthropic env key', () => {
    // The failure this prevents: someone points the board at Ollama, and
    // because a stale ANTHROPIC_API_KEY is still exported, their ideas quietly
    // go to a cloud API instead of staying on their machine.
    const cfg = resolveConfigFrom(row({ provider: 'ollama' }), 'sk-from-env');
    expect(cfg?.provider).toBe('ollama');
    expect(cfg?.apiKey).toBeNull();
  });

  it('is unconfigured when a provider that needs a key has none', () => {
    expect(resolveConfigFrom(row({ provider: 'zai' }), undefined)).toBeNull();
    // Whitespace is not a key.
    expect(resolveConfigFrom(row({ provider: 'zai', apiKey: '   ' }), undefined)).toBeNull();
  });

  it('resolves the z.ai Coding Plan onto its coding endpoint', () => {
    // The subscription key has no balance on the general z.ai API — it is only
    // entitled to the Anthropic-compatible coding endpoint, which is the whole
    // reason this preset exists separately from 'zai'.
    const cfg = resolveConfigFrom(row({ provider: 'zai-coding', apiKey: 'sk-plan' }), undefined);
    expect(cfg).toEqual({
      provider: 'zai-coding',
      flavor: 'anthropic',
      apiKey: 'sk-plan',
      baseUrl: PRESETS['zai-coding'].defaultBaseUrl,
      model: PRESETS['zai-coding'].defaultModel,
    });
    expect(cfg?.baseUrl).toBe('https://api.z.ai/api/anthropic');
    expect(resolveConfigFrom(row({ provider: 'zai-coding' }), undefined)).toBeNull();
  });

  it('fills a blank endpoint and model from the preset', () => {
    const cfg = resolveConfigFrom(row({ provider: 'ollama' }), undefined);
    expect(cfg?.baseUrl).toBe(PRESETS.ollama.defaultBaseUrl);
    expect(cfg?.model).toBe(PRESETS.ollama.defaultModel);
  });

  it('lets a saved value override the preset default', () => {
    const cfg = resolveConfigFrom(
      row({ provider: 'ollama', baseUrl: 'http://box.local:11434/v1', model: 'llama3.2' }),
      undefined,
    );
    expect(cfg?.baseUrl).toBe('http://box.local:11434/v1');
    expect(cfg?.model).toBe('llama3.2');
  });

  it('is unconfigured when a custom provider is missing its endpoint or model', () => {
    // 'custom' has no defaults to fall back on — half a configuration would
    // just produce a request to nowhere.
    expect(resolveConfigFrom(row({ provider: 'custom', model: 'mistral' }), undefined)).toBeNull();
    expect(
      resolveConfigFrom(row({ provider: 'custom', baseUrl: 'http://x/v1' }), undefined),
    ).toBeNull();
    expect(
      resolveConfigFrom(row({ provider: 'custom', baseUrl: 'http://x/v1', model: 'm' }), undefined),
    ).not.toBeNull();
  });

  it('reports the wire flavor each provider speaks', () => {
    expect(resolveConfigFrom(row({ apiKey: 'sk-1' }), undefined)?.flavor).toBe('anthropic');
    expect(resolveConfigFrom(row({ provider: 'ollama' }), undefined)?.flavor).toBe('openai');
  });
});

describe('resolveEndpointFrom', () => {
  // The whole reason this exists: listing a provider's models has to work
  // before a model has been chosen, so a blank model is not a failure here.
  it('resolves with no model set at all', () => {
    expect(resolveEndpointFrom(row({ apiKey: 'sk-live', model: '' }))).toEqual({
      provider: 'anthropic',
      flavor: 'anthropic',
      apiKey: 'sk-live',
      baseUrl: '',
    });
  });

  it('still refuses a key-requiring provider with no key', () => {
    expect(resolveEndpointFrom(row({ provider: 'zai' }))).toBeNull();
  });

  // Without an endpoint there is nowhere to send the request; only the
  // anthropic flavor gets to leave it blank and let the SDK decide.
  it('still refuses an openai-flavored provider with no endpoint', () => {
    expect(resolveEndpointFrom(row({ provider: 'custom', baseUrl: '' }))).toBeNull();
  });

  it('fills a blank endpoint from the preset', () => {
    const end = resolveEndpointFrom(row({ provider: 'ollama' }));
    expect(end?.baseUrl).toBe(PRESETS.ollama.defaultBaseUrl);
    expect(end?.apiKey).toBeNull();
  });
});

describe('keyHint', () => {
  it('reveals the last four characters and nothing else', () => {
    // This is the only part of a stored key that ever reaches the browser.
    expect(keyHint('sk-ant-secret-ab12')).toBe('…ab12');
  });

  it('has no hint for an absent key', () => {
    expect(keyHint('')).toBeNull();
    expect(keyHint('   ')).toBeNull();
  });
});
