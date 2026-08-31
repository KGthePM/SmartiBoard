/**
 * Provider presets for bring-your-own-key AI. Two wire flavors exist —
 * 'anthropic' (the SDK, with its structured output and adaptive thinking) and
 * 'openai' (plain OpenAI-compatible chat completions over fetch, which is what
 * z.ai, Ollama, LM Studio, vLLM, OpenRouter… all speak). A preset is data on
 * top of a flavor, so adding a provider is a line here and nothing anywhere
 * else. Third parties can also speak the anthropic flavor to an
 * Anthropic-compatible endpoint — z.ai's Coding Plan does.
 *
 * This module is deliberately pure and node-free: the settings UI imports the
 * presets for labels and placeholders, and the tests import the resolution
 * logic. The db-backed entry point lives in lib/ai/config.ts.
 */

import type { ThemeId } from '../theme';
import type { CollapseMode } from '../collapse';

export type ProviderId = 'anthropic' | 'zai' | 'zai-coding' | 'ollama' | 'custom';

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
    // The subscription flavor of z.ai: a Coding Plan key has no balance on the
    // general API above and is only entitled to the Anthropic-compatible
    // coding endpoint that coding tools speak.
    id: 'zai-coding',
    label: 'z.ai Coding Plan (GLM)',
    flavor: 'anthropic',
    needsKey: true,
    defaultBaseUrl: 'https://api.z.ai/api/anthropic',
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
  /**
   * The ghost's settle window (v2.1) — a GHOST_DELAY_STEPS_MS rung or
   * GHOST_DELAY_OFF. Install-level like the rest of the row: a preference
   * about how the AI behaves, not content of any board. Not part of model
   * resolution; the client-side suggest loop is the only reader.
   */
  ghostDelayMs: number;
  /**
   * The board's appearance (v2.2). Install-level like the rest of the row and
   * purely presentational: it reaches CSS and nothing else — not the graph,
   * not the fingerprint, not any prompt, and no part of model resolution.
   */
  theme: ThemeId;
  /**
   * What a done card does with its space (v2.8, three-way since v2.9).
   * Install-level like the theme and just as inert: it reaches the canvas and
   * nothing else — not the graph, not the fingerprint, not any prompt, and no
   * part of model resolution.
   */
  collapseMode: CollapseMode;
};

/** A resolved, ready-to-call configuration — blanks filled from the preset. */
export type LlmConfig = {
  provider: ProviderId;
  flavor: Flavor;
  apiKey: string | null;
  baseUrl: string;
  model: string;
};

/** Everything needed to *reach* a provider, minus the model choice. Listing
 *  the available models is the one call that must work before a model has
 *  been picked, so it cannot go through the model-aware resolver below. */
export type LlmEndpoint = {
  provider: ProviderId;
  flavor: Flavor;
  apiKey: string | null;
  baseUrl: string;
};

/**
 * The reachability half of the config: who to talk to and with what
 * credentials. Blanks fill from the preset; a preset that needs a key is
 * unconfigured without one, and the openai flavor always needs a concrete
 * endpoint (the anthropic SDK supplies its own).
 */
export function resolveEndpointFrom(stored: StoredSettings): LlmEndpoint | null {
  const preset = PRESETS[stored.provider];
  const apiKey = stored.apiKey.trim() || null;
  const baseUrl = stored.baseUrl.trim() || preset.defaultBaseUrl;
  if (preset.needsKey && !apiKey) return null;
  if (preset.flavor === 'openai' && !baseUrl) return null;
  return { provider: preset.id, flavor: preset.flavor, apiKey, baseUrl };
}

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
    const endpoint = resolveEndpointFrom(stored);
    if (!endpoint) return null;
    // custom supplies its model by hand; presets supply a default.
    const model = stored.model.trim() || PRESETS[stored.provider].defaultModel;
    if (!model) return null;
    return { ...endpoint, model };
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
