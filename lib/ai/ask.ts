import type { Board, Edge, NodeId } from '../graph';

/**
 * The Ask wire format (v5.4): prose, not JSONL. The answer is read in a panel
 * rather than staged onto a board, so there is no line to complete before
 * something can be shown — the text streams as text. The one structural thing
 * in the stream is the citation marker, and it is the only thing this module
 * knows about: `[[nodeId]]` in the model's output becomes a clickable chip in
 * the panel.
 *
 * Everything here is pure; `ask-prompt.ts` holds everything that knows a
 * model exists, mirroring the ideas split.
 */

/**
 * One stretch of an answer: prose, or a citation to a card on the board.
 * A `cite` never carries text — the chip renders the node's own text, so the
 * card and the citation can never disagree about what it says.
 */
export type AskSegment =
  | { kind: 'text'; text: string }
  | { kind: 'cite'; id: NodeId };

/**
 * The question cap. This is the first untrusted free-text string in the app
 * that reaches a model turn — nothing before it types into a prompt (`/suggest`
 * sends only the board; the ideas and folder routes send nothing typed). A
 * question is a question at 500 characters; past that it is a paste, and the
 * cap is enforced on both sides of the wire because a client is only a client.
 */
export const QUESTION_MAX = 500;

/** Truncate to the cap. Clamping, not rejecting: a long paste is not hostile. */
export function clampQuestion(s: string): string {
  return s.slice(0, QUESTION_MAX).trim();
}

/**
 * Split a streaming buffer into renderable text plus a tail that might still
 * become a citation. `[[nodeI` is not a broken citation — it is one that hasn't
 * finished arriving — so it is held back exactly the way `splitLines` in
 * ./ideas.ts holds back half a JSON object. Only a trailing partial `[[…`
 * matters: one that closed is either a complete marker or already prose.
 */
export function splitAnswer(buffer: string): { safe: string; rest: string } {
  const open = buffer.lastIndexOf('[[');
  if (open === -1) return { safe: buffer, rest: '' };
  const close = buffer.indexOf(']]', open);
  if (close !== -1) return { safe: buffer, rest: '' };
  return { safe: buffer.slice(0, open), rest: buffer.slice(open) };
}

/**
 * Answer text → segments. A citation whose id is not on the board is dropped
 * in silence, the ideas route's doctrine for an unusable line: a hallucinated
 * id is not the person's problem, it is just not a chip. The `[[`/`]]` around a
 * surviving id do not render as text — the chip is the citation.
 */
export function parseAnswer(text: string, validIds: NodeId[]): AskSegment[] {
  const valid = new Set(validIds);
  const segments: AskSegment[] = [];
  let i = 0;
  for (;;) {
    const open = text.indexOf('[[', i);
    if (open === -1) break;
    const close = text.indexOf(']]', open + 2);
    if (close === -1) break;
    if (open > i) segments.push({ kind: 'text', text: text.slice(i, open) });
    const id = text.slice(open + 2, close);
    if (valid.has(id)) segments.push({ kind: 'cite', id });
    i = close + 2;
  }
  if (i < text.length) segments.push({ kind: 'text', text: text.slice(i) });
  return segments;
}

/**
 * The selected cards, their direct neighbours, and the edges among them — the
 * idea generator's branch-off-a-selected-card gesture applied to reading
 * instead of writing. A question about "this part" is answered from that part
 * plus exactly what it touches, so a 300-card folder map does not ride along
 * for a question about one folder. An empty `ids` returns the board untouched:
 * that is the whole-board case, and `scopeBoard` is only ever a narrowing.
 */
export function scopeBoard(board: Board, ids: NodeId[]): Board {
  if (ids.length === 0) return board;
  const wanted = new Set(ids);
  const inScope = new Set<NodeId>(ids);
  for (const e of board.edges) {
    if (wanted.has(e.from)) inScope.add(e.to);
    if (wanted.has(e.to)) inScope.add(e.from);
  }
  const nodes = board.nodes.filter((n) => inScope.has(n.id));
  const edges: Edge[] = board.edges.filter(
    (e) => inScope.has(e.from) && inScope.has(e.to),
  );
  return { ...board, nodes, edges };
}
