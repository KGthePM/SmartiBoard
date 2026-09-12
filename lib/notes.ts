/**
 * Margin notes (v6.5): what you are thinking while you work, said under a
 * card and to nobody else.
 *
 * A card's `text` is what the board says to everyone including the model;
 * `done` is content the model is told; `reactions` are how the person feels
 * about an idea, model-blind. A note is the fourth answer: what the person is
 * telling *themselves* — model-blind like a reaction, but carrying prose
 * instead of a mark from a closed set. It stays out of `fingerprint`
 * (lib/ai/trigger) and out of `serializeBoardContent` (lib/ai/prompt), so
 * writing one never wakes the ghost and never spends a token, and AI-
 * constructed nodes (`acceptProposal`, `addIdea`) never carry one.
 *
 * Deliberately `{id, text}` and nothing else — no author, no timestamp.
 * Smarti has no person concept anywhere ("the token authorises a board,
 * never a person"), so a comment thread without authors is just a stack of
 * thoughts, ordered by when they were written.
 *
 * `NOTE_MAX` follows `OBJECTIVE_MAX`'s reasoning in ./graph: the cap is what
 * keeps a note a note rather than a shadow card. There is no count cap — the
 * person is trusted with how many, the way card text is.
 *
 * Pure and node-free, like ./reactions: `parseBoard`, `sync.ts`, the store,
 * the card, and the tests all import this one file, so the shape cannot
 * drift between them.
 */

export type CardNote = { id: string; text: string };

/**
 * A note is typed into, not stored generously — the objective's reasoning,
 * scaled down: a note is a margin comment, not a second card.
 */
export const NOTE_MAX = 280;

/**
 * Validates an untrusted notes array off disk or the wire, in the spirit of
 * `normalizeReactions`: anything malformed degrades to none rather than
 * throwing. A duplicate id keeps its first occurrence — write order is the
 * only order a note has, and a later duplicate is junk off the wire, not a
 * second note.
 */
export function normalizeNotes(raw: unknown): CardNote[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CardNote[] = [];
  for (const v of raw) {
    if (typeof v !== 'object' || v === null) continue;
    const o = v as Record<string, unknown>;
    if (typeof o.id !== 'string' || seen.has(o.id)) continue;
    if (typeof o.text !== 'string') continue;
    seen.add(o.id);
    out.push({ id: o.id, text: o.text.slice(0, NOTE_MAX) });
  }
  return out;
}
