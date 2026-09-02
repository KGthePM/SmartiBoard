'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/shareToken';
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
 */
export function useSync(
  boardId: string,
  board: Board,
  loaded: boolean,
): {
  saveState: SaveState;
  /** This tab's id, for the routes that speak to the room on its behalf. */
  clientId: string;
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
          if (!r.ok) throw new Error(`save failed: ${r.status}`);
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
  }, [board, boardId, loaded, retryNonce, ghostNonce]);

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
   * The stream itself, read with `fetch` and a reader rather than
   * `EventSource` — the same shape components/IdeasPanel.tsx already uses, and
   * the choice that survives sharing: a share token must ride in a header, and
   * EventSource cannot set one.
   */
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    let ctrl: AbortController | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let backoff = STREAM_RETRY_MS;

    const run = async () => {
      ctrl = new AbortController();
      try {
        const res = await apiFetch(`/api/boards/${boardId}/sync`, {
          headers: { accept: 'text/event-stream' },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
        // A connection that opened is a connection that works.
        backoff = STREAM_RETRY_MS;

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
            try {
              handle(JSON.parse(line.slice(6)) as Frame);
            } catch {
              // A frame we cannot read costs that frame. The next `hello`
              // resyncs the board, so there is nothing to recover here.
            }
          }
        }
      } catch {
        // A dropped stream is not an error the person needs to hear about; the
        // save indicator speaks for the write path, and reconnecting is silent.
      }
      if (cancelled) return;
      retry = setTimeout(run, backoff);
      backoff = Math.min(STREAM_RETRY_MAX_MS, backoff * 2);
    };

    void run();
    return () => {
      // StrictMode's double mount must not leave two streams open.
      cancelled = true;
      ctrl?.abort();
      if (retry) clearTimeout(retry);
    };
  }, [boardId, loaded, handle]);

  return { saveState, clientId: clientIdRef.current, flushUnsaved, beginBoard, seedBasis, queueGhostEvent };
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
