'use client';

import { useEffect } from 'react';
import { boardTitle } from '@/lib/boards';
import { useBoard } from '@/lib/store';

/**
 * The presentation chrome. Mounted only while presenting, so it owns
 * everything mode-specific: the Fullscreen API handshake, the exit keys, and
 * the two words of interface a room needs — the board's name and a way out.
 * The canvas behind it is read-only by CSS (see `.presenting` in the
 * stylesheet); this is the only thing left to click.
 */
export function PresentOverlay() {
  const board = useBoard((s) => s.board);

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
        // fullscreen exit — that case is covered by onFsChange above.
        if (!document.fullscreenElement) useBoard.getState().setPresenting(false);
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        useBoard.getState().setPresenting(false);
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
    <div className="present-bar">
      <span className="present-title">{boardTitle(board)}</span>
      <button
        className="present-exit"
        title="Exit presentation (Esc)"
        onClick={() => useBoard.getState().setPresenting(false)}
      >
        Exit
      </button>
    </div>
  );
}
