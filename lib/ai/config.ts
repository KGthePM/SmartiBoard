import { loadSettings } from '../db';
import { resolveConfigFrom, type LlmConfig } from './providers';

/**
 * The server-side entry into provider resolution: saved settings, then the
 * env-var fallback, then "not configured" — which is a valid state the routes
 * already handle. This file (not providers.ts) touches the database, so the
 * presets stay importable from the browser.
 */
export function resolveConfig(): LlmConfig | null {
  return resolveConfigFrom(loadSettings(), process.env.ANTHROPIC_API_KEY);
}
