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
 *  - Opening the panel is the invocation: one request fires automatically
 *    unless a summary cached for the current fingerprint is still fresh.
 *  - A board switch under an open panel does NOT auto-summarize the new
 *    board — navigating is not asking, and switching must not spend tokens.
 *    The idle state offers an explicit button instead.
 *  - Closing the panel (or switching boards) aborts the fetch; deltas are
 *    also boardId-guarded, so a late frame can never land in the next board.
 *  - Stream chunks are buffered and flushed once per animation frame — a
 *    store write per token would re-render the canvas chrome needlessly.
 */
export function SummaryPanel() {
  const board = useBoard((s) => s.board);
  const boardId = useBoard((s) => s.boardId);
  const loaded = useBoard((s) => s.loaded);
  const text = useBoard((s) => s.summaryText);
  const status = useBoard((s) => s.summaryStatus);
  const cachedFp = useBoard((s) => s.summaryFingerprint);
  const setSummaryOpen = useBoard((s) => s.setSummaryOpen);

  const abortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef('');
  const rafRef = useRef<number | null>(null);
  /** One automatic request per panel opening, not per board under an open panel. */
  const autoRef = useRef(false);

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

  /* One auto-request per opening; board switches and reloads wait for a click. */
  useEffect(() => {
    if (!loaded) return;
    const s = useBoard.getState();
    const fresh = s.summaryFingerprint === fingerprint(s.board) && s.summaryStatus === 'done';
    if (!autoRef.current) {
      autoRef.current = true;
      if (!fresh) void run();
    }
    return () => {
      abortRef.current?.abort();
      drain();
    };
  }, [boardId, loaded, run]);

  /* Esc closes — same dismissibility as everything else the AI shows. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useBoard.getState().setSummaryOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const stale = status === 'done' && cachedFp !== fingerprint(board);
  const canSummarize = loaded && substantiveNodes(board).length >= MIN_NODES;

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

        {status === 'streaming' && !text ? <p className="summary-note">reading the board…</p> : null}
        {text ? <div className="summary-text">{text}</div> : null}
        {status === 'error' && !text ? <p className="summary-note">couldn&apos;t summarize this board</p> : null}
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
