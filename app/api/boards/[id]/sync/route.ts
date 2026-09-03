import { NextResponse } from 'next/server';
import { guardBoard } from '@/lib/access';
import { boardExists, loadBoard, saveBoard } from '@/lib/db';
import { currentSeq, framesSince, publish, subscribe, type Frame, type Outgoing } from '@/lib/hub';
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
 * How long a long poll waits before answering with nothing (v4.2).
 *
 * Under the stream's heartbeat, so a client that fell back to polling still
 * hears from the room about as often as one that did not. It is also the ceiling
 * on how long a request sits open, which is what makes an abandoned poll cost a
 * timeout rather than a held connection.
 */
const LONGPOLL_MS = 20_000;

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
 * The room, as a stream (v4.0), or as a long poll (v4.2).
 *
 * v3.6 stopped two tabs destroying each other's work; this is what tells the
 * second tab that the first one changed something.
 *
 * The stream is the ideas route's idiom: a ReadableStream, a `send` behind an
 * `open` flag, and a teardown on both disconnect paths. Two differences, both
 * because this stream is idle by design rather than bounded by one model call —
 * it opens with the whole board rather than nothing, and it needs a heartbeat.
 *
 * **`?since=` asks the same question one answer at a time, and exists because
 * not every path a share can take will carry a stream.** A Cloudflare quick
 * tunnel — v4.2's second tier — buffers a response body until it *ends*, which
 * is measurable and total: frames 1.5s apart arrive together after a minute,
 * and no content-type, padding, compression setting or HTTP version changes it.
 * A request that ends is delivered at once (~40ms on a warm connection), so the
 * fix is not to make the stream survive but to stop needing one.
 *
 * It is a fallback rather than a replacement: the client only asks this way
 * after a stream has opened and delivered nothing, so loopback and LAN keep the
 * transport they shipped with, and the room, the frames and `handle()` on the
 * other side are the same for both. One serialization path, two deliveries.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // Before either transport is built: `hello` carries the whole stored board, so
  // an ungated subscribe would be the loudest possible read of somebody's work.
  const denied = guardBoard(req, id);
  if (denied) return denied;

  // `hello` carries the stored board as the room's truth, and `loadBoard`
  // degrades a missing row to an empty board — right for a canvas, wrong here:
  // broadcast, that blank would diff a subscriber's view of the board away.
  // The same sentence as the guard's, so an id's absence stays unreadable.
  if (!boardExists(id)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const since = new URL(req.url).searchParams.get('since');
  if (since !== null) return longPoll(req, id, Number(since));

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

/**
 * One turn of the poll: what has happened since `seq`, waiting if nothing has.
 *
 * The three answers are the hub's three, unchanged — `null` from `framesSince`
 * means the log cannot account for the gap, and the honest reply to that is the
 * whole board, exactly as a reconnecting stream is answered. A client with
 * nothing yet says `since=-1` and gets the same, which is how a poll starts.
 */
async function longPoll(req: Request, id: string, seq: number): Promise<Response> {
  const hello = () =>
    NextResponse.json({
      frames: [{ type: 'hello', seq: currentSeq(id), board: loadBoard(id) }] as Frame[],
    });

  // A client with nothing yet. There is no room to join to answer this, and
  // nothing it could have missed.
  if (!Number.isFinite(seq) || seq < 0) return hello();

  /**
   * **Subscribed before anything is decided, and the order is load-bearing.**
   * Joining first creates the room, which does two things: a frame published
   * while we are deciding lands in the log rather than between the check and
   * the wait, and — with the hub's grace — a room is left behind for the *next*
   * poll to resume from. Without it a lone poller finds no room every time, is
   * told `null`, and is answered with the whole board on a loop.
   */
  const waiting = waitForFrames(req, id);

  const missed = framesSince(id, seq);
  if (missed !== null && missed.length === 0) {
    return NextResponse.json({ frames: await waiting.frames });
  }

  // Nothing to wait for: either we owe a resync or we already have the answer.
  // A frame that arrives in this instant is in the log too, so the next poll
  // collects it rather than losing it.
  waiting.cancel();
  return missed === null ? hello() : NextResponse.json({ frames: missed });
}

/**
 * Hold the request until the room says something, then answer with everything
 * it said. An empty array is a complete answer — it is this transport's
 * heartbeat, and the client's cue to ask again.
 *
 * **The batch is flushed a tick after the first frame rather than immediately**,
 * because a single POST can publish two (the ops, then the ghost frame riding
 * the same request), and v4.0's rule is that no client may see "the ghost is
 * gone" before "the node arrived". Splitting them across two round trips would
 * be exactly that, reintroduced by the transport.
 */
function waitForFrames(req: Request, id: string): { frames: Promise<Frame[]>; cancel: () => void } {
  const batch: Frame[] = [];
  let done = false;
  let flush: ReturnType<typeof setTimeout> | null = null;
  let finish = () => {};

  const frames = new Promise<Frame[]>((resolve) => {
    finish = () => {
      if (done) return;
      done = true;
      clearTimeout(idle);
      if (flush) clearTimeout(flush);
      req.signal.removeEventListener('abort', finish);
      unsubscribe();
      resolve(batch);
    };

    const unsubscribe = subscribe(id, (frame) => {
      batch.push(frame);
      if (!flush) flush = setTimeout(finish, 0);
    });

    const idle = setTimeout(finish, LONGPOLL_MS);
    // A poll nobody is waiting on must never be the reason a process stays up.
    (idle as { unref?: () => void }).unref?.();

    if (req.signal.aborted) finish();
    else req.signal.addEventListener('abort', finish);
  });

  return { frames, cancel: () => finish() };
}
