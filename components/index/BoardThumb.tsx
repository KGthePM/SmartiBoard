import type { Thumb } from '@/lib/boards';

/** The SVG user space. Coordinates arrive as 0..1 and are scaled into it. */
const VB = 100;

/**
 * A minimap of the board's actual graph. Boards are recognized by shape long
 * before they're recognized by name, so this is navigation, not decoration —
 * it earns its place the way the layer legend does.
 */
export function BoardThumb({ thumb }: { thumb: Thumb }) {
  if (thumb.nodes.length === 0) {
    return <div className="thumb thumb-empty" aria-hidden />;
  }

  return (
    <svg className="thumb" viewBox={`0 0 ${VB} ${VB}`} aria-hidden focusable="false">
      {thumb.edges.map((e) => (
        <line
          key={e.id}
          className={`t-edge ${e.layer === 'accepted' ? 't-accepted' : ''}`}
          x1={e.x1 * VB}
          y1={e.y1 * VB}
          x2={e.x2 * VB}
          y2={e.y2 * VB}
        />
      ))}
      {thumb.nodes.map((n) => (
        <rect
          key={n.id}
          className={`t-node ${n.layer === 'accepted' ? 't-accepted' : ''}`}
          x={n.x * VB}
          y={n.y * VB}
          // Floors keep a card from vanishing on a very spread-out board.
          width={Math.max(n.w * VB, 3)}
          height={Math.max(n.h * VB, 2)}
          rx={1.5}
        />
      ))}
    </svg>
  );
}
