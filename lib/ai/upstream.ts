/**
 * How an upstream failure becomes words a person can act on.
 *
 * Shared by the two user-invoked settings calls — the connection test and the
 * model listing — because they fail in exactly the same ways and should say
 * exactly the same things about it, and by the two AI routes for the log line
 * they write on the way to failing quietly. Pure and node-free: no key ever
 * passes through here, only a status, a body snippet, or an error's own words.
 */

export type UpstreamReason = 'no_config' | 'auth' | 'unreachable' | 'model' | 'error';

/**
 * One line, never the key. Providers wrap the useful sentence in a JSON error
 * envelope (and the SDK prefixes it with the status), so dig the message out
 * when there is one — "API key is invalid" is worth showing, the envelope isn't.
 */
export function short(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  // A base URL that points at an ordinary website answers with a page, not an
  // error message. Two hundred characters of markup explains nothing, so say
  // nothing and let the reason carry the meaning.
  if (flat.startsWith('<')) return '';
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
export function classify(
  status: number | undefined,
  detail: string,
): { reason: UpstreamReason; detail: string } {
  if (status === undefined) return { reason: 'unreachable', detail };
  if (status === 401 || status === 403) return { reason: 'auth', detail };
  if (status === 404 || (status === 400 && /model/i.test(detail))) {
    return { reason: 'model', detail };
  }
  return { reason: 'error', detail: `${status} · ${detail}` };
}


/**
 * An error and everything under it, for the server log.
 *
 * The interesting half of a connection failure is never the top message: the
 * SDK reports `Request timed out.` and the fetch layer keeps the reason why in
 * `cause`. Depth-capped because cause chains can loop, and message-only because
 * a stack trace in a log line about someone's provider being unreachable helps
 * nobody.
 */
export function causeChain(err: unknown, depth = 4): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < depth && cur != null; i += 1) {
    const message = cur instanceof Error ? cur.message : String(cur);
    if (message) parts.push(message);
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return parts.join(' ← ') || 'unknown error';
}
