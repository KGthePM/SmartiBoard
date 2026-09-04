'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { canAsk, fingerprint } from '@/lib/ai/trigger';
import { clampQuestion, parseAnswer, QUESTION_MAX } from '@/lib/ai/ask';
import { ASK_HISTORY_TURNS } from '@/lib/ai/ask-prompt';
import { cardView, viewRect } from '@/lib/collapse';
import { centerOn, containsRect, visibleRect, type NodeId } from '@/lib/graph';
import { stripMarks } from '@/lib/richtext';
import { apiFetch } from '@/lib/shareToken';
import { useBoard } from '@/lib/store';

/**
 * The Ask drawer (v5.4): questions about the board, answered read-only. The
 * ideas panel is the template and the lifecycle rules are inherited from it,
 * all of them load-bearing:
 *  - Opening is NOT invoking. No fetch on mount — the panel never spends a
 *    token on its own (and is trivially StrictMode-safe).
 *  - Frames are boardId-guarded; a stream that outlived a board switch is
 *    aborted, and every store mutator is guarded on streaming anyway.
 *  - Closing the panel (or a board switch closing it) aborts the fetch and
 *    cancels the in-flight turn rather than leaving it half-answered.
 *
 * What is different by design: nothing here crosses onto the board. No Add
 * button, no proposal, no bridge — Ideas owns putting things on a board, and
 * the one thing that keeps Ask outside the three-layer invariant is that
 * there is no path from an answer to the canvas. Citations go the other way:
 * they reveal a card that is already there.
 */
export function AskPanel() {
  const board = useBoard((s) => s.board);
  const loaded = useBoard((s) => s.loaded);
  const turns = useBoard((s) => s.askTurns);
  const status = useBoard((s) => s.askStatus);
  const cachedFp = useBoard((s) => s.askFingerprint);
  const context = useBoard((s) => s.askContext);
  const setAskOpen = useBoard((s) => s.setAskOpen);

  const [question, setQuestion] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const ask = useCallback(async (q: string) => {
    const start = useBoard.getState();
    const id = start.boardId;
    const fp = fingerprint(start.board);
    // A live selection narrows the board to those cards and their neighbours;
    // no selection reads the whole board. The history is the finished turns,
    // capped here as politeness — the route re-fits whatever arrives, because
    // a client is only a client.
    const history = start.askTurns
      .filter((t) => t.status === 'done')
      .slice(-ASK_HISTORY_TURNS)
      .map((t) => ({ question: t.question, answer: t.answer }));
    const scope = [...start.selectedIds];

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    start.beginAsk(clampQuestion(q));

    try {
      const res = await apiFetch(`/api/boards/${id}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ board: start.board, question: q, history, scope }),
        signal: ac.signal,
      });
      // A response for a board we already left must not touch this one.
      if (useBoard.getState().boardId !== id) return;

      // The refusals — privacy, no provider, nothing to read, empty question —
      // answer plain JSON, not SSE.
      const ctype = res.headers.get('content-type') ?? '';
      if (!res.ok || !ctype.includes('text/event-stream')) {
        const data = (await res.json().catch(() => null)) as { reason?: string } | null;
        useBoard.getState().failAsk(data?.reason ?? 'error');
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const handleFrame = (raw: string) => {
        const line = raw.split('\n').find((l) => l.startsWith('data: '));
        if (!line) return;
        let msg: {
          type?: string;
          text?: string;
          reason?: string;
          kept?: unknown;
          total?: unknown;
        };
        try {
          msg = JSON.parse(line.slice(6));
        } catch {
          return;
        }
        if (msg.type === 'delta' && typeof msg.text === 'string') {
          useBoard.getState().receiveAskDelta(msg.text);
        } else if (msg.type === 'done') {
          // The route is the authority on what was sent, so it owns the
          // "answered from N of M cards" counts. Only an honest truncation
          // is a note; kept === total is silence.
          const ctx =
            typeof msg.kept === 'number' && typeof msg.total === 'number' && msg.kept < msg.total
              ? { kept: msg.kept, total: msg.total }
              : null;
          useBoard.getState().finishAsk(fp, ctx);
        } else if (msg.type === 'error') {
          useBoard.getState().failAsk(msg.reason ?? 'error');
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
      if (after.boardId === id && after.askStatus === 'streaming') {
        after.failAsk('error');
      }
    } catch {
      // An abort is this panel closing or the board switching — not a failure.
      if (!ac.signal.aborted) useBoard.getState().failAsk('error');
    }
  }, []);

  /* Unmounting — closing the panel, or a board switch closing it — cancels:
   * abort the fetch and mark the in-flight turn cancelled, so the next
   * opening offers a clean input rather than a hanging answer. */
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      useBoard.getState().cancelAsk();
    };
  }, []);

  /* Esc closes — same dismissibility as everything else the AI shows. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useBoard.getState().setAskOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /**
   * A citation chip's whole job: put the card on screen. The find bar's
   * reveal, with one Ask-specific rule — a folded or binned card is not drawn
   * on the canvas, so it must be peeked back first (the Done bin's ▸) and
   * measured with `viewRect`, or the chip selects something the canvas cannot
   * show. The camera moves only when the card is not already fully visible:
   * viewport changes are hard cuts everywhere in this app, and the zoom is
   * never touched.
   */
  const reveal = (id: NodeId) => {
    const s = useBoard.getState();
    const node = s.board.nodes.find((n) => n.id === id);
    if (!node) return;
    if (cardView(node, s.collapseMode, new Set(s.expandedIds))) s.toggleExpanded(id);
    const after = useBoard.getState();
    const fresh = after.board.nodes.find((n) => n.id === id);
    if (!fresh) return;
    after.select(id);
    const rect = viewRect(fresh, cardView(fresh, after.collapseMode, new Set(after.expandedIds)));
    if (!containsRect(visibleRect(after.viewport, after.surface), rect)) {
      after.setViewport(centerOn(rect, after.surface, after.viewport.scale));
    }
  };

  const send = () => {
    const q = clampQuestion(question);
    if (!q || status === 'streaming') return;
    setQuestion('');
    void ask(q);
  };

  const canAnswer = loaded && canAsk(board);
  const validIds = board.nodes.map((n) => n.id);
  const stale = status === 'done' && cachedFp !== null && cachedFp !== fingerprint(board);
  const chipLabel = (id: NodeId) => {
    const node = board.nodes.find((n) => n.id === id);
    const text = node ? stripMarks(node.text).replace(/\s+/g, ' ').trim() : id;
    return text.length > 40 ? `${text.slice(0, 40)}…` : text;
  };

  return (
    <aside className="ask" aria-label="Ask about this board">
      <div className="ask-head">
        <span className="ask-title">Ask</span>
        <button className="ask-x" title="Close (Esc)" onClick={() => setAskOpen(false)}>
          ×
        </button>
      </div>

      <div className="ask-body">
        {turns.length === 0 && status === 'idle' ? (
          <p className="ask-note">
            {board.privacy
              ? 'Privacy Mode is on for this board. Nothing here is sent to a model — turn it off (⌘⇧P) to ask.'
              : canAnswer
                ? 'Questions about this board, answered from what is on it. Nothing is added or changed.'
                : 'Nothing to read yet. Put one idea on the board first.'}
          </p>
        ) : null}

        {status === 'no_key' ? (
          <div className="ask-note">
            <p>No model configured. The board works without one — Ask needs a provider.</p>
            <button className="ask-go" onClick={() => useBoard.getState().setSettingsOpen(true)}>
              Choose a model
            </button>
          </div>
        ) : null}

        {/* The route refused because the board is private — possible even from
            a clean state if another tab turned it on. */}
        {status === 'private' ? (
          <p className="ask-note">
            Privacy Mode is on for this board. Nothing here is sent to a model.
          </p>
        ) : null}

        {status === 'too_thin' ? (
          <p className="ask-note">Nothing to read yet. Put one idea on the board first.</p>
        ) : null}

        {turns.length > 0 ? (
          <div className="ask-thread">
            {turns.map((turn) => (
              <div key={turn.id} className="ask-turn">
                <p className="ask-q">{turn.question}</p>
                <div className="ask-a">
                  {turn.answer
                    ? parseAnswer(turn.answer, validIds).map((seg, i) =>
                        seg.kind === 'cite' ? (
                          <button
                            key={i}
                            className="ask-cite"
                            title="Show this card"
                            onClick={() => reveal(seg.id)}
                          >
                            {chipLabel(seg.id)}
                          </button>
                        ) : (
                          <span key={i}>{seg.text}</span>
                        ),
                      )
                    : null}
                  {turn.status === 'streaming' && !turn.answer ? (
                    <span className="ask-thinking">thinking…</span>
                  ) : null}
                  {turn.status === 'cancelled' ? (
                    <span className="ask-note">cancelled — ask again</span>
                  ) : null}
                  {turn.status === 'error' ? (
                    <span className="ask-note">no answer — the run failed</span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="ask-foot">
        {stale ? <span className="ask-note">the board has changed since this</span> : null}
        {context ? (
          <span className="ask-note">answered from {context.kept} of {context.total} cards</span>
        ) : null}
        <textarea
          ref={inputRef}
          className="ask-input"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          maxLength={QUESTION_MAX}
          placeholder={
            canAnswer ? 'Ask about this board…' : 'Put one idea on the board first'
          }
          disabled={!canAnswer || status === 'streaming'}
          rows={2}
          autoFocus
        />
        <div className="ask-row">
          <span className="ask-hint">
            {status === 'streaming'
              ? 'answering…'
              : 'Enter to ask — answers cite cards you can click'}
          </span>
          <button
            className="ask-send"
            onClick={send}
            disabled={!canAnswer || status === 'streaming' || !clampQuestion(question)}
          >
            Ask
          </button>
        </div>
      </div>
    </aside>
  );
}
