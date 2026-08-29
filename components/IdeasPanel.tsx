'use client';

import { useCallback, useEffect, useRef } from 'react';
import { canGenerateIdeas, fingerprint } from '@/lib/ai/trigger';
import type { IdeaDraft } from '@/lib/ai/ideas';
import { stripMarks } from '@/lib/richtext';
import { useBoard } from '@/lib/store';
import type { NodeId } from '@/lib/graph';

/**
 * The ideas drawer (v2.0), replacing the summary panel. The one place the
 * product answers on demand, as opposed to the ghost that interjects on its
 * own policy.
 *
 * The list is a staging area, not a third layer on the canvas: generated ideas
 * never render on the board, so the one-live-ghost ceiling is untouched, and
 * the only way anything crosses over is a person clicking Add.
 *
 * Lifecycle rules that matter, all inherited from the summary panel because
 * they were the hard part:
 *  - Opening the panel is NOT the invocation. It shows the list cached for the
 *    current fingerprint if one is fresh, and a launch button otherwise — no
 *    token is spent without a click. (Which also keeps the panel trivially
 *    StrictMode-safe: nothing fires on mount, so React's dev-only double mount
 *    has nothing to abort.)
 *  - Closing the panel (or switching boards — `beginLoad` closes it) aborts the
 *    fetch and cancels an in-progress run back to idle, so a reopened panel
 *    offers the button instead of half a list. Frames are boardId-guarded, so a
 *    late idea can never land in the next board.
 */
export function IdeasPanel() {
  const board = useBoard((s) => s.board);
  const loaded = useBoard((s) => s.loaded);
  const ideas = useBoard((s) => s.ideas);
  const status = useBoard((s) => s.ideasStatus);
  const cachedFp = useBoard((s) => s.ideasFingerprint);
  const seedId = useBoard((s) => s.ideasSeedId);
  // Branching needs exactly one card — a multi-selection has no single branch
  // point, so it reads as the whole board.
  const selectedId = useBoard((s) => (s.selectedIds.length === 1 ? s.selectedIds[0] : null));
  const setIdeasOpen = useBoard((s) => s.setIdeasOpen);

  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async (seed: NodeId | null) => {
    const start = useBoard.getState();
    const id = start.boardId;
    const fp = fingerprint(start.board);

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    start.beginIdeas(seed);

    try {
      const res = await fetch(`/api/boards/${id}/ideas`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ board: start.board, seedId: seed }),
        signal: ac.signal,
      });
      // A response for a board we already left must not touch this one.
      if (useBoard.getState().boardId !== id) return;

      // The refusals — no provider, privacy, nothing to read — answer plain
      // JSON, not SSE.
      const ctype = res.headers.get('content-type') ?? '';
      if (!res.ok || !ctype.includes('text/event-stream')) {
        const data = (await res.json().catch(() => null)) as { reason?: string } | null;
        useBoard.getState().failIdeas(data?.reason ?? 'error');
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const handleFrame = (raw: string) => {
        const line = raw.split('\n').find((l) => l.startsWith('data: '));
        if (!line) return;
        let msg: { type?: string; idea?: IdeaDraft; reason?: string };
        try {
          msg = JSON.parse(line.slice(6));
        } catch {
          return;
        }
        if (msg.type === 'idea' && msg.idea) {
          useBoard.getState().receiveIdea(msg.idea);
        } else if (msg.type === 'done') {
          useBoard.getState().finishIdeas(fp);
        } else if (msg.type === 'error') {
          useBoard.getState().failIdeas(msg.reason ?? 'error');
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
      if (after.boardId === id && after.ideasStatus === 'streaming') {
        after.failIdeas('error');
      }
    } catch {
      // An abort is this panel closing or the board switching — not a failure.
      if (!ac.signal.aborted) useBoard.getState().failIdeas('error');
    }
  }, []);

  /* Unmounting — closing the panel, or a board switch closing it — cancels:
   * abort the fetch and put an interrupted run back to idle, so the next
   * opening starts from the button, not half a list. */
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      useBoard.getState().cancelIdeas();
    };
  }, []);

  /* Esc closes — same dismissibility as everything else the AI shows. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useBoard.getState().setIdeasOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const stale = status === 'done' && cachedFp !== fingerprint(board);
  // Privacy Mode and the floor, in one predicate shared with the chrome button
  // and the route. Below it there is nothing to read and nothing to aim at.
  const canGenerate = loaded && canGenerateIdeas(board);

  const label = (id: NodeId | null) => {
    const node = id ? board.nodes.find((n) => n.id === id) : undefined;
    const text = node ? stripMarks(node.text).trim() : '';
    return text.length > 48 ? `${text.slice(0, 48)}…` : text;
  };
  const selectedLabel = label(selectedId);
  const seedLabel = label(seedId);

  return (
    <aside className="ideas" aria-label="Idea generator">
      <div className="ideas-head">
        <span className="ideas-title">Ideas</span>
        <button className="ideas-x" title="Close (Esc)" onClick={() => setIdeasOpen(false)}>
          ×
        </button>
      </div>

      {/* Which board — or which card — the list on screen came from. */}
      {status !== 'idle' && seedLabel ? (
        <p className="ideas-seed">branching from “{seedLabel}”</p>
      ) : null}

      <div className="ideas-body">
        {status === 'idle' ? (
          canGenerate ? (
            <>
              <button className="ideas-go" onClick={() => void run(selectedId)}>
                {selectedLabel ? 'Expand this idea' : 'Generate ideas'}
              </button>
              <p className="ideas-note">
                {selectedLabel
                  ? `Ideas that branch off “${selectedLabel}”. Select nothing to read the whole board instead.`
                  : 'Ideas for the whole board. Select a card first to branch off it instead.'}
              </p>
            </>
          ) : board.privacy ? (
            <p className="ideas-note">
              Privacy Mode is on for this board. Nothing here is sent to a model — turn it off
              (⌘⇧P) to ask for ideas.
            </p>
          ) : (
            <p className="ideas-note">
              Nothing to go on yet. Write an objective (⌘J) or put one idea on the board.
            </p>
          )
        ) : null}

        {status === 'no_key' ? (
          <div className="ideas-note">
            <p>No model configured. The board works without one — ideas need a provider.</p>
            <button className="ideas-go" onClick={() => useBoard.getState().setSettingsOpen(true)}>
              Choose a model
            </button>
          </div>
        ) : null}

        {/* The route refused because the board is private — which can happen
            even from a clean idle state if another tab turned it on. */}
        {status === 'private' ? (
          <p className="ideas-note">
            Privacy Mode is on for this board. Nothing here is sent to a model.
          </p>
        ) : null}

        {status === 'too_thin' ? (
          <p className="ideas-note">
            Nothing to go on yet. Write an objective (⌘J) or put one idea on the board.
          </p>
        ) : null}

        {status === 'streaming' && ideas.length === 0 ? (
          <p className="ideas-note">thinking…</p>
        ) : null}

        {ideas.length > 0 ? (
          <ul className="ideas-list">
            {ideas.map((idea) => (
              <li key={idea.id} className={`ideas-item${idea.added ? ' added' : ''}`}>
                <div className="ideas-item-text">{idea.text}</div>
                <div className="ideas-item-why">{idea.rationale}</div>
                <button
                  className="ideas-add"
                  disabled={idea.added}
                  title={idea.added ? 'On the board — ⌘Z to take it back' : 'Add to the board'}
                  onClick={() => useBoard.getState().addIdea(idea.id)}
                >
                  {idea.added ? 'Added' : 'Add'}
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {/* `done` with nothing in it is the same dead end as an error, and must
            not render as an empty panel. */}
        {(status === 'error' || status === 'done') && ideas.length === 0 ? (
          <p className="ideas-note">couldn&apos;t come up with anything for this board</p>
        ) : null}
      </div>

      {(status === 'done' || status === 'error') && canGenerate ? (
        <div className="ideas-foot">
          {stale ? <span className="ideas-note">the board has changed since these</span> : null}
          <button className="ideas-again" onClick={() => void run(seedId)}>
            {status === 'error' ? 'Retry' : 'More ideas'}
          </button>
        </div>
      ) : null}
    </aside>
  );
}
