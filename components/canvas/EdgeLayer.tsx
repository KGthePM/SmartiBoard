'use client';

import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Board, Edge } from '@/lib/graph';
import { isBinned, viewRect, type CollapseView } from '@/lib/collapse';
import type { Proposal } from '@/lib/proposal';

type Props = {
  board: Board;
  /** How each folded card is drawn right now (v2.8). Derived in Board. */
  views: ReadonlyMap<string, CollapseView>;
  proposal: Proposal | null;
  /** In-progress connection drag, in board coordinates. */
  pending: { from: { x: number; y: number }; to: { x: number; y: number } } | null;
  selectedEdgeId: string | null;
  onSelectEdge: (id: string) => void;
  onDeleteEdge: (id: string) => void;
};

type Pt = { x: number; y: number };

/** Card-center math shared by both layers, so they can never disagree about
 * where a line ends or where its × rides. */
function centerOf(board: Board, views: ReadonlyMap<string, CollapseView>, id: string): Pt | null {
  const n = board.nodes.find((x) => x.id === id);
  if (!n) return null;
  // A binned card is not on the board, so neither is the line that meets it.
  // The same answer as a missing node, and for the same reason: there is
  // nothing here to draw to. The edge is not deleted — peek the card back and
  // its lines come with it.
  if (isBinned(views.get(n.id))) return null;
  // What the card occupies, not what the node stores: a line into the middle
  // of a folded card's former height points at bare canvas, and the × rides
  // that same midpoint.
  const r = viewRect(n, views.get(n.id));
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Endpoints and their midpoint for one edge, or null when either end is
 * missing or binned — there is nothing to draw to. */
function edgeGeometry(
  board: Board,
  views: ReadonlyMap<string, CollapseView>,
  e: Edge,
): { a: Pt; b: Pt; mid: Pt } | null {
  const a = centerOf(board, views, e.from);
  const b = centerOf(board, views, e.to);
  if (!a || !b) return null;
  return { a, b, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

/** The × glyph, drawn identically wherever it renders — beneath the cards on
 * hover, above them when selected. One definition so the two cannot drift. */
function edgeX(mid: Pt, onPointerDown: (ev: ReactPointerEvent) => void) {
  return (
    <g className="edge-x" onPointerDown={onPointerDown}>
      <circle cx={mid.x} cy={mid.y} r={8} />
      <path
        d={`M${mid.x - 3.5} ${mid.y - 3.5} L${mid.x + 3.5} ${mid.y + 3.5} M${mid.x + 3.5} ${mid.y - 3.5} L${mid.x - 3.5} ${mid.y + 3.5}`}
      />
    </g>
  );
}

/**
 * Edges render beneath the cards. The SVG is unbounded and lives inside the
 * transformed world container, so it pans and zooms with everything else.
 *
 * The root svg ignores pointers so the empty canvas still pans; each real
 * edge re-enables them on its own hit stroke, which is far wider than the
 * visible line. Ghost and pending lines stay untouchable — they are not
 * board content.
 */
export function EdgeLayer({
  board,
  views,
  proposal,
  pending,
  selectedEdgeId,
  onSelectEdge,
  onDeleteEdge,
}: Props) {
  return (
    <svg
      style={{ position: 'absolute', overflow: 'visible', pointerEvents: 'none', left: 0, top: 0 }}
      width={1}
      height={1}
    >
      {board.edges.map((e) => {
        const g = edgeGeometry(board, views, e);
        if (!g) return null;
        const { a, b, mid } = g;
        const selected = selectedEdgeId === e.id;
        return (
          <g
            key={e.id}
            className={`edge${e.layer === 'accepted' ? ' accepted' : ''}${selected ? ' selected' : ''}`}
          >
            <line className="edge-line" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
            <line
              className="edge-hit"
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              onPointerDown={(ev) => {
                ev.stopPropagation();
                onSelectEdge(e.id);
              }}
            />
            {/* The selected edge's × is lifted into SelectedEdgeX above the
                cards — here it could sit under a covering card, invisible and
                unclickable. Hover keeps this copy: it is CSS-gated below the
                cards, and an uncovered midpoint never had the problem. */}
            {!selected
              ? edgeX(mid, (ev) => {
                  ev.stopPropagation();
                  onDeleteEdge(e.id);
                })
              : null}
          </g>
        );
      })}

      {/* Proposed links are dashed, like the ghost card — same authorship layer. */}
      {proposal
        ? proposal.anchors.map((a) => {
            const from = centerOf(board, views, a);
            const to =
              proposal.kind === 'connection' && proposal.connectTo
                ? centerOf(board, views, proposal.connectTo)
                : { x: proposal.x + 100, y: proposal.y + 48 };
            if (!from || !to) return null;
            return (
              <line
                key={`ghost-${a}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke="var(--ghost-border)"
                strokeWidth={1.5}
                strokeDasharray="5 4"
                opacity={0.8}
              />
            );
          })
        : null}

      {pending ? (
        <line
          x1={pending.from.x}
          y1={pending.from.y}
          x2={pending.to.x}
          y2={pending.to.y}
          stroke="var(--ink)"
          strokeWidth={1.5}
          strokeDasharray="4 4"
        />
      ) : null}
    </svg>
  );
}

type SelectedEdgeXProps = {
  board: Board;
  /** How each folded card is drawn right now — same map EdgeLayer sees. */
  views: ReadonlyMap<string, CollapseView>;
  selectedEdgeId: string | null;
  onDeleteEdge: (id: string) => void;
};

/**
 * The selected edge's ×, rendered ABOVE the cards. EdgeLayer rides beneath
 * them, so a card covering the line's midpoint covered the × too — invisible,
 * and unclickable because the card took the pointer. Clicking a line is the
 * explicit act, so the selected × is lifted wholesale; hover stays beneath
 * the cards, where an uncovered midpoint never had the problem.
 *
 * The wrapper carries `edge selected` and the glyph carries `edge-x`, so
 * every existing rule applies unchanged — visibility, the ink ring, the
 * coarse-pointer radius, presenting, print. No layer-specific CSS exists.
 */
export function SelectedEdgeX({
  board,
  views,
  selectedEdgeId,
  onDeleteEdge,
}: SelectedEdgeXProps) {
  const e = board.edges.find((x) => x.id === selectedEdgeId);
  if (!e) return null;
  const g = edgeGeometry(board, views, e);
  if (!g) return null;
  return (
    <svg
      style={{ position: 'absolute', overflow: 'visible', pointerEvents: 'none', left: 0, top: 0 }}
      width={1}
      height={1}
    >
      <g className="edge selected">
        {edgeX(g.mid, (ev) => {
          ev.stopPropagation();
          onDeleteEdge(e.id);
        })}
      </g>
    </svg>
  );
}
