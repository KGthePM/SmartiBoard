/**
 * The tunnel: one public address for this install (v4.2).
 *
 * v4.1 made a board shareable with a link, but only to somebody who could
 * already reach the machine — the same Wi-Fi, or a tailnet. This is the second
 * tier: a `cloudflared` quick tunnel, which gives the install a public
 * `https://<random>.trycloudflare.com` address that a phone on cellular can
 * open. No account, no login, no DNS, no config.
 *
 * **A tunnel forwards bytes and holds nothing**, which is the whole reason one
 * is admitted here where a hosted service is not: lose Cloudflare and only reach
 * is lost. Nothing about the board leaves the host's SQLite file.
 *
 * **The tunnel is per install; the token is per board.** This module never hears
 * about a board — `app/api/tunnel/route.ts` is install-scoped behind
 * `guardManage`, and what keeps a guest to one board is `lib/access.ts`, exactly
 * as it does on the LAN. A bare tunnel URL with no `#s=…` reaches nothing.
 *
 * A sibling of `lib/hub.ts`, and pinned on `globalThis` for the same reason its
 * room map is: `next dev` reloads a route module on edit, and a fresh handle
 * there would orphan a live `cloudflared` process with no way to reach it again.
 * Unlike the hub this one spawns, so it is **not** node-free and could not live
 * there; the two halves worth testing (`parseTunnelUrl`, `resolveBinary`) are
 * pure and take their dependencies as arguments.
 *
 * Like the share registry, it **dies with the process**. v2.5's ruling that a
 * network decision belongs to the invocation rather than the install, applied
 * once more: nothing is persisted, and quitting is how a tunnel is closed.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * The two variables the lookup reads.
 *
 * Its own type rather than `NodeJS.ProcessEnv`, exactly as `AccessEnv` in
 * ./access is: it names what this module actually depends on, and a test can
 * build one without inventing a `NODE_ENV` that has nothing to do with it.
 */
export type TunnelEnv = { SMARTI_CLOUDFLARED?: string; PATH?: string };

/** What the dialog needs to draw the second tier, and nothing more. */
export type TunnelState = {
  /** A `cloudflared` binary was found. False greys the tier out. */
  available: boolean;
  running: boolean;
  url: string | null;
  /** One short sentence, or null. Shown as-is. */
  error: string | null;
};

/**
 * How long to wait for cloudflared to announce its hostname before giving up.
 *
 * Generous, because this is somebody else's edge assigning a name: a healthy
 * quick tunnel answers in about four seconds, and the ceiling is for a slow
 * network, not for a hang we should sit through in silence.
 */
export const TUNNEL_READY_MS = 20_000;

/**
 * The banner cloudflared prints is a box-drawing table, so the URL arrives
 * surrounded by `|` and padding, and a stream chunk can split it anywhere.
 *
 * Anchored to `trycloudflare.com` on purpose. The line *before* the banner says
 * "Requesting new quick Tunnel on trycloudflare.com..." with no scheme, so
 * requiring `https://` is what stops us reporting a hostname that is really a
 * progress message.
 */
const URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/;

/** The first tunnel hostname in a chunk of cloudflared's output, or null. */
export function parseTunnelUrl(chunk: string): string | null {
  return URL_RE.exec(chunk)?.[0] ?? null;
}

/**
 * Where the binary is, in order — and **never a download**.
 *
 * 1. `SMARTI_CLOUDFLARED`, an explicit path. This is also the seam
 *    `desktop/main.js` uses to hand over the copy `stage.js` bundled: the forked
 *    server runs as plain Node, where `process.resourcesPath` is undefined, so
 *    an env var is the only way the path can cross.
 * 2. `PATH`, scanned with `existsSync`. **A filesystem look, not a spawn** — the
 *    dialog asks for state every time it opens, and running somebody else's
 *    executable with `--version` to answer a question about whether a button is
 *    greyed out is the wrong trade.
 * 3. Nothing. The tier greys out with one sentence and no download prompt: an
 *    idea board does not fetch executables on a button press.
 *
 * Takes `exists` and `platform` as arguments so the order and the Windows file
 * name are both testable without a filesystem and without a Windows runner.
 */
export function resolveBinary(
  env: TunnelEnv,
  exists: (p: string) => boolean = existsSync,
  platform: string = process.platform,
): string | null {
  const explicit = (env.SMARTI_CLOUDFLARED ?? '').trim();
  if (explicit) return exists(explicit) ? explicit : null;

  const name = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/* ------------------------------------------------------------- the handle --- */

type Handle = {
  child: ChildProcess | null;
  url: string | null;
  error: string | null;
  /** In flight, so a double-click cannot open two tunnels. */
  starting: Promise<TunnelState> | null;
};

const store = globalThis as typeof globalThis & {
  __smartiTunnel?: Handle;
  __smartiTunnelHooks?: boolean;
  __smartiCloudflared?: string | null;
};

const handle: Handle = (store.__smartiTunnel ??= {
  child: null,
  url: null,
  error: null,
  starting: null,
});

/** Memoized on the same global: the answer cannot change without a restart. */
function binary(): string | null {
  if (store.__smartiCloudflared === undefined) {
    store.__smartiCloudflared = resolveBinary(process.env as TunnelEnv);
  }
  return store.__smartiCloudflared;
}

/**
 * Kill the tunnel with the process, however the process ends.
 *
 * `exit` alone is not enough: a SIGTERM with no handler terminates Node without
 * ever running it, and SIGTERM is exactly what `desktop/main.js` sends its
 * forked server on quit. Windows has no signals at all, which is why `main.js`
 * kills the whole tree there instead — this side cannot help on that platform.
 */
function installHooks(): void {
  if (store.__smartiTunnelHooks) return;
  store.__smartiTunnelHooks = true;
  process.on('exit', () => stopTunnel());
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      stopTunnel();
      process.exit(0);
    });
  }
}

export function tunnelState(): TunnelState {
  return {
    available: binary() !== null,
    running: handle.child !== null && handle.url !== null,
    url: handle.url,
    error: handle.error,
  };
}

/**
 * Open the tunnel, or hand back the one already open.
 *
 * **Idempotent, like `mintShare`:** a second press while one is running returns
 * the running state, and a press while one is *starting* joins that attempt
 * rather than racing a second `cloudflared` onto the same port.
 */
export async function startTunnel(port: number): Promise<TunnelState> {
  if (handle.child && handle.url) return tunnelState();
  if (handle.starting) return handle.starting;

  const bin = binary();
  if (!bin) {
    handle.error = null; // Not an error: the tier renders "not installed here".
    return tunnelState();
  }

  handle.starting = launch(bin, port).finally(() => {
    handle.starting = null;
  });
  return handle.starting;
}

function launch(bin: string, port: number): Promise<TunnelState> {
  return new Promise((resolve) => {
    installHooks();
    handle.error = null;
    handle.url = null;

    let child: ChildProcess;
    try {
      child = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      handle.error = 'Could not start cloudflared.';
      resolve(tunnelState());
      return;
    }
    handle.child = child;

    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(tunnelState());
    };

    const timer = setTimeout(() => {
      handle.error = 'The tunnel did not come up.';
      stopTunnel();
      done();
    }, TUNNEL_READY_MS);
    timer.unref?.();

    /**
     * cloudflared logs to stderr, but both are read: which stream carries the
     * banner is its choice to change, and reading one is a silent failure.
     *
     * The buffer exists because a chunk boundary can land inside the hostname.
     * It is capped rather than grown, since a tunnel that has not named itself
     * within a few kilobytes of chatter is not going to.
     */
    let buf = '';
    const onChunk = (d: Buffer) => {
      if (handle.url) return;
      buf = (buf + d.toString()).slice(-8192);
      const url = parseTunnelUrl(buf);
      if (url) {
        handle.url = url;
        done();
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    /**
     * A tunnel Cloudflare withdrew, or one that never started, must report as
     * stopped rather than leaving a dead link on screen — quick tunnels are not
     * a service with an uptime promise, and the dialog says so.
     */
    child.on('exit', () => {
      if (handle.child !== child) return;
      handle.child = null;
      if (!handle.url && !handle.error) handle.error = 'cloudflared stopped before it connected.';
      handle.url = null;
      done();
    });
    child.on('error', () => {
      if (handle.child !== child) return;
      handle.child = null;
      handle.url = null;
      handle.error = 'Could not start cloudflared.';
      done();
    });
  });
}

/** Close the tunnel. The address is dead at once; there is nothing to expire. */
export function stopTunnel(): void {
  const child = handle.child;
  handle.child = null;
  handle.url = null;
  handle.error = null;
  if (!child) return;
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}
