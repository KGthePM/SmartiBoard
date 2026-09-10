import type { Board } from '../graph';
import { estTokens } from '../importgraph';
import { stripMarks } from '../richtext';
import { clampQuestion } from './ask';
import { serializeBoardContent } from './prompt';

/**
 * Ask (v5.4): questions about a board, answered read-only. The third
 * user-invoked behavior, and the one that exists because of folder imports —
 * a board holding 300+ AI-written cards the person has never read makes
 * "where does auth happen?" an honest question rather than a lazy one.
 *
 * Deliberately NOT `SYSTEM_PROMPT` or `IDEAS_SYSTEM_PROMPT: both are written
 * for early-stage ideation (risks, segments, success metrics) and pointed at a
 * folder map will ask what the success metric for `src/lib` is. This prompt's
 * rules are the line that keeps Ask read-only in the model's own view, not
 * only in the UI — grounded in the board, not inventing facts the board
 * doesn't have, and (v5.7) never claiming to have written to a board it has
 * no way to touch.
 */
export const ASK_SYSTEM_PROMPT = `You are answering questions about someone's idea board.

The board is a graph. Each node is one idea, file, or summary in their words (or in the words
of an assistant that summarized it); each edge is a loose relationship. Cards are listed with
an id, and that id is how you point at one.

Ground your answer in what is on the board, but don't just recite it back. Compare cards,
name the pattern connecting them, say what a set of cards implies together — that reasoning
is the point of asking instead of reading the board yourself. The one thing to avoid is
inventing facts the board doesn't contain: when it doesn't say enough to answer, say that
plainly — "the board doesn't say" is a complete and useful answer, and a fact invented to
fill the gap is the one real failure here.

Cite as you go: when a claim rests on a card, mark it as [[nodeId]] inline. The person reads
these as clickable links to the card, so cite the card that carries the fact, not every card
that mentions the topic. A conclusion drawn from several cards can cite all of them; an
answer with no citations is fine when none rest on a card.

Stick to describing what's on the board unless they actually ask for your take — volunteering
"you should add X" unprompted is a different feature's job, not something to bring up here.
But if someone directly asks what you'd suggest, what's missing, or what you'd do
differently, answer as yourself: give an opinion, grounded in what's actually on the board,
and say plainly that it's your read rather than something a card already says. You have no
way to put anything on the board yourself, so never claim you added or changed something —
if they want it made real, that's the Ideas panel (⌘.) or their own hand.

Keep answers short enough to read: a few sentences, or a short list when the question asks
for one. Write prose, not JSON, not markdown fences.`;

/** Prose with room to breathe; a longer answer than this is a worse answer. */
export const ASK_MAX_TOKENS = 1200;

/**
 * The whole-board ceiling. Ask serializes the entire board on every question,
 * so a folder map needs a stop: past this the walk in `fitMaxNodes` stops
 * adding cards and the serializer says how many it dropped, which the panel
 * owes the person too ("answered from N of M cards").
 */
export const ASK_MAX_CONTEXT_TOKENS = 40_000;

/** How many prior turns ride along. Short thread, short memory. */
export const ASK_HISTORY_TURNS = 3;
/** A replayed answer is trimmed, not skipped: follow-ups usually point at the tail. */
export const HISTORY_ANSWER_MAX = 600;

/** One replayed Q/A pair. The shape the store's turns reduce to for the wire. */
export type AskHistoryTurn = { question: string; answer: string };

/**
 * The board is serialized once per request; only Q/A text accumulates with
 * turns. Everything here is untrusted on the way in (a client is only a
 * client): turns are capped and both halves trimmed, so a crafted history
 * cannot smuggle a novel into the context through the replay path.
 */
export function fitHistory(history: AskHistoryTurn[]): AskHistoryTurn[] {
  return history.slice(-ASK_HISTORY_TURNS).map((t) => ({
    question: clampQuestion(String(t.question ?? '')),
    answer: String(t.answer ?? '').slice(0, HISTORY_ANSWER_MAX),
  }));
}

/**
 * The answer's context ceiling → the `maxNodes` the serializer understands.
 * Walks substantive nodes in board order (the serializer's own order, so the
 * two agree on which cards "the first N" are), estimating each node line at
 * its id + layer + collapsed text. Edge lines rendered by id (`edgesById`) are
 * the entire reason this budget works at folder scale, and their cost is
 * reserved up front from the true upper bound — every edge — so the node walk
 * can spend the rest without overrunning.
 *
 * Returns null when the whole board fits: no truncation, no disclosure line,
 * byte-identical to an unscoped view of the board.
 */
export function fitMaxNodes(board: Board): number | null {
  const edgeReserve = board.edges.reduce(
    (sum, e) => sum + estTokens(`${e.from} — ${e.to}`.length + 2),
    0,
  );
  const budget = ASK_MAX_CONTEXT_TOKENS - edgeReserve;
  let total = 0;
  let count = 0;
  for (const n of board.nodes) {
    const plain = stripMarks(n.text).replace(/\s+/g, ' ').trim();
    if (!plain) continue;
    total += estTokens(`${n.id} [${n.layer}${n.done ? ', done' : ''}]: ${plain}`.length + 2);
    if (total > budget) return count;
    count += 1;
  }
  return null;
}

/**
 * The user turn: the board as the model sees it, then the question. The board
 * arrives already scoped (`scopeBoard` in ./ask.ts runs first — selection
 * narrowing is composition, not an option). Reuses `serializeBoardContent` —
 * one model's-eye view shared by every behavior — with the scale knobs the
 * serializer gained for exactly this caller: `edgesById` (a folder map's
 * import graph is unaffordable rendered as text) and `maxNodes` (the walk
 * above). Returns the instruction plus the card counts the panel's
 * "answered from N of M cards" note needs — the route is the authority on
 * what was sent, so it hands the counts back on the done frame.
 */
export function askInstruction(
  board: Board,
  question: string,
): { instruction: string; kept: number; total: number } {
  const maxNodes = fitMaxNodes(board);
  const instruction = serializeBoardContent(board, {
    edgesById: true,
    ...(maxNodes === null ? {} : { maxNodes }),
  });

  // The disclosure the serializer appended is for the model; the panel needs
  // its own copy, in card counts, for the "answered from N of M" note.
  const total = board.nodes.filter(
    (n) => stripMarks(n.text).replace(/\s+/g, ' ').trim().length > 0,
  ).length;
  const kept = maxNodes === null ? total : Math.min(total, maxNodes);

  return {
    instruction: `${instruction}\n\nQuestion about this board: ${clampQuestion(question)}`,
    kept,
    total,
  };
}
