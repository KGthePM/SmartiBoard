import { NextResponse } from 'next/server';
import { guardManage } from '@/lib/access';
import { startTunnel, stopTunnel, tunnelState } from '@/lib/tunnel';

export const runtime = 'nodejs';

/**
 * The tunnel (v4.2): one public address for this install.
 *
 * **Install-scoped, not board-scoped, and therefore `guardManage` on all three
 * methods.** The share route is per board because a token names a board; a
 * tunnel names a port, and the port carries the whole app. What keeps a guest to
 * one board is `lib/access.ts`, exactly as on the LAN — a bare tunnel URL with
 * no `#s=…` reaches nothing.
 *
 * `guardManage` already refuses every proxied request (rule 1 of `decideAccess`:
 * a caller carrying `CF-Connecting-IP` or `CF-Ray` is never `local` and never
 * `trusted`), which closes the recursion for free: **you cannot open a tunnel
 * through a tunnel**, and a guest cannot open one at all.
 *
 * Nothing here is persisted. `lib/tunnel.ts` holds the child process in memory
 * and kills it with this one, which is v2.5's ruling — a network decision
 * belongs to the invocation, not the install — applied a third time. So quitting
 * is how a tunnel is closed, and there is no setting, no column and no migration.
 */

/**
 * The port to forward, learned from the request rather than configured.
 *
 * The same trick `state()` in the share route uses: the server does not
 * otherwise know which port it was told to listen on, and the desktop assigns a
 * fresh one each launch.
 */
function port(req: Request): number {
  const fromUrl = new URL(req.url).port;
  return Number(fromUrl || process.env.PORT || '3000');
}

export async function GET(req: Request) {
  const denied = guardManage(req);
  if (denied) return denied;

  return NextResponse.json(tunnelState());
}

/**
 * Open it. Idempotent, because `startTunnel` is: a second press while one is
 * running hands back the running one, and a press while one is *starting* joins
 * that attempt rather than racing a second `cloudflared` onto the same port.
 */
export async function POST(req: Request) {
  const denied = guardManage(req);
  if (denied) return denied;

  return NextResponse.json(await startTunnel(port(req)));
}

/** Close it. The address is dead at once; there is nothing to expire. */
export async function DELETE(req: Request) {
  const denied = guardManage(req);
  if (denied) return denied;

  stopTunnel();
  return NextResponse.json(tunnelState());
}
