'use client';

import { useEffect, useMemo } from 'react';
import { binnedNodes } from '@/lib/collapse';
import { REACTION_GLYPH } from '@/lib/reactions';
import { useBoard } from '@/lib/store';
import { RichTextView } from './canvas/RichTextView';
import { useSearchMatches, activeIndex } from './SearchPanel';

/**
 * The Done bin (v3.0): a drawer listing the cards the canvas is not drawing,
 * because the Completed-cards setting is on `bin`.
 *
 * It is a *view of the board*, not a container. Nothing here has been moved,
 * copied, archived or deleted — every card in this list is still a node at its
 * own coordinates with its own edges, and turning the setting back to full size
 * puts all of them back untouched. So the list is derived on every render
 * (`binnedNodes`) rather than stored, the way search matches are: a card that
 * changes underneath it has nothing to invalidate.
 *
 * The panel adds no way to change a board that the board did not already have.
 * Its two controls are the two that already existed:
 *  - ▸ is `toggleExpanded`, the same peek that opens a folded dot. The card
 *    comes back where it was, still crossed off, for this session only — a
 *    reload re-bins it, because `done` is the truth and a peek is only a look.
 *  - ✓ is `toggleNodeDone`, which is how a card leaves the bin for good. That
 *    one is content the model reads, so it keeps its own doctrine: an undo
 *    snapshot and a `lastMutationAt` bump, exactly as pressing D on the card.
 *
 * Everything else here spends nothing: no undo step, no redo spend, no
 * mutation stamp, never a token.
 */
export function DoneBinPanel() {
  const board = useBoard((s) => s.board);
  const collapseMode = useBoard((s) => s.collapseMode);
  const expandedIds = useBoard((s) => s.expandedIds);
  const setBinOpen = useBoard((s) => s.setBinOpen);

  const nodes = useMemo(
    () => binnedNodes(board.nodes, collapseMode, new Set(expandedIds)),
    [board.nodes, collapseMode, expandedIds],
  );

  /**
   * The find bar's ruling, one level up: a match the bar counts but the board
   * never shows reads as a bug, which is why a folded dot takes the highlight
   * on itself. A binned card is not on the board at all, so its hits are shown
   * here — the same `RichTextView` the canvas and the print sheet render.
   */
  const matches = useSearchMatches();
  const searchIndex = useBoard((s) => s.searchIndex);
  const at = activeIndex(matches, searchIndex);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setBinOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setBinOpen]);

  return (
    <aside className="bin" aria-label="Done bin">
      <div className="bin-head">
        <span className="bin-title">Done</span>
        <button className="bin-x" title="Close (Esc)" onClick={() => setBinOpen(false)}>
          ×
        </button>
      </div>

      <div className="bin-body">
        {nodes.length === 0 ? (
          <p className="bin-note">
            Nothing crossed off yet. Select a card and press <b>D</b> — it will come here instead of
            holding its place on the board.
          </p>
        ) : (
          <ul className="bin-list">
            {nodes.map((n) => {
              const mine = matches.filter((m) => m.target.kind === 'node' && m.target.id === n.id);
              const active = at >= 0 ? mine.indexOf(matches[at]) : -1;
              return (
                <li className={`bin-item${mine.length > 0 ? ' hit' : ''}`} key={n.id}>
                  <button
                    className="bin-undone"
                    title="Un-cross it — puts the card back on the board for good"
                    aria-label="Un-cross this card"
                    onClick={() => useBoard.getState().toggleNodeDone(n.id)}
                  >
                    ✓
                  </button>

                  <span className="bin-item-text">
                    <RichTextView
                      text={n.text}
                      matches={mine}
                      activeMatch={active >= 0 ? active : null}
                    />
                  </span>

                  {/* Chosen marks only — the print sheet's rule, and the stub's:
                      all five slots is about aiming at a hover target, which a
                      row in a list has no room for anyway. Inert here: the card
                      is where a reaction is placed. */}
                  {n.reactions.length > 0 ? (
                    <span className="bin-item-marks" aria-hidden="true">
                      {n.reactions.map((k) => REACTION_GLYPH[k]).join('')}
                    </span>
                  ) : null}

                  <button
                    className="bin-peek"
                    title="Show it on the board — until the next reload"
                    aria-label="Show this card on the board"
                    onClick={() => useBoard.getState().toggleExpanded(n.id)}
                  >
                    ▸
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="bin-foot">
        <span className="bin-note">
          Nothing here has moved. Set Completed cards back to full size and every one of them is
          where you left it.
        </span>
      </div>
    </aside>
  );
}
