import type { NodeId } from './graph';

/**
 * An AI proposal. Deliberately NOT an IdeaNode: proposals live in their own
 * store slice so there is no code path that can silently merge one into the
 * user's board. Accepting one constructs a fresh node; that is the only bridge.
 */
export type Proposal = {
  id: string;
  kind: 'gap_fill' | 'connection';
  /** For gap_fill: the proposed idea. For connection: a label for the link. */
  text: string;
  /** Existing nodes this proposal relates to. Drives placement. */
  anchors: NodeId[];
  /** For connection proposals: the other end of the proposed edge. */
  connectTo?: NodeId;
  /** One sentence explaining why. Shown on hover — the trust surface. */
  rationale: string;
  /** Computed client-side by lib/placement.ts. The model never picks coordinates. */
  x: number;
  y: number;
};

/** What the model returns, before the client places it. */
export type ProposalDraft = Omit<Proposal, 'id' | 'x' | 'y'>;
