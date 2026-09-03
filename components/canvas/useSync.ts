'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, shareToken } from '@/lib/shareToken';
import { useBoard } from '@/lib/store';
import { applyOps, diffBoards, type Op } from '@/lib/sync';
import { newId, parseBoard, type Board, type NodeId } from '@/lib/graph';
import type { Frame } from '@/lib/hub';

const AUTOSAVE_MS = 700;
/** How often a failed save retries itself while the indicator shows error. */
const SAVE_RETRY_MS = 5000;
/** First reconnect wait for the stream; doubles to STREAM_RETRY_MAX_MS. */
const STREAM_RETRY_MS = 1000;
const STREAM_RETRY_MAX_MS = 30_000;
/**
 * How long a freshly opened stream may deliver nothing before this tab decides
 * it is not a stream (v4.2).
 *
 * `hello` is sent the instant the route subscribes, so a working stream answers
 * in milliseconds and this timer never fires on loopback or the LAN. What it
 * catches is an intermediary that buffers the body until the response ends —
 * Cloudflare's quick tunnels do, completely, so a shared board reached through
 * v4.2's public link would otherwise sit silent while its edits merged
 * invisibly. Generous, because the cost of firing early is a needless fallback
 * and the cost of firing late is a blind guest.
 */
const STREAM_PROBE_MS = 5000;
/**
 * The floor on one poll cycle. The route holds a quiet request for LONGPOLL_MS,
 * so this is never reached in practice; it exists so that a server answering
 * "nothing" instantly cannot be turned into a spin.
 */
const POLL_MIN_MS = 250;

export type SaveState = 'saved' | 'saving' | 'error';

/**
 * The ghost's lifecycle, as this tab reports it to the room: the person here
 * accepted or turned down the shared proposal.
 */
export type GhostEvent = {
  phase: 'accepted' | 'dismissed';
  proposalId: string;
  text: string;
};

/**
 * The autosave seam (v3.6), and the room's stream (v4.0). There is no save
 * button and never will be, so this is the whole write path of the canvas — and
 * it sends **what changed**, not the whole board.
 *
 * The lifecycle is exactly the one that lived in Board.tsx before v3.6: a
 * debounce, a monotonic send id so a late response cannot speak for a newer
 * save, a saving/saved/error indicator, a self-healing retry, and a flush for
 * the two exits that destroy the timer. Only the body changed — a POST of ops
 * to `/sync` in place of a PUT of the document. See lib/sync.ts for why.
 *
 * **The basis is the last board the server acked**, held here rather than a
 * JSON string, because a diff needs a board to diff against. Two rules follow
 * and both matter:
 *
 * 1. **It advances only on ack.** The old code stamped it optimistically and
 *    reset it to `''` on failure, which resent the whole document. Here a
 *    failure simply leaves it alone: the retry re-diffs from the same basis and
 *    re-sends the same ops plus whatever was typed since. Ops are idempotent
 *    (lib/sync.ts), so a duplicate landing is harmless, and the merge holds on
 *    the retry path too.
 * 2. **A null basis is never dirty.** Opening a board must not itself be a
 *    write, so the load effect clears the basis on the switch (`beginBoard`)
 *    and seeds it with what it read (`seedBasis`).
 *
 * v4.0 adds the other direction: a stream of what everyone else is doing. The
 * basis is what makes that tractable — it is both "what to send" and "what we
 * already know", so a remote frame advances it exactly as our own ack does.
 *
 * v4.2 adds a second way to receive that direction and no third rule: when the
 * stream turns out to be buffered rather than quiet — which is what a Cloudflare
 * quick tunnel does to it — the same frames are fetched one answer at a time
 * instead. The write path, the basis and `handle()` are untouched by that
 * choice; only how the frames arrive differs.
 */
export function useSync(
  boardId: string,
  board: Board,
  loaded: boolean,
): {
  saveState: SaveState;
  /** This tab's id, for the routes that speak to the room on its behalf. */
  clientId: string;
  /**
   * The server refused this board outright — a 403/404 rather than a failure
   * (v4.2). For a guest that means the share link died under them (the host
   * stopped sharing, or restarted); retrying would 404 forever, so the loops
   * stop and the canvas says so instead. Reset by a board switch.
   */
  denied: boolean;
  flushUnsaved: () => void;
  beginBoard: () => void;
  seedBasis: (b: Board) => void;
  queueGhostEvent: (evt: GhostEvent) => void;
} {
  /** The last board the server acknowledged; null until this board loads. */
  const basisRef = useRef<Board | null>(null);
  // Monotonic id for each batch we send. A response landing after a newer save
  // has gone out must not mark the board saved — or failed — on its own behalf.
  const saveSeqRef = useRef(0);
  // This tab, for the room. Not an identity and not trusted with anything: it
  // is only the key each client uses to recognise its own echo on the stream.
  const clientIdRef = useRef<string>('');
  if (!clientIdRef.current) clientIdRef.current = newId('c');
  /** A ghost accept/dismiss waiting for the next POST to carry it. */
  const ghostRef = useRef<GhostEvent | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [denied, setDenied] = useState(false);
  // The ref is what the transport loop reads between awaits; the state is what
  // the canvas renders. Set together, cleared together.
  const deniedRef = useRef(false);
  // Exists only to re-arm the autosave effect while a save is failing; a
  // board whose author stopped typing still deserves to recover on its own.
  const [retryNonce, setRetryNonce] = useState(0);
  // The same re-arming, for the one thing that changes nothing on the board:
  // dismissing a ghost produces no ops, so without this there is no send.
  const [ghostNonce, setGhostNonce] = useState(0);

  const beginBoard = useCallback(() => {
    // basisRef is a ref and a board switch does not remount the canvas, so the
    // outgoing board's basis has to be forgotten by hand.
    basisRef.current = null;
    // A ghost belongs to the board it was proposed on.
    ghostRef.current = null;
    // A refusal was the last board's; the incoming one answers for itself.
    deniedRef.current = false;
    setDenied(false);
  }, []);

  /**
   * A 403/404 is the server saying "not yours", which no amount of retrying
   * changes — as opposed to a 5xx or a dropped connection, which the retry
   * loops exist for. Latching it is what stops a guest whose link died from
   * silently hammering a refusal every few seconds forever.
   */
  const refuse = useCallback((status: number) => {
    if (status !== 403 && status !== 404) return;
    deniedRef.current = true;
    setDenied(true);
  }, []);

  const seedBasis = useCallback((b: Board) => {
    basisRef.current = b;
    // The indicator starts each board honest, whatever the last one showed.
    saveSeqRef.current++;
    setSaveState('saved');
  }, []);

  /**
   * Tell the room what this tab did with the shared ghost. It rides the next
   * POST rather than a route of its own: accepting a ghost *is* accompanied by
   * ops, and one request is what makes it impossible for another client to see
   * "the ghost is gone" before "the node arrived", or the reverse.
   */
  const queueGhostEvent = useCallback((evt: GhostEvent) => {
    ghostRef.current = evt;
    setGhostNonce((n) => n + 1);
  }, []);

  /* ---------- leaving a board: its pending edits leave as a write ---------- */

  // Both exits from the canvas — switching boards and unmounting it (navigating
  // to the index) — destroy the debounce timer with the effect cleanup, and an
  // edit from the last AUTOSAVE_MS would die with it. This is the same POST the
  // autosave would have made, fired unsupervised: by the time it settles there
  // is no board on screen to report its fate to.
  //
  // It sends ops for the same reason the debounced save does. A whole-board PUT
  // here would put the clobber back on every board switch, which is the one
  // save nobody is watching.
  const flushUnsaved = useCallback(() => {
    const s = useBoard.getState();
    const basis = basisRef.current;
    if (!s.loaded || !basis) return;
    const ops = diffBoards(basis, s.board);
    const ghost = ghostRef.current;
    if (ops.length === 0 && !ghost) return;
    basisRef.current = s.board;
    ghostRef.current = null;
    // Supersedes anything in flight, so its late response touches nothing.
    saveSeqRef.current++;
    void apiFetch(`/api/boards/${s.board.id}/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: clientIdRef.current, ops, ...(ghost ? { ghost } : {}) }),
    }).catch(() => {
      /* Unsupervised by design — see above. */
    });
  }, []);

  /* ---------- autosave: no save button, ever ---------- */

  useEffect(() => {
    // board.id lags boardId for one render on a switch; writing then would put
    // the outgoing board's content under the incoming board's id.
    if (!loaded || board.id !== boardId) return;
    const basis = basisRef.current;
    if (!basis) return;
    const ops = diffBoards(basis, board);
    const ghost = ghostRef.current;
    // A ghost event can travel alone: a dismissal changes nothing on the board.
    if (ops.length === 0 && !ghost) return;

    // Dirty: the change exists only in this tab until the batch lands, and the
    // indicator says so for the debounce and the flight alike. A ghost-only
    // send is not board content and deliberately leaves the indicator alone.
    if (ops.length > 0) setSaveState('saving');
    const t = setTimeout(() => {
      // A ghost-only send deliberately does not claim the sequence: it is not
      // board content, and superseding a save in flight would strand that
      // save's indicator at "saving" with its basis never advanced.
      const mine = ops.length > 0 ? ++saveSeqRef.current : saveSeqRef.current;
      // Cleared now rather than on the response: this event has been handed
      // over, and a retry must not re-announce a ghost that is long gone.
      if (ghostRef.current === ghost) ghostRef.current = null;
      void apiFetch(`/api/boards/${boardId}/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: clientIdRef.current, ops, ...(ghost ? { ghost } : {}) }),
      })
        .then((r) => {
          if (mine !== saveSeqRef.current) return;
          // A non-2xx merged nothing — the row never changed — so it takes the
          // failure path rather than counting as a save.
          if (!r.ok) {
            refuse(r.status);
            throw new Error(`save failed: ${r.status}`);
          }
          if (ops.length === 0) return;
          // Only now: these ops are durable, so the next diff starts here.
          //
          // This is the board as it stood when the batch was built, so a remote
          // frame that landed mid-flight is not in it — and that is harmless
          // rather than a stale basis: the teammate's change *is* in our board,
          // so the next diff re-derives it as one of our own ops and re-sends
          // identical content. Idempotent, one extra op, self-healing.
          basisRef.current = board;
          setSaveState('saved');
        })
        .catch(() => {
          if (mine !== saveSeqRef.current) return;
          if (ops.length === 0) return;
          // The basis is deliberately left where it was: the retry recomputes
          // the same ops (plus anything typed since) and re-sends them.
          setSaveState('error');
        });
    }, AUTOSAVE_MS);
    return () => clearTimeout(t);
    // retryNonce re-arms this effect after a failure, without any edit;
    // ghostNonce re-arms it for a dismissal, which changes nothing to diff.
  }, [board, boardId, loaded, retryNonce, ghostNonce, refuse]);

  // A failed save recovers on its own: waiting for the next edit would strand
  // every board whose author stopped typing the moment it failed. While in
  // error, wake the autosave effect every SAVE_RETRY_MS — the basis never
  // advanced, so it always finds the board dirty and resends.
  useEffect(() => {
    if (saveState !== 'error') return;
    const t = setTimeout(() => setRetryNonce((n) => n + 1), SAVE_RETRY_MS);
    return () => clearTimeout(t);
  }, [saveState, retryNonce]);

  // The other exit flushUnsaved covers: leaving the app unmounts the canvas
  // without ever switching boards. StrictMode's simulated unmount is a no-op —
  // a freshly mounted board has a null basis and nothing to flush.
  useEffect(() => () => flushUnsaved(), [flushUnsaved]);

  /* ---------- the room's stream (v4.0) ---------- */

  /**
   * One frame, applied. Everything it needs is a ref or the store, so it is
   * stable across renders and the stream is never reopened by a keystroke.
   */
  const handle = useCallback(
    (frame: Frame) => {
      const s = useBoard.getState();
      switch (frame.type) {
        case 'hello': {
          const basis = basisRef.current;
          // The board has not loaded yet; the load effect's seedBasis is
          // authoritative and this frame has nothing to say over it.
          if (!basis) break;
          const hello = parseBoard(boardId, frame.board);
          // **The reconnect rule, and the hardest merge here.** What the room
          // did while we were away is the difference from our last *ack* — not
          // from our local board, which would compute ops that wipe our own
          // unsaved work. Our surviving edits then read as dirty against the
          // new basis and ride the next debounce.
          const ops = diffBoards(basis, hello);
          if (ops.length > 0) s.applyRemote(boardId, ops, dirtyIds(basis, s.board));
          basisRef.current = hello;
          break;
        }
        case 'ops': {
          if (frame.clientId === clientIdRef.current) break;
          const basis = basisRef.current;
          if (!basis) break;
          s.applyRemote(boardId, frame.ops, dirtyIds(basis, s.board));
          // The second half, and the easy one to miss: without it every remote
          // change reads as local dirt on the next diff and is echoed straight
          // back. A node we skipped as dirty stays dirty against the new basis,
          // which is exactly right — our version re-sends and wins.
          basisRef.current = applyOps(basis, frame.ops);
          break;
        }
        case 'ghost': {
          // Our own echo. The winner already has this proposal from the
          // response to its own /suggest call, and re-placing it would move it.
          if (frame.clientId && frame.clientId === clientIdRef.current) break;
          if (frame.phase === 'proposed') s.receiveProposal(frame.draft, frame.proposalId);
          // A lease that expired with nothing delivered: the room is free to
          // ask again, and every client has to be told or the fingerprint they
          // all stamped keeps them silent forever.
          else if (frame.phase === 'released') s.releaseRequest();
          else s.remoteRetireProposal(frame.proposalId, frame.phase, frame.text);
          break;
        }
        case 'ping':
          break;
      }
    },
    [boardId],
  );

  /**
   * The room, received. Two transports, one frame handler.
   *
   * **The stream is read with `fetch` and a reader rather than `EventSource`** —
   * the same shape components/IdeasPanel.tsx already uses, and the choice that
   * survives sharing: a share token must ride in a header, and `EventSource`
   * cannot set one.
   *
   * **The poll (v4.2) is what a stream falls back to when it turns out not to be
   * one.** A Cloudflare quick tunnel holds a response body until it ends, so the
   * stream opens, is accepted, and then delivers nothing for as long as it stays
   * open — never an error, which is why this is detected by silence rather than
   * caught. `hello` lands the moment the route subscribes, so STREAM_PROBE_MS of
   * nothing at all means the bytes are being held somewhere, and the answer is a
   * request that *ends*: `?since=<seq>` returns the moment the room speaks.
   *
   * The fallback is per board and one-way. Reconnecting into a stream that has
   * already proved buffered would spend STREAM_PROBE_MS blind on every retry,
   * and nothing about a tunnel changes while a board is open.
   */
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    let ctrl: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let wake: (() => void) | null = null;
    let backoff = STREAM_RETRY_MS;
    /**
     * Set once, by the probe below: this connection does not stream. A guest
     * reached through a Cloudflare quick tunnel starts here outright — that
     * transport is *known* buffered (measured in v4.2), so spending the probe's
     * five blind seconds proving it again on every board open buys nothing.
     */
    let buffered = knownBuffered();
    /**
     * The last seq this tab has seen, and the poll's whole memory. `-1` is "I
     * have nothing", which the route answers with `hello` — so a poll that
     * starts, a poll that lost its room and a poll that fell too far behind all
     * recover by the same path the stream already used.
     */
    let seq = -1;

    const take = (frame: Frame) => {
      seq = Math.max(seq, frame.seq);
      handle(frame);
    };

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, ms);
      });

    /** True if the connection delivered something, which is what earns a retry
     *  with the backoff reset. */
    const runStream = async (): Promise<boolean> => {
      ctrl = new AbortController();
      let spoke = false;
      // Only a response whose *headers* arrived can prove buffering: silence
      // before that is just a slow connect (a cold tunnel edge takes seconds),
      // and latching `buffered` on it would convert the tab to polling for the
      // life of the board on the strength of one bad handshake. The probe still
      // aborts either way — a retry is cheap, a blind wait is not.
      let connected = false;
      const probe = setTimeout(() => {
        if (spoke) return;
        if (connected) buffered = true;
        ctrl?.abort();
      }, STREAM_PROBE_MS);

      try {
        const res = await apiFetch(`/api/boards/${boardId}/sync`, {
          headers: { accept: 'text/event-stream' },
          signal: ctrl.signal,
        });
        connected = true;
        if (!res.ok || !res.body) {
          refuse(res.status);
          throw new Error(`stream failed: ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done || cancelled) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() ?? '';
          for (const chunk of chunks) {
            const line = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (!line) continue;
            // Before the parse: a frame we cannot read still proves the bytes
            // are moving, which is the only question the probe is asking.
            spoke = true;
            try {
              take(JSON.parse(line.slice(6)) as Frame);
            } catch {
              // A frame we cannot read costs that frame. The next `hello`
              // resyncs the board, so there is nothing to recover here.
            }
          }
        }
        return spoke;
      } finally {
        clearTimeout(probe);
      }
    };

    const runPoll = async (): Promise<boolean> => {
      ctrl = new AbortController();
      const started = Date.now();
      const res = await apiFetch(`/api/boards/${boardId}/sync?since=${seq}`, {
        signal: ctrl.signal,
      });
      if (!res.ok) {
        refuse(res.status);
        throw new Error(`poll failed: ${res.status}`);
      }

      const { frames } = (await res.json()) as { frames: Frame[] };
      for (const frame of frames) take(frame);
      // An empty answer is this transport's heartbeat and is allowed to come
      // back fast — but never fast enough to become a spin.
      const elapsed = Date.now() - started;
      if (frames.length === 0 && elapsed < POLL_MIN_MS) await sleep(POLL_MIN_MS - elapsed);
      return true;
    };

    const run = async () => {
      while (!cancelled && !deniedRef.current) {
        let delivered = false;
        try {
          delivered = buffered ? await runPoll() : await runStream();
        } catch {
          // A dropped stream is not an error the person needs to hear about;
          // the save indicator speaks for the write path, and reconnecting is
          // silent.
        }
        if (cancelled) return;
        if (delivered) {
          backoff = STREAM_RETRY_MS;
          continue;
        }
        await sleep(backoff);
        backoff = Math.min(STREAM_RETRY_MAX_MS, backoff * 2);
      }
    };

    void run();
    return () => {
      // StrictMode's double mount must not leave two of these running.
      cancelled = true;
      ctrl?.abort();
      if (timer) clearTimeout(timer);
      wake?.();
    };
  }, [boardId, loaded, handle, refuse]);

  return {
    saveState,
    clientId: clientIdRef.current,
    denied,
    flushUnsaved,
    beginBoard,
    seedBasis,
    queueGhostEvent,
  };
}

/**
 * Whether this page's transport is already known not to carry a stream (v4.2).
 *
 * A guest on a Cloudflare quick tunnel is the one case we can name up front:
 * the fragment token says "guest", the hostname says "quick tunnel", and the
 * buffering was measured rather than assumed. Everyone else — loopback, LAN,
 * a tailnet, some future proxy — keeps stream-first with the probe deciding.
 */
function knownBuffered(): boolean {
  return (
    shareToken() !== null &&
    typeof window !== 'undefined' &&
    window.location.hostname.endsWith('.trycloudflare.com')
  );
}

/**
 * Which cards this tab has changed but not yet had acked. They are ours until
 * the save lands — a remote put for one of them would yank the card out from
 * under whoever is typing in it.
 */
function dirtyIds(basis: Board, board: Board): NodeId[] {
  return diffBoards(basis, board).flatMap((op: Op) =>
    op.t === 'node.put' ? [op.node.id] : op.t === 'node.del' ? [op.id] : [],
  );
}
