/**
 * Provider presets for bring-your-own-key AI. Two wire flavors exist —
 * 'anthropic' (the SDK, with its structured output and adaptive thinking) and
 * 'openai' (plain OpenAI-compatible chat completions over fetch, which is what
 * z.ai, Ollama, LM Studio, vLLM, OpenRouter… all speak). A preset is data on
 * top of a flavor, so adding a provider is a line here and nothing anywhere else.
 *
 * This module is deliberately pure and node-free: the settings UI imports the
 * presets for labels and placeholders, and the tests import the resolution
 * logic. The db-backed entry point lives in lib/ai/config.ts.
 */

export type ProviderId = 'anthropic' | 'zai' | 'ollama' | 'custom';

/** How the provider is talked to on the wire. */
export type Flavor = 'anthropic' | 'openai';

export type Preset = {
  id: ProviderId;
  label: string;
  flavor: Flavor;
  /** A preset that needs a key is unconfigured until one is saved. */
  needsKey: boolean;
  /** '' for the anthropic flavor means "the SDK default endpoint". */
  defaultBaseUrl: string;
  defaultModel: string;
};

export const PROVIDERS: Preset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    flavor: 'anthropic',
    needsKey: true,
    defaultBaseUrl: '',
    defaultModel: 'claude-opus-5',
  },
  {
    id: 'zai',
    label: 'z.ai (GLM)',
    flavor: 'openai',
    needsKey: true,
    defaultBaseUrl: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-4.6',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    flavor: 'openai',
    needsKey: false,
    defaultBaseUrl: 'http://localhost:11434/v1',
    defaultModel: 'qwen3:8b',
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    flavor: 'openai',
    needsKey: false,
    defaultBaseUrl: '',
    defaultModel: '',
  },
];

export const PRESETS: Record<ProviderId, Preset> = Object.fromEntries(
  PROVIDERS.map((p) => [p.id, p]),
) as Record<ProviderId, Preset>;

/** One row of the settings table. Empty strings mean "not set". */
export type StoredSettings = {
  provider: ProviderId;
  apiKey: string;
  baseUrl: string;
  model: string;
};

/** A resolved, ready-to-call configuration — blanks filled from the preset. */
export type LlmConfig = {
  provider: ProviderId;
  flavor: Flavor;
  apiKey: string | null;
  baseUrl: string;
  model: string;
};

/**
 * Settings row first, env var fallback second, null when neither configures
 * anything. A saved row is authoritative for its provider: someone who chose
 * Ollama must not be silently rescued onto an Anthropic env key, so the env is
 * only consulted when no row exists.
 */
export function resolveConfigFrom(
  stored: StoredSettings | null,
  envKey: string | undefined,
): LlmConfig | null {
  if (stored) {
    const preset = PRESETS[stored.provider];
    const apiKey = stored.apiKey.trim() || null;
    const baseUrl = stored.baseUrl.trim() || preset.defaultBaseUrl;
    const model = stored.model.trim() || preset.defaultModel;
    if (preset.needsKey && !apiKey) return null;
    // The openai flavor always needs a concrete endpoint and model; custom
    // supplies both by hand, presets supply defaults.
    if (preset.flavor === 'openai' && (!baseUrl || !model)) return null;
    if (!model) return null;
    return { provider: preset.id, flavor: preset.flavor, apiKey, baseUrl, model };
  }

  if (envKey) {
    return {
      provider: 'anthropic',
      flavor: 'anthropic',
      apiKey: envKey,
      baseUrl: '',
      model: PRESETS.anthropic.defaultModel,
    };
  }

  return null;
}

/** What the settings API may reveal about a stored key: that it exists, plus a hint. */
export function keyHint(apiKey: string): string | null {
  const key = apiKey.trim();
  if (!key) return null;
  return `…${key.slice(-4)}`;
}
