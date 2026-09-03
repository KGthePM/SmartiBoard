import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boardForShare,
  claimGhost,
  currentSeq,
  framesSince,
  GHOST_LEASE_MS,
  mintShare,
  publish,
  releaseGhost,
  revokeShare,
  roomCount,
  ROOM_GRACE_MS,
  shareFor,
  subscribe,
  type Frame,
} from './hub';

/**
 * The hub is a process global, so every test names its own board. That is the
 * same isolation the real thing has — a room is per board — and it means no
 * reset hook exists to be forgotten.
 */
let n = 0;
const boardId = () => `b${++n}`;

/** A subscriber that remembers what it was sent. */
function sink() {
  const got: Frame[] = [];
  return { got, send: (f: Frame) => got.push(f) };
}

const ops = (id: string) => [{ t: 'node.del' as const, id }];

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('subscribe / publish', () => {
  it('delivers a published frame to everyone in the room', () => {
    const b = boardId();
    const a = sink();
    const c = sink();
    subscribe(b, a.send);
    subscribe(b, c.send);

    publish(b, { type: 'ops', clientId: 'x', ops: ops('n1') });

    expect(a.got).toEqual([{ type: 'ops', clientId: 'x', ops: ops('n1'), seq: 1 }]);
    expect(c.got).toEqual(a.got);
  });

  // Echo suppression is the client's rule, so the sender's own stream sees it.
  it('does not exempt the client the frame came from', () => {
    const b = boardId();
    const a = sink();
    subscribe(b, a.send);
    publish(b, { type: 'ops', clientId: 'x', ops: ops('n1') });
    expect(a.got.at(-1)).toMatchObject({ clientId: 'x' });
  });

  it('stops delivering once unsubscribed', () => {
    const b = boardId();
    const a = sink();
    const off = subscribe(b, a.send);
    off();
    off(); // idempotent: the route calls it from cancel() and from finally
    publish(b, { type: 'ops', clientId: 'x', ops: ops('n1') });
    expect(a.got).toEqual([]);
    expect(roomCount(b)).toBe(0);
  });

  it('is a no-op when nobody is listening', () => {
    const b = boardId();
    expect(publish(b, { type: 'ops', clientId: 'x', ops: ops('n1') })).toBe(0);
    expect(currentSeq(b)).toBe(0);
  });

  it('drops a subscriber whose send throws, and still delivers to the rest', () => {
    const b = boardId();
    const a = sink();
    subscribe(b, () => {
      throw new Error('socket closed');
    });
    subscribe(b, a.send);

    publish(b, { type: 'ops', clientId: 'x', ops: ops('n1') });
    publish(b, { type: 'ops', clientId: 'x', ops: ops('n2') });

    expect(a.got).toHaveLength(2);
    expect(roomCount(b)).toBe(1);
  });
});

describe('seq', () => {
  it('is monotonic within a room and readable before the first publish', () => {
    const b = boardId();
    const a = sink();
    subscribe(b, a.send);
    expect(currentSeq(b)).toBe(0);

    publish(b, { type: 'ops', clientId: 'x', ops: ops('n1') });
    publish(b, { type: 'ops', clientId: 'y', ops: ops('n2') });

    expect(a.got.map((f) => f.seq)).toEqual([1, 2]);
    expect(currentSeq(b)).toBe(2);
  });

  it('is independent across rooms', () => {
    const one = boardId();
    const two = boardId();
    const a = sink();
    const c = sink();
    subscribe(one, a.send);
    subscribe(two, c.send);

    publish(one, { type: 'ops', clientId: 'x', ops: ops('n1') });
    publish(one, { type: 'ops', clientId: 'x', ops: ops('n2') });
    publish(two, { type: 'ops', clientId: 'x', ops: ops('n3') });

    expect(a.got.map((f) => f.seq)).toEqual([1, 2]);
    expect(c.got.map((f) => f.seq)).toEqual([1]);
  });
});

describe('the ghost lease', () => {
  it('lets exactly one client through, per room', () => {
    const b = boardId();
    const other = boardId();
    expect(claimGhost(b, 'a', 'fp', 1000)).toBe(true);
    expect(claimGhost(b, 'c', 'fp', 1000)).toBe(false);
    expect(claimGhost(b, 'd', 'other-fp', 1000)).toBe(false);
    // A different board is a different room and is unaffected.
    expect(claimGhost(other, 'c', 'fp', 1000)).toBe(true);
  });

  // A retry after a response that never arrived must not lock itself out.
  it('renews for the same client asking about the same board', () => {
    const b = boardId();
    expect(claimGhost(b, 'a', 'fp', 1000)).toBe(true);
    expect(claimGhost(b, 'a', 'fp', 2000)).toBe(true);
    expect(claimGhost(b, 'c', 'fp', 2000)).toBe(false);
  });

  it('lets the next claim through once released', () => {
    const b = boardId();
    claimGhost(b, 'a', 'fp', 1000);
    releaseGhost(b, 'a');
    expect(claimGhost(b, 'c', 'fp', 1000)).toBe(true);
  });

  it('cannot be released by anyone but the holder', () => {
    const b = boardId();
    claimGhost(b, 'a', 'fp', 1000);
    releaseGhost(b, 'c');
    expect(claimGhost(b, 'c', 'fp', 1000)).toBe(false);
  });

  it('releases quietly — a delivered ghost is not an expiry', () => {
    const b = boardId();
    const a = sink();
    subscribe(b, a.send);
    claimGhost(b, 'a', 'fp', 1000);
    releaseGhost(b, 'a');
    vi.advanceTimersByTime(GHOST_LEASE_MS * 2);
    expect(a.got).toEqual([]);
  });

  /**
   * The winner's tab died between the claim and the answer. The losers stamped
   * their fingerprint before their POST, so nobody will ask again on their own —
   * the announcement is what unsticks the room.
   */
  it('announces a lease that expires undelivered, and frees the ghost', () => {
    const b = boardId();
    const a = sink();
    subscribe(b, a.send);
    claimGhost(b, 'a', 'fp', 1000);

    vi.advanceTimersByTime(GHOST_LEASE_MS - 1);
    expect(a.got).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(a.got).toEqual([{ type: 'ghost', clientId: '', phase: 'released', seq: 1 }]);
    expect(claimGhost(b, 'c', 'fp', 1000 + GHOST_LEASE_MS)).toBe(true);
  });

  it('does not announce an expiry for a lease that changed hands', () => {
    const b = boardId();
    const a = sink();
    subscribe(b, a.send);
    claimGhost(b, 'a', 'fp', 1000);
    releaseGhost(b, 'a');
    claimGhost(b, 'c', 'fp2', 1000);

    // 'a's timer fires here and must find a lease that is no longer its own.
    vi.advanceTimersByTime(GHOST_LEASE_MS);
    expect(a.got.filter((f) => f.type === 'ghost')).toHaveLength(1);
  });
});

describe('the share registry', () => {
  it('says nothing about a board nobody is sharing', () => {
    expect(shareFor(boardId())).toBeNull();
  });

  // Reopening the dialog must not invalidate a link already sent.
  it('mints one token per board and keeps handing back the same one', () => {
    const b = boardId();
    const first = mintShare(b);
    expect(mintShare(b)).toBe(first);
    expect(shareFor(b)).toBe(first);
  });

  it('gives two boards two tokens, each reaching only its own', () => {
    const a = boardId();
    const c = boardId();
    const ta = mintShare(a);
    const tc = mintShare(c);
    expect(ta).not.toBe(tc);
    expect(boardForShare(ta)).toBe(a);
    expect(boardForShare(tc)).toBe(c);
  });

  it('reaches nothing with a token nobody minted, or with none at all', () => {
    expect(boardForShare('not-a-token')).toBeNull();
    expect(boardForShare('')).toBeNull();
  });

  it('kills the link on revoke, and forgets the board with it', () => {
    const b = boardId();
    const token = mintShare(b);
    revokeShare(b);
    expect(boardForShare(token)).toBeNull();
    expect(shareFor(b)).toBeNull();
    // Revoking twice is not an error, and the second one has nothing to do.
    revokeShare(b);
    expect(shareFor(b)).toBeNull();
  });

  it('re-minting after a revoke is a new token, so the old link stays dead', () => {
    const b = boardId();
    const first = mintShare(b);
    revokeShare(b);
    const second = mintShare(b);
    expect(second).not.toBe(first);
    expect(boardForShare(first)).toBeNull();
    expect(boardForShare(second)).toBe(b);
  });

  // The reason the registry is a sibling map rather than a field on Room:
  // `sweep` deletes a room the moment nobody is subscribed and nothing is
  // leased, which would revoke a share whenever the host closed their tab.
  it('outlives the last subscriber, because sharing is not attendance', () => {
    const b = boardId();
    const token = mintShare(b);
    const a = sink();
    const off = subscribe(b, a.send);
    off();
    expect(roomCount(b)).toBe(0);
    expect(boardForShare(token)).toBe(b);
    expect(shareFor(b)).toBe(token);
  });
});

describe('framesSince', () => {
  /**
   * The long poll's memory (v4.2). The contract the route leans on is the
   * difference between `[]` and `null`: nothing happened, versus I cannot tell
   * you what happened — and only the second one owes the client a whole board.
   */
  const held = (b: string) => {
    const a = sink();
    subscribe(b, a.send);
    return a;
  };

  it('is null for a room nobody has opened', () => {
    // Which is exactly the state a board falls into between two polls once it
    // goes quiet: `sweep` deletes the room, and the next poll resyncs.
    expect(framesSince(boardId(), 0)).toBeNull();
  });

  it('is empty when the room has said nothing since', () => {
    const b = boardId();
    held(b);
    expect(framesSince(b, 0)).toEqual([]);
    publish(b, { type: 'ops', clientId: 'x', ops: ops('n1') });
    expect(framesSince(b, 1)).toEqual([]);
  });

  it('hands back everything after seq, in order', () => {
    const b = boardId();
    held(b);
    publish(b, { type: 'ops', clientId: 'x', ops: ops('n1') });
    publish(b, { type: 'ops', clientId: 'y', ops: ops('n2') });
    publish(b, { type: 'ops', clientId: 'z', ops: ops('n3') });

    expect(framesSince(b, 0)?.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(framesSince(b, 2)?.map((f) => f.seq)).toEqual([3]);
    expect(framesSince(b, 2)?.[0]).toMatchObject({ clientId: 'z' });
  });

  it('carries every kind of frame, the ghost included', () => {
    // The reason the poll is a transport swap and not a second feature: a
    // client on it hears about the room's proposal exactly as a stream does.
    const b = boardId();
    held(b);
    publish(b, { type: 'ghost', clientId: 'x', phase: 'released' });
    expect(framesSince(b, 0)).toEqual([
      { type: 'ghost', clientId: 'x', phase: 'released', seq: 1 },
    ]);
  });

  it('is null for a seq ahead of the room', () => {
    // A client holding a seq from a previous process. The counter is
    // session-only, so a restart begins again at zero and the held number is
    // meaningless rather than merely stale.
    const b = boardId();
    held(b);
    publish(b, { type: 'ops', clientId: 'x', ops: ops('n1') });
    expect(framesSince(b, 9)).toBeNull();
  });

  it('is null once the gap is wider than the log', () => {
    const b = boardId();
    held(b);
    for (let i = 0; i < 300; i++) publish(b, { type: 'ops', clientId: 'x', ops: ops(`n${i}`) });

    // Still inside the log: the oldest frame kept is seq 45, so a client
    // holding 44 has an unbroken run to follow.
    expect(framesSince(b, 44)?.[0]?.seq).toBe(45);
    expect(framesSince(b, 0)).toBeNull();
    expect(framesSince(b, 43)).toBeNull();
  });

  // The grace, from the poll's side: being between two requests is a pause, so
  // the log is still there to resume from. Without this the room would be swept
  // the instant a poll was answered and the next one would resync the whole
  // board — on every remote edit, forever.
  it('survives the gap between one poll and the next', () => {
    const b = boardId();
    const a = sink();
    const off = subscribe(b, a.send);
    publish(b, { type: 'ops', clientId: 'x', ops: ops('n1') });
    off();

    expect(roomCount(b)).toBe(0);
    expect(framesSince(b, 0)?.map((f) => f.seq)).toEqual([1]);
  });

  it('forgets once the grace runs out, and says so rather than lying', () => {
    const b = boardId();
    const a = sink();
    const off = subscribe(b, a.send);
    publish(b, { type: 'ops', clientId: 'x', ops: ops('n1') });
    off();

    vi.advanceTimersByTime(ROOM_GRACE_MS + 1);
    expect(framesSince(b, 0)).toBeNull();
  });

  // Rejoining inside the grace cancels the countdown outright, rather than
  // leaving a timer that would delete a room somebody is sitting in.
  it('stops counting down when somebody rejoins', () => {
    const b = boardId();
    const first = sink();
    const off = subscribe(b, first.send);
    publish(b, { type: 'ops', clientId: 'x', ops: ops('n1') });
    off();

    const second = sink();
    subscribe(b, second.send);
    vi.advanceTimersByTime(ROOM_GRACE_MS * 3);

    expect(framesSince(b, 0)?.map((f) => f.seq)).toEqual([1]);
    publish(b, { type: 'ops', clientId: 'y', ops: ops('n2') });
    expect(second.got.map((f) => f.seq)).toEqual([2]);
  });
});
