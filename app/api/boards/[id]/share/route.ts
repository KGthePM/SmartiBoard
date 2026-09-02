import { NextResponse } from 'next/server';
import { networkInterfaces } from 'node:os';
import { guardManage } from '@/lib/access';
import { boardExists } from '@/lib/db';
import { mintShare, revokeShare, shareFor } from '@/lib/hub';
import { shareUrl } from '@/lib/share';

export const runtime = 'nodejs';

/**
 * Sharing one board on the network (v4.1).
 *
 * **`guardManage` on all three methods: a guest can never mint a link to the
 * board they were let into.** A share is the install's to hand out, not the
 * board's to propagate — otherwise the first person you invited could invite the
 * rest of the network, and revoking would mean chasing a tree.
 *
 * Nothing here is persisted. `lib/hub.ts` holds the token in process memory and
 * it dies with the process, which is v2.5's ruling — a network decision belongs
 * to the invocation, not the install — applied to the capability as well. So
 * closing the app is the revocation story, and there is no table, no column and
 * no migration in this release.
 */

/**
 * Every address this machine answers on, not a guess at the right one.
 *
 * `start.sh` prints the *first* non-internal IPv4, which on a machine running
 * Docker, a VM bridge or a VPN is the wrong one — and the person looking at the
 * dialog is the only one who knows which of their addresses their teammate can
 * reach. So the dialog gets the whole list and they pick.
 *
 * A tailnet address (100.64.0.0/10) is labelled, because "works from anywhere
 * your teammates are" and "this network only" are different promises.
 */
function addresses(): { label: string; address: string }[] {
  const out: { label: string; address: string }[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family !== 'IPv4' || n.internal) continue;
      const octets = n.address.split('.').map(Number);
      const tailnet = octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
      out.push({
        label: tailnet ? `${name} — Tailscale, works from anywhere your teammates are` : name,
        address: n.address,
      });
    }
  }
  return out;
}

/**
 * The state of the share, plus everything the dialog needs to render itself.
 *
 * `gated` is the honest half: under `./start.sh --lan` every caller is already
 * `trusted`, so the token puts a guest on the right board but is not a boundary,
 * and the dialog says so rather than implying a protection that is not there.
 */
function state(req: Request, boardId: string) {
  const token = shareFor(boardId);
  const port = new URL(req.url).port || '3000';
  return NextResponse.json({
    sharing: token !== null,
    token,
    gated: (process.env.SMARTI_TRUST_LAN ?? '').trim() === '',
    urls: token
      ? addresses().map((a) => ({
          label: a.label,
          url: shareUrl(`http://${a.address}:${port}`, boardId, token),
        }))
      : [],
  });
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const denied = guardManage(req);
  if (denied) return denied;

  return state(req, id);
}

/**
 * Start sharing. Idempotent, because `mintShare` is: reopening the dialog must
 * not invalidate a link somebody is already holding. Re-minting is DELETE then
 * POST, which is two deliberate presses.
 *
 * A board that does not exist is not shareable — otherwise a typo would mint a
 * live token for nothing, and the dialog would show a link that opens an empty
 * board someone else could later be given that id.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const denied = guardManage(req);
  if (denied) return denied;

  if (!boardExists(id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  mintShare(id);
  return state(req, id);
}

/** Stop sharing. The link is dead at once; there is nothing to expire. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const denied = guardManage(req);
  if (denied) return denied;

  revokeShare(id);
  return state(req, id);
}
