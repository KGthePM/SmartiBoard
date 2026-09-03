import { describe, expect, it } from 'vitest';
import { parseTunnelUrl, resolveBinary } from './tunnel';

/**
 * The two halves of `lib/tunnel.ts` that can be tested without running anybody
 * else's executable. The spawn itself is deliberately never exercised here — it
 * would make the suite depend on a binary, a network, and Cloudflare's edge.
 */

/** Real cloudflared output, kept verbatim: the banner is a box-drawing table. */
const BANNER = [
  '2026-09-02T22:23:32Z INF Requesting new quick Tunnel on trycloudflare.com...',
  '2026-09-02T22:23:36Z INF +--------------------------------------------------------+',
  '2026-09-02T22:23:36Z INF |  Your quick Tunnel has been created! Visit it at:       |',
  '2026-09-02T22:23:36Z INF |  https://genealogy-propecia-speak-crafts.trycloudflare.com  |',
  '2026-09-02T22:23:36Z INF +--------------------------------------------------------+',
].join('\n');

const URL = 'https://genealogy-propecia-speak-crafts.trycloudflare.com';

describe('parseTunnelUrl', () => {
  it('finds the hostname in the banner', () => {
    expect(parseTunnelUrl(BANNER)).toBe(URL);
  });

  it('ignores the schemeless mention that precedes it', () => {
    // The "Requesting new quick Tunnel on trycloudflare.com..." line arrives
    // seconds before the real one; reporting it would hand out a dead address.
    const first = BANNER.split('\n')[0];
    expect(parseTunnelUrl(first)).toBeNull();
  });

  it('finds nothing in a chunk that splits the hostname', () => {
    // Which is why the caller buffers rather than testing each chunk alone.
    const cut = BANNER.indexOf(URL) + 20;
    expect(parseTunnelUrl(BANNER.slice(0, cut))).toBeNull();
    expect(parseTunnelUrl(BANNER.slice(0, cut) + BANNER.slice(cut))).toBe(URL);
  });

  it('drops junk and lookalikes', () => {
    expect(parseTunnelUrl('')).toBeNull();
    expect(parseTunnelUrl('ERR failed to connect')).toBeNull();
    expect(parseTunnelUrl('http://plain.trycloudflare.com')).toBeNull();
    expect(parseTunnelUrl('https://evil.trycloudflare.com.attacker.test')).toBe(
      'https://evil.trycloudflare.com',
    );
  });
});

describe('resolveBinary', () => {
  const has =
    (...paths: string[]) =>
    (p: string) =>
      paths.includes(p);
  const none = () => false;

  it('prefers SMARTI_CLOUDFLARED over anything on PATH', () => {
    const env = { SMARTI_CLOUDFLARED: '/bundled/cloudflared', PATH: '/usr/bin' };
    expect(resolveBinary(env, has('/bundled/cloudflared', '/usr/bin/cloudflared'), 'linux')).toBe(
      '/bundled/cloudflared',
    );
  });

  it('refuses to fall back when an explicit path is wrong', () => {
    // A desktop build that staged nothing must grey the tier out, not quietly
    // run whatever the user happens to have installed.
    const env = { SMARTI_CLOUDFLARED: '/bundled/cloudflared', PATH: '/usr/bin' };
    expect(resolveBinary(env, has('/usr/bin/cloudflared'), 'linux')).toBeNull();
  });

  it('scans PATH in order', () => {
    const env = { PATH: '/a:/b:/c' };
    expect(resolveBinary(env, has('/b/cloudflared', '/c/cloudflared'), 'linux')).toBe(
      '/b/cloudflared',
    );
  });

  it('looks for cloudflared.exe on Windows', () => {
    // The directories are POSIX here because `node:path` is the host's, not the
    // target's; what this pins is the file *name*, which is the only part of the
    // lookup that varies by platform rather than by the machine running it.
    const env = { PATH: '/a' };
    expect(resolveBinary(env, has('/a/cloudflared.exe'), 'win32')).toBe('/a/cloudflared.exe');
    expect(resolveBinary(env, has('/a/cloudflared'), 'win32')).toBeNull();
    expect(resolveBinary(env, has('/a/cloudflared.exe'), 'linux')).toBeNull();
  });

  it('is null when there is nothing to find', () => {
    expect(resolveBinary({ PATH: '/a:/b' }, none, 'linux')).toBeNull();
    expect(resolveBinary({}, none, 'linux')).toBeNull();
    expect(resolveBinary({ PATH: '', SMARTI_CLOUDFLARED: '   ' }, none, 'linux')).toBeNull();
  });
});
