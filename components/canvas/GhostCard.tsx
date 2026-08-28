'use client';

import { NODE_H, NODE_W } from '@/lib/graph';
import type { Proposal } from '@/lib/proposal';

type Props = {
  proposal: Proposal;
  onAccept: () => void;
  onDismiss: () => void;
};

/**
 * The AI layer. Visually distinct at a glance, non-destructive, and reversible
 * in one action — accept or dismiss, nothing in between and nothing implicit.
 */
export function GhostCard({ proposal, onAccept, onDismiss }: Props) {
  return (
    <div
      className="ghost"
      style={{ left: proposal.x, top: proposal.y, width: NODE_W, height: NODE_H }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="label">
        {proposal.kind === 'connection' ? 'suggested link' : 'suggested idea'}
      </div>
      <div>{proposal.text}</div>

      <div className="rationale">{proposal.rationale}</div>

      <div className="actions">
        <button className="accept" onClick={onAccept}>
          Accept
        </button>
        <button onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}
