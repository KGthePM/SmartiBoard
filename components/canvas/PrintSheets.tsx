'use client';

import { boardTitle } from '@/lib/boards';
import type { Board, IdeaNode } from '@/lib/graph';
import { PRINT_HEADER_H, PRINT_PAGE_H, PRINT_PAGE_W, printPlan } from '@/lib/print';
import { EdgeLayer } from './EdgeLayer';
import { RichTextView } from './RichTextView';

/** One shared empty list, so every card's memo sees a stable prop. */
const NO_MATCHES: never[] = [];

/**
 * A card as paper sees it: the read view and nothing else. No handlers, no
 * affordances, never a textarea — the text it shows is the committed text,
 * which is current even mid-edit (typing writes to the store on every
 * keystroke; only the PUT is debounced). Layer and done styling ride the
 * same classes the canvas card uses, so paper and screen agree.
 */
function PrintCard({ node }: { node: IdeaNode }) {
  return (
    <div
      className={`card${node.layer === 'accepted' ? ' accepted' : ''}${node.done ? ' done' : ''}`}
      style={{ left: node.x, top: node.y, width: node.w, height: node.h, fontSize: node.fontSize }}
    >
      <div className="rt">
        <RichTextView text={node.text} matches={NO_MATCHES} activeMatch={null} />
      </div>
    </div>
  );
}

/**
 * The printed board (v2.5). One sheet per window of the print plan, each a
 * full page: the first carries the board's name in a short bar, and every
 * sheet holds a translated, scaled copy of the same read-only board, clipped
 * to its window by the sheet itself. Mounted only for the duration of a
 * print (Board's beforeprint listener) — on screen this tree is display:none
 * by the stylesheet, and under @media print it is the only thing visible.
 *
 * The pending proposal never prints: it lives in store.proposal, not
 * board.nodes, and EdgeLayer is handed null for it — the same ruling
 * presentation mode makes. A proposal is not content.
 */
export function PrintSheets({ board }: { board: Board }) {
  const plan = printPlan(board.nodes);
  return (
    <div className="print-root">
      {plan.windows.map((win) => (
        <div
          key={`${win.col}:${win.row}`}
          className="print-sheet"
          style={{ width: PRINT_PAGE_W, height: PRINT_PAGE_H }}
        >
          {win.row === 0 && win.col === 0 ? (
            <div className="print-name" style={{ height: PRINT_HEADER_H }}>
              {boardTitle(board)}
            </div>
          ) : null}
          <div className="print-window">
            <div
              className="print-world"
              style={{
                transform: `translate(${-win.x * plan.scale}px, ${-win.y * plan.scale}px) scale(${plan.scale})`,
              }}
            >
              <EdgeLayer
                board={board}
                proposal={null}
                pending={null}
                selectedEdgeId={null}
                onSelectEdge={() => {
                  /* Paper is not interactive. */
                }}
                onDeleteEdge={() => {
                  /* Paper is not interactive. */
                }}
              />
              {board.nodes.map((n) => (
                <PrintCard key={n.id} node={n} />
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
