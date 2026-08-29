import type { NodeId } from '../graph';
import type { ProposalDraft } from '../proposal';

/**
 * Model output → ProposalDraft. Shared by both wire flavors: the Anthropic
 * path gets schema-constrained JSON, the OpenAI-compatible path gets
 * best-effort json_object mode — so this parser tolerates the ways a
 * less-constrained model wraps its JSON (markdown fences, stray prose).
 *
 * Everything that arrives here is already untrusted; validation is the point
 * of the file. Null is the answer for anything that isn't a usable proposal,
 * including a deliberate "none" — the routes treat that as silence.
 */
export function proposalFromText(text: string, validIds: NodeId[]): ProposalDraft | null {
  const parsed = parseJsonObject(text);
  if (!parsed) return null;

  if (parsed.kind !== 'gap_fill' && parsed.kind !== 'connection') return null;

  const body = typeof parsed.text === 'string' ? parsed.text.trim() : '';
  const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '';
  if (!body || !rationale) return null;

  // Anchors are ids the model echoed back — drop anything that isn't real.
  const anchors = Array.isArray(parsed.anchors)
    ? parsed.anchors.filter((a): a is string => typeof a === 'string' && validIds.includes(a as NodeId))
    : [];

  if (parsed.kind === 'connection') {
    const connectTo = typeof parsed.connectTo === 'string' ? parsed.connectTo : '';
    // A connection needs two real endpoints or it isn't a connection.
    if (!validIds.includes(connectTo as NodeId) || anchors.length === 0) return null;
    if (anchors.every((a) => a === connectTo)) return null;
    return { kind: 'connection', text: body, rationale, anchors, connectTo: connectTo as NodeId };
  }

  return { kind: 'gap_fill', text: body, rationale, anchors };
}

/**
 * Brace-tolerant JSON object extraction. Exported because the idea generator
 * parses the same way, one JSONL line at a time — a model that wraps its
 * output in a fence or trails a sentence after it should not cost an idea.
 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const candidates = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1].trim());

  for (const candidate of candidates) {
    // Brace-to-brace: recovers JSON surrounded by stray prose.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    const slice = start !== -1 && end > start ? candidate.slice(start, end + 1) : candidate;
    try {
      const parsed = JSON.parse(slice);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate shape.
    }
  }
  return null;
}
