/**
 * The room: in-process pub/sub for one board (v4.0).
 *
 * v3.6 made the canvas save *what changed* rather than the document, so two
 * tabs on one board stopped destroying each other's work — but neither tab was
 * told anything, and a teammate's edit sat in SQLite until a reload. This is
 * the piece that tells them.
 *
 * **No broker, and none is coming.** One process is already a given: `lib/db.ts`
 * holds a module-level connection and `sync/route.ts` leans on the same fact for
 * its merge — arrival order at a single process *is* the total order, which is
 * what buys a merge with no revision clock and no board-schema change. A room is
 * a `Set` of subscribers, a counter, and — since v4.2 — a short log of what it
 * last said, and that is the whole of it.
 *
 * The map is pinned on `globalThis` for the reason `lib/db.ts` keeps a module
 * singleton: `next dev` reloads a route module on edit, and a fresh `Map` there
 * would orphan every subscriber the old module was holding — streams still open,
 * receiving nothing, forever.
 *
 * **`seq` is ordering information, not a revision clock.** It is per room,
 * session-only, never persisted and never in the board JSON. A client uses it to
 * notice a gap; nothing merges by it.
 *
 * Server-only by construction (timers and a process-global), but node-free — no
 * `node:` import — so it tests directly under vitest's node environment.
 */

import type { Board } from './graph';
import type { ProposalDraft } from './proposal';
import type { Op } from './sync';

/**
 * How long one client may hold the room's ghost. Long enough for a slow model
 * (the suggest route's own bound is 60s, but that is the whole request; the
 * lease only has to outlive the *claim*), short enough that a tab which dies
 * mid-flight does not silence the room for a session.
 */
export const GHOST_LEASE_MS = 30_000;

/**
 * How many frames a room remembers (v4.2).
 *
 * The stream needs no memory — a subscriber is either connected or it is not.
 * The long poll does: it holds one request, is answered, and is *not* subscribed
 * during the few milliseconds it takes to ask again, so a frame published in
 * that gap would be lost with no way to notice. The log is what a returning
 * poller is caught up from.
 *
 * **Losing it is safe, which is why it is a plain capped array and not a
 * durable one.** `framesSince` answers `null` for anything it cannot serve —
 * a gap, a room that was swept, a seq from a previous process — and the route
 * answers a `null` with `hello`, the whole board. That is the same resync the
 * stream already performs on reconnect, so the log is an optimization over a
 * correct path rather than a mechanism of its own.
 */
const LOG_MAX = 256;

/**
 * How long a room outlives its last subscriber (v4.2).
 *
 * v4.0 could delete a room the moment the last subscriber left, because a
 * stream is subscribed for as long as it is open. A long poll is subscribed
 * only while it *waits*: between being answered and asking again it is not in
 * the room at all. Swept in that window, the room takes its log and its counter
 * with it, and the next poll is told `null`, resyncs the whole board, and finds
 * an empty room again — a full board per remote edit, forever.
 *
 * The grace is what makes the poll's absence a pause rather than a departure.
 * Generous, because an idle room is a `Set`, a number and at most LOG_MAX
 * frames, and because the cost of it being too short is paid on every edit.
 */
export const ROOM_GRACE_MS = 60_000;

/** A frame the hub is asked to send. `seq` is the hub's to assign. */
export type Outgoing =
  | { type: 'ops'; clientId: string; ops: Op[] }
  | {
      type: 'ghost';
      clientId: string;
      phase: 'proposed';
      proposalId: string;
      draft: ProposalDraft;
    }
  | {
      type: 'ghost';
      clientId: string;
      phase: 'accepted' | 'dismissed';
      proposalId: string;
      text: string;
    }
  /** Nobody's: the room's own announcement that a lease died undelivered. */
  | { type: 'ghost'; clientId: string; phase: 'released' };

/**
 * What goes down the wire. `hello` is the route's, not the hub's — it carries
 * the stored board on connect, so an offline client resyncs by reconnecting
 * rather than by replaying a log.
 */
export type Frame =
  | { type: 'hello'; seq: number; board: Board }
  | { type: 'ping'; seq: number }
  | (Outgoing & { seq: number });

type Lease = {
  clientId: string;
  /** The board the holder asked about, so its own retry renews rather than loses. */
  fingerprint: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
};

type Room = {
  subs: Set<(f: Frame) => void>;
  seq: number;
  lease: Lease | null;
  /** The last LOG_MAX frames published here, oldest first. See LOG_MAX. */
  log: Frame[];
  /** Counting down to deletion, having been left empty. See ROOM_GRACE_MS. */
  grace: ReturnType<typeof setTimeout> | null;
};

const store = globalThis as typeof globalThis & { __smartiRooms?: Map<string, Room> };
const rooms: Map<string, Room> = (store.__smartiRooms ??= new Map());

function room(boardId: string): Room {
  let r = rooms.get(boardId);
  if (!r) {
    r = { subs: new Set(), seq: 0, lease: null, log: [], grace: null };
    rooms.set(boardId, r);
  }
  return r;
}

/**
 * A room nobody is in and nothing is holding is not a room — after a grace.
 *
 * The delay is the whole of ROOM_GRACE_MS: emptiness is how a long poll looks
 * between two requests, so deleting on sight would throw away the log of a room
 * that is about to be rejoined. Anyone who does rejoin cancels the countdown in
 * `subscribe`; anyone who does not costs one timer.
 */
function sweep(boardId: string): void {
  const r = rooms.get(boardId);
  if (!r || r.subs.size > 0 || r.lease || r.grace) return;

  r.grace = setTimeout(() => {
    const still = rooms.get(boardId);
    if (!still) return;
    still.grace = null;
    if (still.subs.size === 0 && !still.lease) rooms.delete(boardId);
  }, ROOM_GRACE_MS);
  // An empty room must never be the reason a process stays alive.
  (r.grace as { unref?: () => void }).unref?.();
}

/**
 * Join a board's room. The returned function is the whole teardown — the route
 * calls it from `cancel()` and from its `finally`, and calling it twice is a
 * no-op, because a `Set` delete is.
 */
export function subscribe(boardId: string, send: (f: Frame) => void): () => void {
  const r = room(boardId);
  // Rejoined inside the grace: the room is not going anywhere after all.
  if (r.grace) {
    clearTimeout(r.grace);
    r.grace = null;
  }
  r.subs.add(send);
  return () => {
    r.subs.delete(send);
    sweep(boardId);
  };
}

/** Where the room's counter stands, for the `hello` frame. */
export function currentSeq(boardId: string): number {
  return rooms.get(boardId)?.seq ?? 0;
}

/**
 * What has happened since `seq`, or `null` for "I cannot tell you" (v4.2).
 *
 * The distinction is the whole contract: an empty array means *nothing has
 * happened* and the caller should wait, while `null` means the log cannot
 * account for the gap and the caller owes the client a `hello` instead. Three
 * ways to get `null`, and each is a real case rather than a defensive one:
 *
 * - **No room.** Swept while nobody was subscribed, which is exactly what
 *   happens between one long poll and the next when a board goes quiet.
 * - **`seq` ahead of ours.** A client from a previous process — the counter is
 *   session-only, so a restart begins again at zero and a held `seq` is
 *   meaningless rather than merely stale.
 * - **A gap.** More than LOG_MAX frames landed while the client was away.
 */
export function framesSince(boardId: string, seq: number): Frame[] | null {
  const r = rooms.get(boardId);
  if (!r || seq > r.seq) return null;
  if (seq === r.seq) return [];

  const oldest = r.log[0]?.seq;
  // Frames are missing between what the client holds and what we still have.
  if (oldest === undefined || seq < oldest - 1) return null;
  return r.log.filter((f) => f.seq > seq);
}

/**
 * Stamp a frame and hand it to everyone in the room, **including the client it
 * came from**. Echo suppression is a client-side rule (it drops frames carrying
 * its own `clientId`): the alternative is the hub knowing which subscriber
 * belongs to which client, which is bookkeeping that buys nothing and goes wrong
 * the first time one client holds two streams.
 *
 * A subscriber whose `send` throws is dropped rather than allowed to take the
 * publish down with it — a dead socket is not the other subscribers' problem.
 */
export function publish(boardId: string, frame: Outgoing): number {
  const r = rooms.get(boardId);
  // Nobody is listening. Creating a room here would leak one per POST on a
  // board nobody has open.
  if (!r) return 0;

  const seq = ++r.seq;
  const stamped = { ...frame, seq } as Frame;
  r.log.push(stamped);
  if (r.log.length > LOG_MAX) r.log.splice(0, r.log.length - LOG_MAX);
  for (const send of [...r.subs]) {
    try {
      send(stamped);
    } catch {
      r.subs.delete(send);
    }
  }
  return seq;
}

/**
 * Take the room's ghost, or find it taken.
 *
 * `shouldRequest` permits one live ghost per board, and it is a client-side
 * policy — so N clients watching one board fire N `/suggest` calls per change
 * and spend the host's key N times. This is the ceiling made server-side, and it
 * is a correctness requirement of live updates, not a feature beside them.
 *
 * The same client re-claiming the same board state **renews** rather than loses:
 * a retry after a response that never arrived must not be locked out by its own
 * previous attempt.
 */
export function claimGhost(
  boardId: string,
  clientId: string,
  fingerprint: string,
  now: number = Date.now(),
): boolean {
  const r = room(boardId);
  const live = r.lease && r.lease.expiresAt > now ? r.lease : null;
  if (live && !(live.clientId === clientId && live.fingerprint === fingerprint)) return false;
  if (r.lease) clearTimeout(r.lease.timer);

  const timer = setTimeout(() => expire(boardId, clientId), GHOST_LEASE_MS);
  // A pending lease must never be the reason a process stays alive.
  (timer as { unref?: () => void }).unref?.();
  r.lease = { clientId, fingerprint, expiresAt: now + GHOST_LEASE_MS, timer };
  return true;
}

/** Hand the ghost back. Only the holder can, so a late loser cannot free it. */
export function releaseGhost(boardId: string, clientId: string): void {
  const r = rooms.get(boardId);
  if (!r?.lease || r.lease.clientId !== clientId) return;
  clearTimeout(r.lease.timer);
  r.lease = null;
  sweep(boardId);
}

/**
 * A lease that ran out with nothing delivered — the winner's tab died between
 * the claim and the answer.
 *
 * This needs a real timer rather than a lazy check on the next claim, and that
 * is the whole subtlety of the lease: the losers stamped their fingerprint
 * *before* their POST, so they are blocked by `no_material_change` and will
 * never call again on their own. Without the announcement the room's ghost is
 * deadlocked until somebody happens to edit something.
 */
function expire(boardId: string, clientId: string): void {
  const r = rooms.get(boardId);
  if (!r?.lease || r.lease.clientId !== clientId) return;
  r.lease = null;
  publish(boardId, { type: 'ghost', clientId: '', phase: 'released' });
  sweep(boardId);
}

/** How many streams are open on a board. For tests and for nothing else. */
export function roomCount(boardId: string): number {
  return rooms.get(boardId)?.subs.size ?? 0;
}

/* ---------------------------------------------------------------- shares --- */

/**
 * The share registry (v4.1): which unguessable token reaches which board.
 *
 * **A sibling of `rooms`, deliberately not a field on `Room`.** `sweep` deletes a
 * room the moment nobody is subscribed and nothing is leased, so a token living
 * there would be revoked by the last person closing a tab — a share that dies
 * whenever the host looks away. Two maps, one predicate each.
 *
 * Pinned on `globalThis` for the reason the room map is: `next dev` reloads a
 * route module on edit, and a fresh `Map` there would silently invalidate every
 * link already sent.
 *
 * **It dies with the process, and that is the revocation story.** v2.5 ruled that
 * a network binding belongs to the invocation rather than the install and is
 * therefore never persisted; a capability over that binding is the same kind of
 * thing. So there is no column, no table and no migration — closing the app ends
 * every share, and the dialog says so.
 */
const shareStore = globalThis as typeof globalThis & {
  __smartiShareByBoard?: Map<string, string>;
  __smartiBoardByShare?: Map<string, string>;
};
const shareByBoard: Map<string, string> = (shareStore.__smartiShareByBoard ??= new Map());
const boardByShare: Map<string, string> = (shareStore.__smartiBoardByShare ??= new Map());

/**
 * Start sharing a board, or hand back the token it is already shared with.
 *
 * **Idempotent per board on purpose:** reopening the dialog must not invalidate a
 * link somebody is already holding. Re-minting is `revokeShare` followed by this,
 * which is a deliberate act with a button of its own.
 */
export function mintShare(boardId: string): string {
  const existing = shareByBoard.get(boardId);
  if (existing) return existing;
  const token = crypto.randomUUID();
  shareByBoard.set(boardId, token);
  boardByShare.set(token, boardId);
  return token;
}

/** The board's live token, or null if it is not being shared. */
export function shareFor(boardId: string): string | null {
  return shareByBoard.get(boardId) ?? null;
}

/**
 * The board a token reaches, or null.
 *
 * The whole authority behind `{ share }` in ./access — a token names exactly one
 * board, so "reaches this board" and "reaches any board" can never be the same
 * question.
 */
export function boardForShare(token: string): string | null {
  if (!token) return null;
  return boardByShare.get(token) ?? null;
}

/** Stop sharing. The link is dead immediately; there is nothing to expire. */
export function revokeShare(boardId: string): void {
  const token = shareByBoard.get(boardId);
  if (!token) return;
  shareByBoard.delete(boardId);
  boardByShare.delete(token);
}
