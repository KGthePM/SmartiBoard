import type { Board, IdeaNode } from '../graph';
import { stripMarks } from '../richtext';

/**
 * When is the AI allowed to speak?
 *
 * The brief says the AI works "continuously". Continuously cannot mean
 * per-keystroke: that is expensive, and — worse — it is the difference between
 * a collaborator and a paperclip. Everything here is a pure function so the
 * policy can be tuned and tested without a network call.
 */

export const DEBOUNCE_MS = 4000;
/** Below this, there is no structure to reason about yet. */
export const MIN_NODES = 3;
/** A board with several live suggestions is worse than one with none. */
export const MAX_LIVE_PROPOSALS = 1;

export type TriggerState = {
  /** Timestamp of the last board mutation. */
  lastMutationAt: number;
  /** Fingerprint at the time of the last dispatched request. */
  lastRequestedFingerprint: string | null;
  /** Number of proposals currently on the canvas. */
  liveProposals: number;
  /** Is a suggest request already in flight? */
  inFlight: boolean;
};

export type TriggerDecision =
  | { fire: true; fingerprint: string }
  | { fire: false; reason: TriggerBlockReason };

export type TriggerBlockReason =
  | 'in_flight'
  | 'proposal_limit'
  | 'too_few_nodes'
  | 'debouncing'
  | 'no_material_change';

/**
 * Semantic fingerprint of the board.
 *
 * Deliberately excludes x/y: dragging a node rearranges the picture but does
 * not change what the board *says*, so it must never spend a token. Text and
 * topology are what the model reasons about, so those are what we hash — and
 * text is stripped of formatting markers for the same reason: bolding a word
 * is presentation, not a new idea.
 */
export function fingerprint(board: Board): string {
  const nodes = board.nodes
    .map((n) => `${n.id}:${stripMarks(n.text).trim()}`)
    .sort()
    .join('|');
  const edges = board.edges
    .map((e) => (e.from < e.to ? `${e.from}>${e.to}` : `${e.to}>${e.from}`))
    .sort()
    .join('|');
  return `${board.nodes.length}#${hash(`${nodes}//${edges}`)}`;
}

/**
 * Nodes that actually say something. Empty ones are placeholders the user hasn't
 * filled in yet — they don't count, and neither do markers with nothing human
 * written underneath them. Shared by both AI behaviors: the floor on when there
 * is anything to reason about is one policy, not two.
 */
export function substantiveNodes(board: Board): IdeaNode[] {
  return board.nodes.filter((n) => stripMarks(n.text).trim().length > 0);
}

export function shouldRequest(
  board: Board,
  state: TriggerState,
  now: number,
): TriggerDecision {
  if (state.inFlight) return { fire: false, reason: 'in_flight' };

  if (state.liveProposals >= MAX_LIVE_PROPOSALS) {
    return { fire: false, reason: 'proposal_limit' };
  }

  if (substantiveNodes(board).length < MIN_NODES) {
    return { fire: false, reason: 'too_few_nodes' };
  }

  if (now - state.lastMutationAt < DEBOUNCE_MS) {
    return { fire: false, reason: 'debouncing' };
  }

  const fp = fingerprint(board);
  if (fp === state.lastRequestedFingerprint) {
    return { fire: false, reason: 'no_material_change' };
  }

  return { fire: true, fingerprint: fp };
}

/** FNV-1a. Not cryptographic — we only need cheap change detection. */
function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
