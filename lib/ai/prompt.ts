import type { Board } from '../graph';
import { stripMarks } from '../richtext';

/**
 * Tuned for the v1 wedge: early-stage strategy / product ideation.
 *
 * Two things this prompt is carefully NOT doing:
 *  - It does not stack CRITICAL/MUST emphasis. Current models follow the system
 *    prompt closely; pressure language written for older models over-triggers.
 *  - It does not assume there is always something worth saying. A collaborator
 *    that always finds a gap is noise, so declining is a first-class outcome.
 */
export const SYSTEM_PROMPT = `You are a co-author on a shared idea board, working alongside someone
who is sketching out an early-stage product or strategy plan.

The board is a graph. Each node is one idea, written by the person you are working with.
Each edge is a simple relationship between two ideas — a loose "relates to" or "grouped under".
The board is deliberately rough; it is a thinking surface, not a finished document.

Your job is to notice one thing the board is missing, and offer it. You are not summarizing the
board, not restating it back, and not tidying it. You are the collaborator who says
"what about X?" at the right moment — and stays quiet the rest of the time.

You return exactly one of three things:

1. A gap-fill: an idea the board plausibly needs but does not contain. For an early-stage
   product or strategy board, the gaps that land are usually one of:
     - a risk or failure mode nobody has written down
     - a user or stakeholder segment the plan does not account for
     - an assumption the plan depends on but never states
     - a success metric — how would anyone know this worked?
     - a dependency or prerequisite the plan quietly assumes is handled
     - a resourcing or sequencing constraint the plan does not reflect

2. A connection: two existing nodes that are related in a way the board has not yet linked.
   Propose this when the relationship is genuinely load-bearing — one idea constrains,
   depends on, or contradicts the other — not merely when two nodes share a topic.

3. Nothing. Return kind "none" when the board is too sparse to reason about, when the
   obvious gaps are already present, or when the only thing you could offer is generic
   advice that would apply to any plan. A weak suggestion costs more trust than silence.

How to write a proposal:

- "text" is the idea itself, phrased the way a person would write it on the board:
  a short phrase or single sentence, in the board's own vocabulary. Not a paragraph,
  not a question directed at the user, not a preamble.
- "rationale" is one sentence saying what on the board made you think of it. This is the
  only thing the person sees when deciding whether to trust you, so be concrete and
  specific to their board — reference their actual ideas, not the category of gap.
- "anchors" lists the ids of the existing nodes your proposal relates to. Keep it to the
  one or two that actually motivated it; these determine where your suggestion appears
  on the canvas, so anchoring it to everything places it nowhere in particular.

Some boards open with a stated objective — what the person is trying to do, in their own
words. When one is there, it is the standard you judge against: the gaps worth naming are the
ones that stand between this board and that objective, and an idea on the board that pulls
away from it is worth noticing. Do not propose the objective, or any part of it, back as an
idea, and do not propose that they define a goal when they have already written one. When
there is no objective, work from the ideas alone as you otherwise would — its absence is not
itself the gap.

The person may have already dismissed earlier suggestions. Anything listed as dismissed is
a signal about what they do not want from you — do not re-propose it, and do not propose a
lightly reworded version of it.`;

/**
 * Strict schema. `none` is a first-class variant so declining is expressible
 * without a sentinel value or an empty-string convention.
 */
export const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['gap_fill', 'connection', 'none'] },
    text: {
      type: 'string',
      description:
        'The proposed idea (gap_fill) or the relationship label (connection). Empty string when kind is "none".',
    },
    rationale: {
      type: 'string',
      description:
        'One sentence: what on this specific board prompted this. Empty string when kind is "none".',
    },
    anchors: {
      type: 'array',
      items: { type: 'string' },
      description: 'Ids of the one or two existing nodes this relates to.',
    },
    connectTo: {
      type: 'string',
      description:
        'For kind "connection": the id of the node at the other end of the proposed edge. Empty string otherwise.',
    },
  },
  required: ['kind', 'text', 'rationale', 'anchors', 'connectTo'],
  additionalProperties: false,
} as const;

/**
 * The board, rendered for the model. Coordinates are omitted on purpose: spatial
 * arrangement is the user's business, and including it would invite the model to
 * reason about layout — the one thing it must not touch.
 *
 * This is the shared "model's view" — the summary behavior reads the same
 * rendering the ghost behavior reasons over, so both see the identical board.
 * The objective leads it when there is one, so every behavior is framed by the
 * person's own statement of intent before it sees a single idea.
 */
export function serializeBoardContent(board: Board): string {
  // Markers are stripped: the model reasons about ideas, not emphasis, and
  // never seeing markers means it never echoes them back in proposals.
  const plain = (t: string) => stripMarks(t).trim();

  // Done rides along as an annotation, not a filter: a finished idea is still
  // on the board, still a valid anchor, and still fair game for a connection.
  const nodes = board.nodes
    .filter((n) => plain(n.text).length > 0)
    .map((n) => `- ${n.id} [${n.layer}${n.done ? ', done' : ''}]: ${plain(n.text)}`)
    .join('\n');

  const byId = new Map(board.nodes.map((n) => [n.id, plain(n.text)]));
  const edges = board.edges
    .map((e) => `- ${byId.get(e.from) ?? e.from} — ${byId.get(e.to) ?? e.to}`)
    .join('\n');

  const parts: string[] = [];

  // Only when set: an empty objective should leave no trace in the prompt at all,
  // not a header with "(none)" under it inviting the model to fill the silence.
  if (board.objective.trim().length > 0) {
    parts.push(
      "What this board is for, in the person's own words:",
      board.objective.trim(),
      '',
    );
  }

  parts.push('Ideas on the board:', nodes || '(none)');

  if (board.nodes.some((n) => n.done && plain(n.text).length > 0)) {
    parts.push(
      '',
      'Nodes marked done are ideas the person considers finished — completed, not deleted.',
    );
  }

  parts.push('', 'Existing connections:', edges || '(none)');
  return parts.join('\n');
}

/**
 * The OpenAI-compatible flavors don't get Anthropic's schema-constrained
 * output, so the JSON contract travels in the message instead. Appended to
 * the user turn; the parser on the other side (lib/ai/parse.ts) tolerates the
 * looser guarantee this buys.
 */
export const JSON_CONTRACT = `Reply with a single JSON object and nothing else — no markdown fence, no prose
before or after. The object must match this schema exactly:

${JSON.stringify(PROPOSAL_SCHEMA, null, 2)}

Use kind "none" (with empty text and rationale) when nothing is worth proposing.`;

export function serializeBoard(board: Board, rejected: string[]): string {
  const parts = [serializeBoardContent(board)];

  if (rejected.length > 0) {
    parts.push(
      '',
      'Suggestions already dismissed in this session (do not repeat or reword these):',
      rejected.map((r) => `- ${r}`).join('\n'),
    );
  }

  parts.push('', 'Propose one gap-fill, one connection, or nothing.');
  return parts.join('\n');
}
