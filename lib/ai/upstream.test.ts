import { describe, expect, it } from 'vitest';
import { causeChain, classify, short } from './upstream';

describe('short', () => {
  it('pulls the message out of a provider error envelope', () => {
    const raw = '400 {"type":"error","error":{"type":"invalid_request","message":"model: not found"}}';
    expect(short(raw)).toBe('model: not found');
  });

  it('reads a bare top-level message too', () => {
    expect(short('{"message":"model is required"}')).toBe('model is required');
  });

  // A truncated body must not throw away the text it does have.
  it('falls back to the raw text when the body is not parseable JSON', () => {
    expect(short('  502 Bad\n  Gateway {oops ')).toBe('502 Bad Gateway {oops');
  });

  // Pointing a base URL at a normal website is a common mistake; the reply is
  // an HTML page, and quoting it at the user explains nothing.
  it('says nothing at all when the body is an HTML page', () => {
    expect(short('<!doctype html><html><head><title>Example</title>')).toBe('');
  });

  it('caps the line at 200 characters', () => {
    expect(short('x'.repeat(500))).toHaveLength(200);
  });
});

describe('classify', () => {
  it('reads 401 and 403 as the key', () => {
    expect(classify(401, 'nope').reason).toBe('auth');
    expect(classify(403, 'nope').reason).toBe('auth');
  });

  // No status at all means the request never reached a server — the wrong port
  // on a local model server, which is the most common Ollama mistake.
  it('reads a missing status as unreachable', () => {
    expect(classify(undefined, 'ECONNREFUSED').reason).toBe('unreachable');
  });

  it('reads 404, and a 400 that mentions the model, as the model name', () => {
    expect(classify(404, 'not found').reason).toBe('model');
    expect(classify(400, 'unknown model glm-9').reason).toBe('model');
  });

  // A 400 about something else is not a model problem, and saying so would
  // send the user to re-type a name that was fine.
  it('leaves an unrelated 400 as a generic error, carrying the status', () => {
    const v = classify(400, 'missing field');
    expect(v.reason).toBe('error');
    expect(v.detail).toBe('400 · missing field');
  });
});

describe('causeChain', () => {
  // The SDK says "Request timed out."; the reason it timed out is one level down.
  it('carries the reason underneath the message', () => {
    const err = new Error('Request timed out.', {
      cause: new Error('fetch failed', { cause: new Error('ConnectTimeoutError') }),
    });
    expect(causeChain(err)).toBe('Request timed out. ← fetch failed ← ConnectTimeoutError');
  });

  it('says something for a value that is not an error at all', () => {
    expect(causeChain('boom')).toBe('boom');
    expect(causeChain(null)).toBe('unknown error');
  });
});
