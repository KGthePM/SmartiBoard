/**
 * The OpenAI-compatible wire flavor: plain fetch against /chat/completions.
 * One small client covers z.ai, Ollama, LM Studio, vLLM, OpenRouter — anything
 * that speaks the chat-completions protocol.
 *
 * Two things it deliberately does not try to do:
 *  - No provider-specific branches. Quirks (like GLM's separate
 *    `reasoning_content` deltas) are handled by ignoring anything that isn't
 *    `choices[0].delta.content` — the summary wants the answer, not the
 *    thinking, and the ghost wants JSON.
 *  - No retry/auth-refresh logic. Failures surface as exceptions and the
 *    routes already translate those into their silent-failure reasons.
 */

/**
 * A non-2xx reply from the endpoint. Carries the status and a short snippet of
 * the body so the settings connection test can tell "wrong key" from "no such
 * model" — the two mistakes people actually make. Never carries the key.
 */
export class OpenAiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`chat completions ${status}`);
    this.name = 'OpenAiError';
  }
}

/** Body text, trimmed to something a UI line can hold. */
async function snippet(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  return body.replace(/\s+/g, ' ').trim().slice(0, 200);
}

export type OpenAiConfig = {
  apiKey: string | null;
  baseUrl: string;
  model: string;
};

export type ChatRequest = {
  system: string;
  user: string;
  maxTokens: number;
  /** Ask for guaranteed-JSON output where the server supports it. */
  json?: boolean;
  signal?: AbortSignal;
};

function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

function buildRequest(cfg: OpenAiConfig, req: ChatRequest, stream: boolean): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // Ollama and friends are fine without it; some servers reject an empty one.
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  return new Request(endpoint(cfg.baseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      max_tokens: req.maxTokens,
      stream,
      ...(req.json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: req.signal,
  });
}

/** Non-streaming completion. Returns the message text, or null for an empty reply. */
export async function openaiComplete(cfg: OpenAiConfig, req: ChatRequest): Promise<string | null> {
  const res = await fetch(buildRequest(cfg, req, false));
  if (!res.ok) throw new OpenAiError(res.status, await snippet(res));

  const data = (await res.json()) as {
    choices?: { message?: { content?: unknown } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  return typeof content === 'string' && content.trim() ? content : null;
}

/** Streaming completion: yields text deltas as they arrive. */
export async function* openaiStreamDeltas(
  cfg: OpenAiConfig,
  req: ChatRequest,
): AsyncGenerator<string> {
  const res = await fetch(buildRequest(cfg, req, true));
  if (!res.ok) throw new OpenAiError(res.status, await snippet(res));
  if (!res.body) throw new OpenAiError(res.status, 'empty response body');

  for await (const line of sseDataLines(res.body)) {
    if (line === '[DONE]') return;
    let event: { choices?: { delta?: { content?: unknown } }[] };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const content = event.choices?.[0]?.delta?.content;
    if (typeof content === 'string' && content) yield content;
  }
}

/**
 * SSE `data:` lines from a byte stream. Exposed separately from the generator
 * above because line reassembly across chunk boundaries is where these parsers
 * break — this is the part worth testing directly.
 */
export async function* sseDataLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  // A reader rather than `for await`: async iteration over a ReadableStream is
  // not in the DOM lib, and this has to run on both the node and edge shapes.
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, i).replace(/\r$/, '');
      buffer = buffer.slice(i + 1);
      if (line.startsWith('data: ')) yield line.slice(6);
    }
  }
  buffer += decoder.decode();
  if (buffer.startsWith('data: ')) yield buffer.slice(6).replace(/\r$/, '');
}
