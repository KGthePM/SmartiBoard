import { NextResponse } from 'next/server';
import { guardBoard } from '@/lib/access';
import { loadBoard, saveBoard } from '@/lib/db';
import { currentSeq, publish, subscribe, type Frame, type Outgoing } from '@/lib/hub';
import { applyOps } from '@/lib/sync';

export const runtime = 'nodejs';

/**
 * How many ops one batch may carry, and how many bytes. The canvas sends a
 * debounce window's worth of edits — a handful, or a marquee-drag's worth of
 * cards — so these are far above anything real and exist only so a misbehaving
 * peer costs a 4xx rather than memory.
 */
const MAX_OPS = 2000;
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * A frame down the idle stream, often enough that a proxy does not decide the
 * connection is dead. It is also how a dead *subscriber* is noticed: the write
 * throws and lib/hub.ts drops it.
 */
const PING_MS = 25_000;

/**
 * The canvas's write path (v3.6): "here is what changed", not "here is the
 * whole board". See lib/sync.ts for why the node is the unit of merge.
 *
 * Load, apply, save. better-sqlite3 is synchronous and this is one process, so
 * the three happen inside a single handler tick and cannot interleave with
 * another request — arrival order at one process *is* the total order, which is
 * what buys a merge with no revision clock and no board-schema change.
 *
 * `PUT /api/boards/[id]` is deliberately untouched: import, hand-editing and
 * whole-board writes still need a full replace, and it is the honest fallback.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // Before the body is even read: a batch we will not apply is not worth the
  // bytes, and a stranger must not be able to size our limits.
  const denied = guardBoard(req, id);
  if (denied) return denied;

  const text = await req.text();
  if (text.length > MAX_BYTES) {
    return NextResponse.json({ error: 'batch too large' }, { status: 413 });
  }

  let body: { clientId?: unknown; ops?: unknown; ghost?: unknown };
  try {
    body = JSON.parse(text) as { clientId?: unknown; ops?: unknown; ghost?: unknown };
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  if (!Array.isArray(body.ops)) {
    return NextResponse.json({ error: 'ops must be an array' }, { status: 400 });
  }
  if (body.ops.length > MAX_OPS) {
    return NextResponse.json({ error: 'batch too large' }, { status: 413 });
  }

  // Which tab this is. Not trusted with anything — it is only the key each
  // client uses to know which frame is its own echo.
  const clientId = typeof body.clientId === 'string' ? body.clientId : '';
  const ghost = parseGhost(body.ghost, clientId);

  // An empty batch is a no-op, not an error, and must not churn `updated_at`:
  // the client already skips these, but a retry can race one to zero. A ghost
  // event is the one thing that can arrive alone — a dismissal changes nothing
  // on the board — and it still has a room to reach.
  if (body.ops.length === 0) {
    const seq = ghost ? publish(id, ghost) : 0;
    return NextResponse.json({ ok: true, updatedAt: loadBoard(id).updatedAt, seq });
  }

  // Individual ops are never rejected — applyOps drops what it cannot read and
  // lands the rest, the way parseBoard drops a malformed node. A bad op costs
  // that change; it does not cost the batch.
  const board = applyOps(loadBoard(id), body.ops);
  board.updatedAt = Date.now();
  saveBoard(board);

  // Broadcast the ops **as received, not as applied**: every receiver runs them
  // back through applyOps, which is total, so an op the server dropped is
  // dropped identically everywhere. One serialization path, not two.
  const seq = publish(id, { type: 'ops', clientId, ops: body.ops });
  // After the ops, always. Accepting a ghost *is* accompanied by ops, and
  // sending both in one request is what makes it impossible for a client to see
  // "the ghost is gone" before "the node arrived", or the reverse.
  if (ghost) publish(id, ghost);

  return NextResponse.json({ ok: true, updatedAt: board.updatedAt, seq });
}

/**
 * The room, as a stream (v4.0). v3.6 stopped two tabs destroying each other's
 * work; this is what tells the second tab that the first one changed something.
 *
 * Same idiom as the ideas route: a ReadableStream, a `send` behind an `open`
 * flag, and a teardown on both disconnect paths. Two differences, both because
 * this stream is idle by design rather than bounded by one model call — it
 * opens with the whole board rather than nothing, and it needs a heartbeat.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // Before the stream is built: `hello` carries the whole stored board, so an
  // ungated subscribe would be the loudest possible read of somebody's work.
  const denied = guardBoard(req, id);
  if (denied) return denied;

  const encoder = new TextEncoder();

  let unsubscribe: (() => void) | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;

  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (frame: Frame) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        } catch {
          open = false;
        }
      };

      const close = () => {
        open = false;
        unsubscribe?.();
        unsubscribe = null;
        if (ping) clearInterval(ping);
        ping = null;
        try {
          controller.close();
        } catch {
          // Already gone with the connection that caused this.
        }
      };
      req.signal.addEventListener('abort', close);

      // The whole board, up front. This is what makes a reconnect a resync: a
      // client that was offline catches up by being told where things stand,
      // not by replaying a log the hub would then have to keep.
      send({ type: 'hello', seq: currentSeq(id), board: loadBoard(id) });

      unsubscribe = subscribe(id, send);
      ping = setInterval(() => send({ type: 'ping', seq: currentSeq(id) }), PING_MS);
      (ping as { unref?: () => void }).unref?.();
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = null;
      if (ping) clearInterval(ping);
      ping = null;
    },
  });

  return new Response(source, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
    },
  });
}

/**
 * The ghost's lifecycle, riding the save that accompanies it. Ops alone retire
 * nobody's ghost: if one person accepts, the diff builds their node on every
 * screen, but everyone else's `proposal` is still sitting there.
 */
function parseGhost(raw: unknown, clientId: string): Outgoing | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const g = raw as Record<string, unknown>;
  if (g.phase !== 'accepted' && g.phase !== 'dismissed') return null;
  if (typeof g.proposalId !== 'string') return null;
  return {
    type: 'ghost',
    clientId,
    phase: g.phase,
    proposalId: g.proposalId,
    text: typeof g.text === 'string' ? g.text : '',
  };
}
