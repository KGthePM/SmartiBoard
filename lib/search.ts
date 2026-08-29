/**
 * Find and Replace over one board. Pure — no DOM, no db, no clock — so the
 * panel, the canvas highlight, and the tests all call the same functions.
 *
 * Two things make this less trivial than a `.includes()`:
 *
 * 1. A card's text is stored with inline markers (`**bold**`, `{{red|x}}`), but
 *    a person searches for what they can *read*. So matching runs on the
 *    stripped text and every offset here is an offset into that — see
 *    `stripMarksWithMap` in ./richtext for the way back to storage.
 * 2. A match can straddle a marker pair (`he**llo**` reads as "hello"). Those
 *    are found and shown like any other, but they are not replaceable: rewriting
 *    the span would delete one half of the pair and restyle the rest of the
 *    card. `Match.replaceable` carries that, and the panel reports the skips
 *    rather than silently doing nothing.
 *
 * The objective is searched too, and deliberately as plain text: it is typed
 * into a bare textarea and never parsed for markers, so `**` there is two
 * asterisks. The board title is deliberately NOT searched — it is the one field
 * the model never sees and `setTitle` spends nothing, so replacing in it would
 * need a third doctrine. Proposals are not searched either, because a proposal
 * is never a node.
 */

import type { Board, NodeId } from './graph';
import { sourceRange, stripMarksWithMap, type Segment } from './richtext';

export type SearchTarget = { kind: 'node'; id: NodeId } | { kind: 'objective' };

export type SearchOptions = {
  caseSensitive: boolean;
  wholeWord: boolean;
};

export const DEFAULT_OPTIONS: SearchOptions = { caseSensitive: false, wholeWord: false };

export type Match = {
  target: SearchTarget;
  /** Offsets into the text as it is *read*, not as it is stored. */
  start: number;
  end: number;
  /** False when the match straddles a marker pair. Replace skips these. */
  replaceable: boolean;
};

/** A segment of rendered text, tagged if a match covers it. */
export type MarkedSegment = Segment & { hit?: 'on' | 'active' };

/** Letters, digits and underscore, in any script — the whole-word boundary. */
const WORD = /[\p{L}\p{N}_]/u;

function isWord(c: string | undefined): boolean {
  return c !== undefined && WORD.test(c);
}

/**
 * The readable text and its way back to storage. Card text is marked up;
 * anything else is already what it looks like, and gets the identity map.
 */
function readable(text: string, rich: boolean): { plain: string; map: number[] } {
  if (rich) return stripMarksWithMap(text);
  return { plain: text, map: text.split('').map((_, i) => i) };
}

function matchesIn(
  text: string,
  query: string,
  opts: SearchOptions,
  rich: boolean,
): Omit<Match, 'target'>[] {
  if (!query) return [];
  const { plain, map } = readable(text, rich);
  const hay = opts.caseSensitive ? plain : plain.toLowerCase();
  const needle = opts.caseSensitive ? query : query.toLowerCase();

  const out: Omit<Match, 'target'>[] = [];
  let i = hay.indexOf(needle);
  while (i !== -1) {
    const end = i + needle.length;
    if (opts.wholeWord && (isWord(plain[i - 1]) || isWord(plain[end]))) {
      // Rejected on a boundary, so resume one character along: the next real
      // match may well start inside the run we just refused.
      i = hay.indexOf(needle, i + 1);
      continue;
    }
    out.push({ start: i, end, replaceable: sourceRange(map, i, end) !== null });
    // Matches never overlap — "aa" in "aaa" is one hit, not two.
    i = hay.indexOf(needle, end);
  }
  return out;
}

/**
 * Every match on the board, in reading order: the objective first, then the
 * cards top-to-bottom and left-to-right. Position order, not creation order —
 * on a canvas "the next match" means the next one down the board, and a card
 * you dragged somewhere else has moved in the list for the same reason it moved
 * on screen. Ties break on id so the order is total and stable.
 */
export function findMatches(board: Board, query: string, opts: SearchOptions): Match[] {
  if (!query) return [];

  const out: Match[] = [];
  for (const m of matchesIn(board.objective, query, opts, false)) {
    out.push({ target: { kind: 'objective' }, ...m });
  }

  const nodes = [...board.nodes].sort(
    (a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1),
  );
  for (const n of nodes) {
    for (const m of matchesIn(n.text, query, opts, true)) {
      out.push({ target: { kind: 'node', id: n.id }, ...m });
    }
  }
  return out;
}

/**
 * Applies matches to the text they were found in. Unreplaceable ones are
 * skipped, leaving their span byte-identical. Spliced back-to-front so the
 * offsets of the matches still to come stay valid.
 *
 * The replacement goes in literally: this format has no escape mechanism, so
 * typing `**` into the replacement field really does write two asterisks that
 * may pair with a marker nearby. That is one ⌘Z away and it is what the person
 * asked for; inventing an escape syntax is a bigger change than this feature.
 */
export function replaceInText(
  text: string,
  ms: Match[],
  replacement: string,
  rich = true,
): string {
  const { map } = readable(text, rich);
  let out = text;
  for (const m of [...ms].sort((a, b) => b.start - a.start)) {
    const at = sourceRange(map, m.start, m.end);
    if (!at) continue;
    out = out.slice(0, at[0]) + replacement + out.slice(at[1]);
  }
  return out;
}

export type ReplacePlan = {
  /** Only the cards whose text actually changed. */
  nodes: { id: NodeId; text: string }[];
  /** The rewritten objective, or null when it was untouched. */
  objective: string | null;
  replaced: number;
  skipped: number;
};

/**
 * What a Replace All would do, as one batch. The counts are what the panel
 * reports — a skip has to be said out loud, or a match that stays on screen
 * after you pressed the button reads as a bug.
 */
export function planReplaceAll(
  board: Board,
  query: string,
  opts: SearchOptions,
  replacement: string,
): ReplacePlan {
  const all = findMatches(board, query, opts);
  const replaced = all.filter((m) => m.replaceable).length;

  const byNode = new Map<NodeId, Match[]>();
  const inObjective: Match[] = [];
  for (const m of all) {
    if (m.target.kind === 'objective') inObjective.push(m);
    else byNode.set(m.target.id, [...(byNode.get(m.target.id) ?? []), m]);
  }

  const nodes: { id: NodeId; text: string }[] = [];
  for (const [id, ms] of byNode) {
    const node = board.nodes.find((n) => n.id === id);
    if (!node) continue;
    const text = replaceInText(node.text, ms, replacement);
    if (text !== node.text) nodes.push({ id, text });
  }

  const rewritten = inObjective.length
    ? replaceInText(board.objective, inObjective, replacement, false)
    : board.objective;

  return {
    nodes,
    objective: rewritten === board.objective ? null : rewritten,
    replaced,
    skipped: all.length - replaced,
  };
}

/**
 * Splits rendered segments at match boundaries so the card can tint them. Exact
 * because the segments of a parse concatenate back to the stripped text — the
 * same string the offsets index into. `activeIndex` points into `ms`, so the
 * caller decides which of a card's matches is the one being stood on.
 */
export function markMatches(
  segments: Segment[],
  ms: Match[],
  activeIndex: number | null,
): MarkedSegment[] {
  if (ms.length === 0) return segments;

  const out: MarkedSegment[] = [];
  let at = 0;

  for (const seg of segments) {
    const segEnd = at + seg.text.length;
    let cut = at;

    ms.forEach((m, k) => {
      if (m.end <= at || m.start >= segEnd) return;
      const a = Math.max(m.start, at);
      const b = Math.min(m.end, segEnd);
      if (a > cut) out.push({ ...seg, text: seg.text.slice(cut - at, a - at) });
      out.push({
        ...seg,
        text: seg.text.slice(a - at, b - at),
        hit: k === activeIndex ? 'active' : 'on',
      });
      cut = b;
    });

    if (cut < segEnd) out.push({ ...seg, text: seg.text.slice(cut - at, segEnd - at) });
    at = segEnd;
  }

  return out;
}
