/**
 * Card reactions (v2.7): how you feel about an idea, said to the board and to
 * nobody else.
 *
 * A reaction is the inverse of `done`. Both are per-node marks a person puts on
 * a card deliberately, but `done` is content the model reads — it joins the
 * fingerprint and leads a line in the prompt — while a reaction is content the
 * model never sees. It stays out of `fingerprint` (lib/ai/trigger) and out of
 * `serializeBoardContent` (lib/ai/prompt), so toggling one never wakes the
 * ghost and never spends a token. That is the whole point: this is the user
 * talking to their own board.
 *
 * On costs it takes the title's doctrine (`setTitle` in lib/store): undoable,
 * because a misclick on an 18px target must be recoverable, but no
 * `lastMutationAt` bump.
 *
 * The set is closed and small, like `PALETTE` in ./richtext — a short rack of
 * marks a board stays scannable under. A free emoji picker would make every card a
 * different alphabet. Pure and node-free, like ./theme: `parseBoard`, the
 * store, the card, and the tests all import this one file, so the legal set
 * cannot drift between them.
 */

export const REACTIONS = ['love', 'fire', 'bang', 'haha', 'down'] as const;

export type ReactionKey = (typeof REACTIONS)[number];

/** What the card draws. Full-color glyphs — the themed part is the chip behind them. */
export const REACTION_GLYPH: Record<ReactionKey, string> = {
  love: '❤️',
  fire: '🔥',
  bang: '❗',
  haha: '😂',
  down: '👎',
};

/** How a screen reader and a tooltip name them. */
export const REACTION_LABEL: Record<ReactionKey, string> = {
  love: 'Love it',
  fire: 'Hot',
  bang: 'Important',
  haha: 'Funny',
  down: 'Doubt it',
};

const KNOWN = new Set<string>(REACTIONS);

/**
 * Validates untrusted reaction lists off disk or the wire, in the spirit of
 * `parseBoard`: anything malformed degrades to none rather than throwing.
 * Unknown keys are dropped and duplicates collapse, and the result is always
 * in REACTIONS order — two cards carrying the same reactions must render
 * identically no matter what order they were clicked in.
 */
export function normalizeReactions(raw: unknown): ReactionKey[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<ReactionKey>();
  for (const v of raw) {
    if (typeof v === 'string' && KNOWN.has(v)) seen.add(v as ReactionKey);
  }
  return REACTIONS.filter((k) => seen.has(k));
}

/** Add or remove one mark, keeping REACTIONS order. Pure. */
export function toggleReaction(list: readonly ReactionKey[], key: ReactionKey): ReactionKey[] {
  const seen = new Set(list);
  if (seen.has(key)) seen.delete(key);
  else seen.add(key);
  return REACTIONS.filter((k) => seen.has(k));
}
