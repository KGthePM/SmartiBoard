import type { NextConfig } from 'next';

const config: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],

  // The desktop build (see desktop/) ships the Next server inside Electron, which means it
  // needs a self-contained server bundle rather than a node_modules tree — that is what
  // `standalone` emits. It is gated on an env var rather than set outright so that the
  // clone-and-run path stays exactly what it was: `npm run build` produces the same output
  // it always has, and only `SMARTI_DESKTOP=1 npm run build` produces the extra bundle.
  // `serverExternalPackages` above is what keeps better-sqlite3 out of the trace as a
  // require rather than a bundled module, which is what makes the standalone copy loadable
  // at all — do not remove it.
  ...(process.env.SMARTI_DESKTOP ? { output: 'standalone' as const } : {}),

  // `./start.sh --lan` binds the dev server to every interface so a phone or tablet on the
  // same network can open the board. Next 15 refuses cross-origin dev requests unless the
  // origin is listed here, so without this the LAN flag serves a page that cannot talk to
  // its own API. Only private ranges are allowed — the three RFC 1918 blocks and .local —
  // which is the same "a network you trust" the flag warns about, expressed in config.
  //
  // Unconditional on purpose: this affects `next dev` and nothing else, and a config that
  // differed between the run that binds and the run that doesn't would be a second thing
  // to get wrong.
  allowedDevOrigins: [
    '192.168.*.*',
    '10.*.*.*',
    '172.16.*.*', '172.17.*.*', '172.18.*.*', '172.19.*.*',
    '172.20.*.*', '172.21.*.*', '172.22.*.*', '172.23.*.*',
    '172.24.*.*', '172.25.*.*', '172.26.*.*', '172.27.*.*',
    '172.28.*.*', '172.29.*.*', '172.30.*.*', '172.31.*.*',
    // Tailscale hands out addresses from the CGNAT block 100.64.0.0/10, and
    // without these `next dev` over a tailnet serves a page that refuses its own
    // API calls — the same failure the RFC 1918 entries above exist to prevent.
    // Generated rather than written out: 64 more literal lines beside the 16
    // above would be a wall nobody re-reads, and `100.*.*.*` would over-match
    // public space the way `172.*.*.*` would have.
    ...Array.from({ length: 64 }, (_, i) => `100.${64 + i}.*.*`),
    '*.local',
  ],
};

export default config;
