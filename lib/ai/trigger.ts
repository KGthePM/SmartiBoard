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
/**
 * The ghost's frequency setting (v2.1): how long the board must sit still
 * before the ghost may speak, as the user chose it in Settings. The default is
 * DEBOUNCE_MS, so an untouched install behaves exactly as it always did. The
 * ghost is not on a wall-clock schedule — it fires once per material change,
 * never "every N minutes" on an untouched board — so this window is the only
 * honest meaning "how often" can have.
 */
export const GHOST_DELAY_STEPS_MS = [4000, 10000, 30000, 60000] as const;
/** The Off rung: the ghost never appears unsolicited. The Ideas button is the
 * user-invoked behavior and is untouched by it. */
export const GHOST_DELAY_OFF = 0;
/**
 * Snap any value to a legal rung. Junk, absence, and off-ladder numbers all
 * land on the default — a bad row in the database or a stale client's PUT must
 * never turn the ghost off or wedge it at a strange interval. Shared by the
 * route (write side) and loadSettings (read side) so the two cannot disagree.
 */
export function normalizeGhostDelay(v: unknown): number {
  return typeof v === 'number' &&
    (v === GHOST_DELAY_OFF || (GHOST_DELAY_STEPS_MS as readonly number[]).includes(v))
    ? v
    : DEBOUNCE_MS;
}
/**
 * How long to wait after a request that never came back with an answer.
 *
 * A failed request says nothing about the board, so the fingerprint is released
 * and the same board may be asked about again — but the canvas ticks once a
 * second, and a provider that is down would be hammered at that rate. One
 * attempt every half-minute is the compromise: a blip costs a cycle, an outage
 * costs almost nothing.
 */
export const FAILURE_COOLDOWN_MS = 30_000;
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
  /** When the last request failed to produce an answer, or null. */
  failedAt: number | null;
};

export type TriggerDecision =
  | { fire: true; fingerprint: string }
  | { fire: false; reason: TriggerBlockReason };

export type TriggerBlockReason =
  | 'privacy'
  | 'disabled'
  | 'in_flight'
  | 'cooling_down'
  | 'proposal_limit'
  | 'too_few_nodes'
  | 'debouncing'
  | 'no_material_change';

/** The user-facing knobs for shouldRequest. Absent means installed defaults. */
export type TriggerOptions = {
  /** The Settings row's ghost window: a GHOST_DELAY_STEPS_MS rung, or
   * GHOST_DELAY_OFF. Absent defaults to DEBOUNCE_MS. */
  ghostDelayMs?: number;
};

/**
 * Semantic fingerprint of the board.
 *
 * Deliberately excludes x/y: dragging a node rearranges the picture but does
 * not change what the board *says*, so it must never spend a token. Text and
 * topology are what the model reasons about, so those are what we hash — and
 * text is stripped of formatting markers for the same reason: bolding a word
 * is presentation, not a new idea. Done is the exception among node state:
 * the model is told which ideas are finished, so crossing one off changes
 * what the board says and belongs here.
 *
 * The objective is here for the same reason and the title is not: the objective
 * leads the prompt, so rewriting it gives the model a genuinely different board
 * to reason about, while a rename changes nothing the model ever sees.
 */
export function fingerprint(board: Board): string {
  const nodes = board.nodes
    .map((n) => `${n.id}:${n.done ? '1' : '0'}:${stripMarks(n.text).trim()}`)
    .sort()
    .join('|');
  const edges = board.edges
    .map((e) => (e.from < e.to ? `${e.from}>${e.to}` : `${e.to}>${e.from}`))
    .sort()
    .join('|');
  return `${board.nodes.length}#${hash(`${board.objective.trim()}//${nodes}//${edges}`)}`;
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

/**
 * May the user-invoked idea generator run? (v2.0)
 *
 * Deliberately a lower floor than the ghost's MIN_NODES, and the only place the
 * two behaviors' policies differ. The ghost needs structure to reason about
 * because nobody asked it to speak; the generator was asked, and the moment it
 * is worth most is the one where the board is emptiest — an objective written
 * on a blank board used to leave the whole AI layer silent.
 *
 * Privacy Mode first, as in shouldRequest below, and for the same reason: a
 * private board is not one the AI is quiet on, it is one the AI is never told
 * about. This is still only the client's convenience — /ideas refuses on its own.
 */
export function canGenerateIdeas(board: Board): boolean {
  if (board.privacy) return false;
  return board.objective.trim().length > 0 || substantiveNodes(board).length > 0;
}

/**
 * May the Ask panel answer questions about this board? (v5.4)
 *
 * Deliberately NOT canGenerateIdeas, which admits a non-empty objective with
 * no cards: generating is worth most on an empty board, where the objective
 * is the only raw material. A *question* about a board with nothing on it has
 * no answer — Ask reads the board, so it needs at least one substantive card
 * to read. Privacy first, as everywhere, and gated in the same three places
 * the ideas floor is: the chrome button, the panel, and the route.
 */
export function canAsk(board: Board): boolean {
  if (board.privacy) return false;
  return substantiveNodes(board).length > 0;
}

export function shouldRequest(
  board: Board,
  state: TriggerState,
  now: number,
  opts: TriggerOptions = {},
): TriggerDecision {
  // Absolute, and therefore first: no state, no timing, and no fingerprint can
  // get past it. A private board is not one the AI is quiet on — it is one the
  // AI is never told about. This check is a convenience, though, not the
  // guarantee: the routes refuse on their own, because a client that stops
  // asking is only a client.
  if (board.privacy) return { fire: false, reason: 'privacy' };

  // The Off rung, second only to privacy: privacy is the answer to a different
  // question ("is this board's content egress allowed at all?"), while Off is
  // the user saying the unsolicited ghost specifically is not wanted — the
  // Ideas button still works, and a private board's reason must not read as a
  // mere preference. Everything below is mechanical and ranked under it.
  const delay = opts.ghostDelayMs ?? DEBOUNCE_MS;
  if (delay === GHOST_DELAY_OFF) return { fire: false, reason: 'disabled' };

  if (state.inFlight) return { fire: false, reason: 'in_flight' };

  if (state.failedAt !== null && now - state.failedAt < FAILURE_COOLDOWN_MS) {
    return { fire: false, reason: 'cooling_down' };
  }

  if (state.liveProposals >= MAX_LIVE_PROPOSALS) {
    return { fire: false, reason: 'proposal_limit' };
  }

  if (substantiveNodes(board).length < MIN_NODES) {
    return { fire: false, reason: 'too_few_nodes' };
  }

  if (now - state.lastMutationAt < delay) {
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
