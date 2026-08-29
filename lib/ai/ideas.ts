import type { NodeId } from '../graph';
import { parseJsonObject } from './parse';

/**
 * The idea generator's wire format (v2.0): JSONL — one JSON object per line,
 * not a single JSON array.
 *
 * That choice is the whole reason the panel can fill in progressively. A
 * complete line is parseable the moment it arrives; a partial array is not.
 * The cost is that the Anthropic path gives up schema-constrained output and
 * relies on the prompt contract instead — the same trade the OpenAI-flavor
 * providers already make for the ghost (see JSON_CONTRACT in ./prompt).
 *
 * Everything here is pure: the route line-buffers a stream and hands each
 * complete line to `ideaFromLine`, and nothing else in the pipeline needs to
 * know how a model chose to punctuate its output.
 */

/**
 * One generated idea, before the client places it. Deliberately the same shape
 * as a gap_fill ProposalDraft minus `kind` — an idea is a candidate node and
 * nothing more. It is NOT an IdeaNode: like a proposal, it lives outside
 * board.nodes until the user adds it, and adding constructs a fresh node.
 */
export type IdeaDraft = {
  text: string;
  rationale: string;
  /** Existing nodes this idea hangs off. Drives placement and the added edges. */
  anchors: NodeId[];
};

/**
 * A ceiling on how many ideas one run may put in the panel. A list you have to
 * scroll is a list you skim, and the prompt already asks for fewer rather than
 * padded — this is the backstop for a model that ignores that.
 */
export const IDEAS_MAX = 6;

/**
 * One JSONL line → a validated draft, or null. Mirrors `proposalFromText`'s
 * doctrine exactly: everything arriving here is untrusted, validation is the
 * point of the function, and anything that isn't a usable idea is simply
 * dropped. A dropped line is silence, never an error — a stray fence marker or
 * a "Here are some ideas:" preamble should cost nothing.
 */
export function ideaFromLine(line: string, validIds: NodeId[]): IdeaDraft | null {
  const parsed = parseJsonObject(line);
  if (!parsed) return null;

  const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
  const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '';
  // Both halves are required. The rationale is the only thing the person sees
  // when deciding whether to trust the idea, so an idea without one is not a
  // cheaper idea — it is an unusable one.
  if (!text || !rationale) return null;

  // Anchors are ids the model echoed back; drop anything that isn't real. An
  // idea with no surviving anchor is still fine — it places from the board
  // centroid and lands unconnected, which is what an unanchored idea is.
  const anchors = Array.isArray(parsed.anchors)
    ? parsed.anchors.filter(
        (a): a is NodeId => typeof a === 'string' && validIds.includes(a as NodeId),
      )
    : [];

  return { text, rationale, anchors };
}

/**
 * Split a streaming buffer into whole lines plus the unfinished tail. The tail
 * is handed back rather than parsed: half a JSON object is not a rejected idea,
 * it is an idea that hasn't finished arriving.
 */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n');
  // The last element is whatever followed the final newline — possibly ''.
  const rest = parts.pop() ?? '';
  return { lines: parts, rest };
}

/**
 * Identity for de-duplication within a run. Models asked for several ideas at
 * once will occasionally say the same thing twice in different clothes; this
 * catches the literal repeats, which is most of them.
 */
export function ideaKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}
