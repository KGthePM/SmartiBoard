'use client';

import type { Board } from '@/lib/graph';
import { viewRect, type CollapseView } from '@/lib/collapse';
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
  const center = (id: string) => {
    const n = board.nodes.find((x) => x.id === id);
    if (!n) return null;
    // What the card occupies, not what the node stores: a line into the middle
    // of a folded card's former height points at bare canvas, and the × rides
    // that same midpoint.
    const r = viewRect(n, views.get(n.id));
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  };

  return (
    <svg
      style={{ position: 'absolute', overflow: 'visible', pointerEvents: 'none', left: 0, top: 0 }}
      width={1}
      height={1}
    >
      {board.edges.map((e) => {
        const a = center(e.from);
        const b = center(e.to);
        if (!a || !b) return null;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
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
            <g
              className="edge-x"
              onPointerDown={(ev) => {
                ev.stopPropagation();
                onDeleteEdge(e.id);
              }}
            >
              <circle cx={mid.x} cy={mid.y} r={8} />
              <path
                d={`M${mid.x - 3.5} ${mid.y - 3.5} L${mid.x + 3.5} ${mid.y + 3.5} M${mid.x + 3.5} ${mid.y - 3.5} L${mid.x - 3.5} ${mid.y + 3.5}`}
              />
            </g>
          </g>
        );
      })}

      {/* Proposed links are dashed, like the ghost card — same authorship layer. */}
      {proposal
        ? proposal.anchors.map((a) => {
            const from = center(a);
            const to =
              proposal.kind === 'connection' && proposal.connectTo
                ? center(proposal.connectTo)
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
