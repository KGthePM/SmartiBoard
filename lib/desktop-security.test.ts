import { describe, expect, it } from 'vitest';
import { authorizeDesktopRequest } from './desktop-security';

describe('authorizeDesktopRequest', () => {
  it('leaves the ordinary web server open when desktop mode is absent', () => {
    expect(
      authorizeDesktopRequest({
        suppliedToken: null,
        suppliedHost: 'localhost:3000',
      }),
    ).toBe(true);
  });

  it('requires both the per-run token and exact loopback host', () => {
    const base = {
      requiredToken: 'secret',
      requiredHost: '127.0.0.1:43111',
    };
    expect(
      authorizeDesktopRequest({
        ...base,
        suppliedToken: 'secret',
        suppliedHost: '127.0.0.1:43111',
      }),
    ).toBe(true);
    expect(
      authorizeDesktopRequest({
        ...base,
        suppliedToken: 'wrong',
        suppliedHost: '127.0.0.1:43111',
      }),
    ).toBe(false);
    expect(
      authorizeDesktopRequest({
        ...base,
        suppliedToken: 'secret',
        suppliedHost: 'localhost:43111',
      }),
    ).toBe(false);
  });
});
