'use client';

import { useCallback, useEffect, useRef } from 'react';
import { fingerprint, MIN_NODES, substantiveNodes } from '@/lib/ai/trigger';
import { useBoard } from '@/lib/store';

/**
 * The summary drawer. Read-only AI output streamed into a panel — the one
 * place the product answers a question on demand, as opposed to the ghost
 * that interjects on its own policy.
 *
 * Lifecycle rules that matter:
 *  - Opening the panel is NOT the invocation. It shows the summary cached
 *    for the current fingerprint if one is fresh, and a launch button
 *    otherwise — no token is spent without a click. (This also keeps the
 *    panel trivially StrictMode-safe: nothing fires on mount, so React's
 *    dev-only double mount has nothing to abort.)
 *  - Closing the panel (or switching boards — `beginLoad` closes it) aborts
 *    the fetch and cancels an in-progress stream back to idle, so a reopened
 *    panel offers the button instead of a frozen half-summary. Deltas are
 *    boardId-guarded, so a late frame can never land in the next board.
 *  - Stream chunks are buffered and flushed once per animation frame — a
 *    store write per token would re-render the canvas chrome needlessly.
 */
export function SummaryPanel() {
  const board = useBoard((s) => s.board);
  const loaded = useBoard((s) => s.loaded);
  const text = useBoard((s) => s.summaryText);
  const status = useBoard((s) => s.summaryStatus);
  const cachedFp = useBoard((s) => s.summaryFingerprint);
  const setSummaryOpen = useBoard((s) => s.setSummaryOpen);

  const abortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef('');
  const rafRef = useRef<number | null>(null);

  const drain = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const chunk = pendingRef.current;
    pendingRef.current = '';
    if (chunk) useBoard.getState().appendSummary(chunk);
  }, []);

  const run = useCallback(async () => {
    const start = useBoard.getState();
    const id = start.boardId;
    const fp = fingerprint(start.board);

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    start.beginSummary();

    try {
      const res = await fetch(`/api/boards/${id}/summarize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ board: start.board }),
        signal: ac.signal,
      });
      // A response for a board we already left must not touch this one.
      if (useBoard.getState().boardId !== id) return;

      // The no-key configuration answers plain JSON, not SSE.
      const ctype = res.headers.get('content-type') ?? '';
      if (!res.ok || !ctype.includes('text/event-stream')) {
        const data = (await res.json().catch(() => null)) as { reason?: string } | null;
        useBoard.getState().failSummary(data?.reason ?? 'error');
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const handleFrame = (raw: string) => {
        const line = raw.split('\n').find((l) => l.startsWith('data: '));
        if (!line) return;
        let msg: { type?: string; text?: string; reason?: string };
        try {
          msg = JSON.parse(line.slice(6));
        } catch {
          return;
        }
        if (msg.type === 'delta' && typeof msg.text === 'string') {
          pendingRef.current += msg.text;
          if (rafRef.current == null) {
            rafRef.current = requestAnimationFrame(() => {
              rafRef.current = null;
              const chunk = pendingRef.current;
              pendingRef.current = '';
              if (chunk) useBoard.getState().appendSummary(chunk);
            });
          }
        } else if (msg.type === 'done') {
          drain();
          useBoard.getState().finishSummary(fp);
        } else if (msg.type === 'error') {
          drain();
          useBoard.getState().failSummary(msg.reason ?? 'error');
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          if (useBoard.getState().boardId !== id) {
            ac.abort();
            return;
          }
          handleFrame(frame);
        }
      }
      // The stream ended without a done frame (network cut mid-response).
      const after = useBoard.getState();
      if (after.boardId === id && after.summaryStatus === 'streaming') {
        after.failSummary('error');
      }
    } catch {
      // An abort is this panel closing or the board switching — not a failure.
      if (!ac.signal.aborted) useBoard.getState().failSummary('error');
    }
  }, [drain]);

  /* Unmounting — closing the panel, or a board switch closing it — cancels:
   * abort the fetch, drop the pending frame, and put an interrupted stream
   * back to idle so the next opening starts from the button, not a corpse. */
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      drain();
      useBoard.getState().cancelSummary();
    };
  }, [drain]);

  /* Esc closes — same dismissibility as everything else the AI shows. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useBoard.getState().setSummaryOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const stale = status === 'done' && cachedFp !== fingerprint(board);
  // A summary ships the whole board upstream, so Privacy Mode gates it exactly
  // as hard as the node floor does — and says so, since a disabled button with
  // no reason reads as a bug.
  const canSummarize =
    loaded && !board.privacy && substantiveNodes(board).length >= MIN_NODES;

  return (
    <aside className="summary" aria-label="Board summary">
      <div className="summary-head">
        <span className="summary-title">Board summary</span>
        <button className="summary-x" title="Close (Esc)" onClick={() => setSummaryOpen(false)}>
          ×
        </button>
      </div>

      <div className={`summary-body${status === 'streaming' ? ' streaming' : ''}`}>
        {status === 'idle' ? (
          canSummarize ? (
            <button className="summary-go" onClick={() => void run()}>
              Summarize this board
            </button>
          ) : board.privacy ? (
            <p className="summary-note">
              Privacy Mode is on for this board. Nothing here is sent to a model — turn it
              off (⌘⇧P) to ask for a summary.
            </p>
          ) : (
            <p className="summary-note">Needs at least 3 ideas before there is anything to summarize.</p>
          )
        ) : null}

        {status === 'no_key' ? (
          <div className="summary-note">
            <p>No model configured. The board works without one — a summary needs a provider.</p>
            <button
              className="summary-go"
              onClick={() => useBoard.getState().setSettingsOpen(true)}
            >
              Choose a model
            </button>
          </div>
        ) : null}

        {/* The route refused because the board is private — which can happen
            even from a clean idle state if another tab turned it on. */}
        {status === 'private' ? (
          <p className="summary-note">
            Privacy Mode is on for this board. Nothing here is sent to a model.
          </p>
        ) : null}

        {status === 'streaming' && !text ? <p className="summary-note">reading the board…</p> : null}
        {text ? <div className="summary-text">{text}</div> : null}
        {/* `done` with nothing in it is the same dead end as an error, and must
            not render as an empty panel. */}
        {(status === 'error' || status === 'done') && !text ? (
          <p className="summary-note">couldn&apos;t summarize this board</p>
        ) : null}
      </div>

      {(status === 'done' || stale || status === 'error') && canSummarize ? (
        <div className="summary-foot">
          {stale ? <span className="summary-note">the board has changed since this summary</span> : null}
          <button className="summary-again" onClick={() => void run()}>
            {status === 'error' ? 'Retry' : 'Regenerate'}
          </button>
        </div>
      ) : null}
    </aside>
  );
}
