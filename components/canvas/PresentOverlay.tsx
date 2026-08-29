'use client';

import { useEffect } from 'react';
import { boardTitle } from '@/lib/boards';
import { useBoard } from '@/lib/store';
import { ObjectivePanel } from '../ObjectivePanel';

/**
 * The presentation chrome. Mounted only while presenting, so it owns
 * everything mode-specific: the Fullscreen API handshake, the exit keys, and
 * the interface a room needs — the board's name, a way out, and the objective.
 * The objective is the one editable thing in the mode: the canvas behind this
 * is read-only by CSS (see `.presenting` in the stylesheet), but the objective
 * is board framing rather than canvas content, and a room rewriting it
 * mid-meeting is plain `setObjective` — snapshotted, bumped, and autosaved
 * exactly as it is outside the mode.
 */
export function PresentOverlay() {
  const board = useBoard((s) => s.board);
  const objectiveOpen = useBoard((s) => s.objectiveOpen);
  const hasObjective = useBoard((s) => s.board.objective.trim().length > 0);

  useEffect(() => {
    // Browser fullscreen is the point of the mode on a projector: no tabs, no
    // address bar. The request rides the same user gesture that flipped the
    // flag (the Present button or ⌘⇧F), and a refusal — or an old browser
    // without the API — degrades to in-page presentation, which is still the
    // whole feature minus the missing browser chrome.
    void document.documentElement.requestFullscreen?.().catch(() => {});

    const onFsChange = () => {
      // The reliable Escape path: in browser fullscreen the browser owns
      // Escape (Chrome consumes the keydown exiting FS, so the page never
      // hears it), but the exit itself lands here — and a room that took the
      // browser out of fullscreen is done presenting.
      if (!document.fullscreenElement) useBoard.getState().setPresenting(false);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Only ours to answer when the browser is not holding it for
        // fullscreen exit — that case is covered by onFsChange above — and
        // when the objective panel has it. This listener registered first,
        // so without the guard one Escape would close the panel and end the
        // presentation with it; the panel's own handler does the closing.
        if (!document.fullscreenElement && !useBoard.getState().objectiveOpen) {
          useBoard.getState().setPresenting(false);
        }
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        useBoard.getState().setPresenting(false);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        // ⌘J survives the chrome's unmount: a room mid-meeting is exactly
        // when the framing gets rewritten. The panel renders below, from the
        // same store flag the chrome uses — so an exit while it is open
        // hands it to the chrome without dropping the edit session.
        e.preventDefault();
        useBoard.getState().setObjectiveOpen(!useBoard.getState().objectiveOpen);
      }
    };

    document.addEventListener('fullscreenchange', onFsChange);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      window.removeEventListener('keydown', onKey);
      // Leaving presentation leaves browser fullscreen behind too — which
      // makes the board-switch and unmount paths simple: flip the flag, and
      // this cleanup does the rest.
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    };
  }, []);

  return (
    <>
      <div className="present-bar">
        <span className="present-title">{boardTitle(board)}</span>
        <button
          className="present-objective"
          // Always enabled, like its chrome twin: writing the objective with
          // the room watching is half of what the button is for.
          title={hasObjective ? 'Board objective (⌘J)' : 'Set a board objective (⌘J)'}
          onClick={() => useBoard.getState().setObjectiveOpen(!useBoard.getState().objectiveOpen)}
        >
          {hasObjective ? '●' : '○'} Objective
        </button>
        <button
          className="present-exit"
          title="Exit presentation (Esc)"
          onClick={() => useBoard.getState().setPresenting(false)}
        >
          Exit
        </button>
      </div>

      {objectiveOpen ? (
        <ObjectivePanel onClose={() => useBoard.getState().setObjectiveOpen(false)} />
      ) : null}
    </>
  );
}
