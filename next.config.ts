import type { NextConfig } from 'next';

const config: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],

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
    '*.local',
  ],
};

export default config;
