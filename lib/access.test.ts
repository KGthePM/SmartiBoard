import { describe, expect, it } from 'vitest';
import {
  canManage,
  canReachBoard,
  decideAccess,
  LOCAL_HEADER,
  SHARE_HEADER,
  type Access,
  type AccessEnv,
} from './access';

/** One board is shared; the other is not. The registry, small enough to read. */
const SHARED = 'board-a';
const OTHER = 'board-b';
const TOKEN = 'a-real-token';
const resolve = (t: string) => (t === TOKEN ? SHARED : null);

const h = (init: Record<string, string> = {}) => new Headers(init);

/** What a clone-and-run install has: nothing set, so `-H 127.0.0.1` stands. */
const LOOPBACK: AccessEnv = {};
/** `./start.sh --lan` — bound wide, and vouched for. */
const LAN: AccessEnv = { SMARTI_HOST: '0.0.0.0', SMARTI_TRUST_LAN: '1' };
/** The desktop: bound wide, not vouched for, holding a secret. */
const SECRET = 'per-run-secret';
const DESKTOP: AccessEnv = { HOSTNAME: '0.0.0.0', SMARTI_LOCAL_SECRET: SECRET };

const on = (headers: Headers, board: string | null, env: AccessEnv): Access =>
  decideAccess(headers, board, env, resolve);

describe('decideAccess: the default install', () => {
  // Rule 3. The operating system is the boundary, so no header is believed.
  it('is local with no headers at all, because nothing else can arrive', () => {
    expect(on(h(), SHARED, LOOPBACK)).toBe('local');
    expect(on(h(), null, LOOPBACK)).toBe('local');
  });

  it('is still local when SMARTI_HOST names loopback outright', () => {
    expect(on(h(), null, { SMARTI_HOST: '127.0.0.1' })).toBe('local');
  });

  it('reads an empty HOSTNAME as wide, since that is what standalone defaults to', () => {
    expect(on(h(), null, { HOSTNAME: '' })).toBe('denied');
    expect(on(h(), null, { HOSTNAME: '::' })).toBe('denied');
  });
});

describe('decideAccess: --lan preserves v2.5 bit-for-bit', () => {
  it('trusts every caller, with or without a token', () => {
    expect(on(h(), SHARED, LAN)).toBe('trusted');
    expect(on(h(), null, LAN)).toBe('trusted');
    expect(canManage(on(h(), null, LAN))).toBe(true);
  });
});

describe('decideAccess: the local secret', () => {
  // Rule 2 — the only proof of localness on a wide binding.
  it('is local for the window that holds the secret', () => {
    expect(on(h({ [LOCAL_HEADER]: SECRET }), SHARED, DESKTOP)).toBe('local');
  });

  it('is denied for a wrong secret, an absent one, or an empty one', () => {
    expect(on(h({ [LOCAL_HEADER]: 'guess' }), SHARED, DESKTOP)).toBe('denied');
    expect(on(h(), SHARED, DESKTOP)).toBe('denied');
    expect(on(h({ [LOCAL_HEADER]: '' }), SHARED, DESKTOP)).toBe('denied');
  });

  // Otherwise every caller would be local on every install that sets no secret,
  // which is all of them but one.
  it('never lets an unset secret match an absent header', () => {
    expect(on(h(), SHARED, { HOSTNAME: '0.0.0.0' })).toBe('denied');
    expect(on(h({ [LOCAL_HEADER]: '' }), SHARED, { HOSTNAME: '0.0.0.0' })).toBe('denied');
  });
});

describe('decideAccess: the share tier', () => {
  it('reaches the board its token names', () => {
    expect(on(h({ [SHARE_HEADER]: TOKEN }), SHARED, DESKTOP)).toEqual({ share: SHARED });
  });

  // The property the whole feature rests on.
  it('is a stranger on every other board', () => {
    expect(on(h({ [SHARE_HEADER]: TOKEN }), OTHER, DESKTOP)).toBe('denied');
  });

  it('reaches nothing that is about no board — the library, the settings', () => {
    expect(on(h({ [SHARE_HEADER]: TOKEN }), null, DESKTOP)).toBe('denied');
  });

  it('refuses a token nobody minted, or a revoked one', () => {
    expect(on(h({ [SHARE_HEADER]: 'stale' }), SHARED, DESKTOP)).toBe('denied');
    expect(on(h({ [SHARE_HEADER]: '' }), SHARED, DESKTOP)).toBe('denied');
  });
});

describe('decideAccess: the loopback trap', () => {
  /**
   * The assertion standing between a v4.2 tunnel and handing out the library.
   * cloudflared runs on the host and dials loopback, so a tunneled request would
   * otherwise arrive looking like the most trusted caller there is.
   */
  it('is never local and never trusted once a Cloudflare header is present', () => {
    const proxies: Record<string, string>[] = [
      { 'cf-connecting-ip': '203.0.113.7' },
      { 'cf-ray': 'abc-LHR' },
    ];
    for (const proxy of proxies) {
      // ...not even holding a valid local secret,
      expect(on(h({ ...proxy, [LOCAL_HEADER]: SECRET }), SHARED, DESKTOP)).toBe('denied');
      // ...not even on a loopback-bound server, where rule 3 would say local,
      expect(on(h(proxy), SHARED, LOOPBACK)).toBe('denied');
      // ...and not even under --lan, which trusts everyone else.
      expect(on(h(proxy), SHARED, LAN)).toBe('denied');
    }
  });

  it('still lets a tunneled request through to the one board it has a token for', () => {
    const headers = h({ 'cf-connecting-ip': '203.0.113.7', [SHARE_HEADER]: TOKEN });
    expect(on(headers, SHARED, LOOPBACK)).toEqual({ share: SHARED });
    expect(on(headers, OTHER, LOOPBACK)).toBe('denied');
  });
});

describe('canManage / canReachBoard: the refusal matrix a route asks for', () => {
  const guest = on(h({ [SHARE_HEADER]: TOKEN }), SHARED, DESKTOP);

  it('lets a guest reach its own board and nothing beside it', () => {
    expect(canReachBoard(guest, SHARED)).toBe(true);
    expect(canReachBoard(guest, OTHER)).toBe(false);
  });

  // The library list, ?full=1, /api/settings, PUT, PATCH, DELETE and minting a
  // share are all one question, asked once.
  it('never lets a guest manage the install', () => {
    expect(canManage(guest)).toBe(false);
  });

  it('refuses a denied caller everything', () => {
    expect(canManage('denied')).toBe(false);
    expect(canReachBoard('denied', SHARED)).toBe(false);
  });

  it('lets local and trusted through everywhere', () => {
    for (const a of ['local', 'trusted'] as const) {
      expect(canManage(a)).toBe(true);
      expect(canReachBoard(a, SHARED)).toBe(true);
      expect(canReachBoard(a, OTHER)).toBe(true);
    }
  });
});
