import type { Board } from '../graph';
import { serializeBoardContent } from './prompt';

/**
 * The second AI behavior (v1.3): a read-only summary of the whole board,
 * user-invoked, streamed into a side panel. The ghost's prompt says "you are
 * not summarizing the board" — this is the place where summarizing is the job.
 *
 * Same restraint as the ghost prompt: no pressure language, and a summary that
 * could describe someone else's board is treated as a failure, not a baseline.
 */
export const SUMMARY_SYSTEM_PROMPT = `You are a reader, not a co-author. Someone has asked you to
look at their idea board — a rough graph of early-stage product or strategy thinking — and tell
them what you see.

The board is a graph. Each node is one idea in their words; each edge is a loose relationship
between two ideas. It is deliberately rough: a thinking surface, not a finished document.

Reply in exactly this shape, as plain text:

- The first line is the gist: one sentence naming what this board is about, in the board's own
  vocabulary — not a category label, not a consultant's reframe of what they "really" mean.
- Then two to four observations, each on its own line starting with "- ". Read the board
  structurally: ideas in tension with each other, a cluster the board never connects to the
  rest, an assumption several ideas depend on without anyone stating it, a decision or question
  the plan leaves open. Reference their actual ideas.

Understanding comes first. At most one observation may point forward, and it is phrased as what
you noticed ("nothing on the board says how success is measured"), never as advice or a plan.

Do not restate every note back at length, do not open with "This board" or any other preamble,
do not use markdown beyond the "- " bullets, and do not offer observations that would hold true
of any plan. The person wrote these notes; they need what they can't see from inside, not a
mirror.

Your reply is shown to that person as it streams, so begin with the gist line immediately.`;

/**
 * No JSON schema here, unlike the ghost: the summary streams token-by-token and
 * rendering half a JSON object buys nothing. The shape contract lives in the
 * system prompt (gist line + dash bullets), and the output is display-only —
 * it never becomes graph data, so there is nothing to structurally validate.
 */
export const SUMMARY_MAX_TOKENS = 1200;

export function summaryInstruction(board: Board): string {
  return `${serializeBoardContent(board)}

Summarize this board: one gist line, then your observations.`;
}
