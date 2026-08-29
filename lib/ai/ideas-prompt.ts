import type { Board, NodeId } from '../graph';
import { stripMarks } from '../richtext';
import { IDEAS_MAX } from './ideas';
import { serializeBoardContent } from './prompt';

/**
 * The user-invoked behavior (v2.0), replacing the board summary: a short list
 * of candidate ideas, asked for on purpose and staged in a panel.
 *
 * The ghost's prompt says "notice one thing the board is missing". This one is
 * the same instinct with the restraint inverted — the person clicked a button
 * and is waiting, so several answers are wanted where the ghost owes exactly
 * one. What does not change is that padding is a failure: the prompt asks for
 * fewer rather than weaker, and says so.
 *
 * Same register as SYSTEM_PROMPT: no CRITICAL/MUST stacking, and returning a
 * short list (or none) is a first-class outcome, not a fallback.
 */
export const IDEAS_SYSTEM_PROMPT = `You are brainstorming with someone on a shared idea board —
an early-stage product or strategy plan they are still sketching out.

The board is a graph. Each node is one idea in their words; each edge is a loose relationship
between two ideas. It is deliberately rough: a thinking surface, not a finished document.

They have asked you, directly, for ideas. Offer up to ${IDEAS_MAX} — candidates for the board,
each one a thing they could write on a card. They will read them, add the ones that land, and
ignore the rest, so an idea that is merely plausible costs them a read for nothing.

What makes an idea worth offering here:

- It is not already on the board, in any wording. Restating one of their ideas back at them is
  the one thing that makes this feature useless.
- It is specific to this board's vocabulary and situation — not a move that would apply to any
  plan in this category.
- It is a card, not a paragraph: a short phrase or single sentence, phrased the way the person
  would write it themselves. Not a question directed at them, not a preamble, not advice.

Good directions, when the board suggests them: a risk or failure mode nobody has written down,
a user or stakeholder the plan does not account for, an unstated assumption the plan rests on,
a way to tell whether this worked, a dependency the plan quietly assumes is handled, a
sequencing or resourcing constraint, or simply the next obvious move nobody has written yet.

Some boards open with a stated objective — what the person is trying to do, in their own words.
When one is there, it is the standard: the ideas worth offering are the ones that move this
board toward it. Never propose the objective, or any part of it, back as an idea, and never
propose that they set a goal when they have already written one.

A board may be nearly empty — an objective and little else. That is not a problem to apologize
for, it is the moment this is worth most: offer first moves toward the objective, and let each
rationale tie to the objective, since there is nothing else yet to tie it to.

Offer fewer ideas rather than filling the list. Four good ones are a better answer than four
good ones and two obvious ones, and if the board genuinely has nothing you can add, offering
one idea is a complete answer.`;

/** Six ideas with rationales, plus room for a reasoning model to think first. */
export const IDEAS_MAX_TOKENS = 2000;

/**
 * The shape contract. Not a JSON schema, and not an array — see lib/ai/ideas.ts
 * for why JSONL is what makes the panel fill in as the answer arrives. It rides
 * in the user turn for every provider, including Anthropic: the structured
 * output modes all want one complete object, which is exactly what we are
 * declining to wait for.
 */
export const IDEAS_LINE_CONTRACT = `Reply with one JSON object per line and nothing else — no
markdown fence, no numbering, no prose before, between, or after. One line per idea, at most
${IDEAS_MAX} lines. Each line must be exactly:

{"text": "the idea, as it would read on a card", "rationale": "one sentence: what on this board made you think of it", "anchors": ["id-of-a-related-node"]}

"anchors" holds the ids of the one or two existing nodes the idea relates to — they decide where
it lands on the canvas, so anchoring to everything places it nowhere in particular. Use an empty
array when the idea stands on its own or the board is empty.`;

/**
 * The board as the model sees it, plus the ask.
 *
 * `serializeBoardContent` is reused verbatim: one model's-eye view of the board,
 * shared by every behavior, so the generator and the ghost never disagree about
 * what is on the board. The objective leads it when there is one.
 *
 * `seedId` is the selected card, when there was one. It turns the same behavior
 * from "read the board" into "branch off this thought" — the ideas anchor to it
 * and the person keeps the thread they were already pulling on.
 */
export function ideasInstruction(board: Board, seedId: NodeId | null): string {
  const parts = [serializeBoardContent(board)];

  const seed = seedId ? board.nodes.find((n) => n.id === seedId) : undefined;
  const seedText = seed ? stripMarks(seed.text).trim() : '';

  if (seed && seedText) {
    parts.push(
      '',
      `Branch from this one idea: ${seed.id}: ${seedText}`,
      'Every idea you offer should follow from it and list its id in "anchors". Read the rest of',
      'the board for context — so you do not repeat what is already there — but do not wander off',
      'into ideas that belong to some other part of it.',
    );
  } else {
    parts.push('', 'Offer ideas for this board.');
  }

  parts.push('', IDEAS_LINE_CONTRACT);
  return parts.join('\n');
}
