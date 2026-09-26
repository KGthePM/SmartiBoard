/**
 * The how-it-works pass — the explanation-card prompt and wire contract
 * (see .superpowers/sdd/2026-09-26-how-it-works/). The third shape-mate of
 * the ideas generator and the folder import's summary pass: JSONL in the
 * message for every provider, one JSON object per line out, everything
 * that isn't a usable line dropped in silence.
 *
 * The input is the project's major files, one JSON line each —
 * {"path": …, "content": …} — with the author's own doc files first,
 * marked with a note so the model reads them as framing rather than code.
 * The output is conceptual explanation cards: {"title","body","files"},
 * where the app (not the model) draws edges from real imports, so the only
 * thing a card must claim honestly is its files.
 */

import { parseJsonObject } from './parse';

/** Card title cap after validation — a heading, not a paragraph. */
export const CARD_TITLE_MAX = 80;

/** Card body cap after validation — an explanation, not documentation. */
export const CARD_BODY_MAX = 600;

/** The card count the pass asks for at minimum — fewer is not a story. */
export const HOW_CARDS_MIN = 3;

/** The card count ceiling — more is a wall, not an explanation. */
export const HOW_CARDS_MAX = 16;

/** Defensive per-file content cap: one giant doc cannot blow the whole
 *  instruction. Head-slice — the top of a file is what explains it. */
const FILE_CONTENT_MAX_CHARS = 20_000;

export const HOW_SYSTEM_PROMPT = `You are explaining a person's own project folder. They are looking at a map
of the project — one card per file — and have asked how it works: a short deck of conceptual
explanation cards that make the project legible without opening anything.

The major files arrive in the message as one JSON line each: {"path": "...", "content": "..."}. Doc
files (README, AGENTS.md, and the like) come first, marked with a note — they are the author's own
guide to this project, so trust them as framing for what the code is for.

Answer with ${HOW_CARDS_MIN}-${HOW_CARDS_MAX} conceptual cards. Each card explains one idea of the
project — a loop, a layer, a contract, a mechanism — in the person's own vocabulary: a short title
and two or three plain sentences. Explain how the pieces work together, not what each file's name
says. The map draws its own edges from real imports, so a card's value is naming the files it is
about, accurately — every file you list must be one you were sent.

Reply with one JSON object per line and nothing else — no markdown fence, no numbering, no prose
before, between, or after. Each line must be exactly:

{"title": "short card heading", "body": "two or three sentences", "files": ["paths this card is about"]}`;

/** The per-turn contract, appended after the input lines. Separate from the
 *  system prompt so it sits next to the files it describes. */
export const HOW_LINE_CONTRACT = `One JSON line per card, ${HOW_CARDS_MIN} to ${HOW_CARDS_MAX} cards, in whatever
order tells the story best. Nothing else — no fence, no preamble. Each line exactly:

{"title": "short card heading, one line", "body": "two or three sentences, one line", "files": ["only paths from above"]}`;

/**
 * Files → the user turn. Doc files first (marked with a note), one JSON
 * line per file so a stream can answer card by card and no file can
 * impersonate a delimiter. Each file's content is head-sliced to
 * FILE_CONTENT_MAX_CHARS — an oversized doc ships truncated, never
 * unbounded. Tree and imports sections render only when provided.
 */
export function howInstruction(
  files: Array<{ path: string; content: string }>,
  opts?: { tree?: string[]; imports?: Array<[string, string]>; docPaths?: ReadonlySet<string> },
): string {
  const sections: string[] = [];

  if (opts?.tree?.length) {
    sections.push(...opts.tree.map((t) => `tree: ${t}`), '');
  }
  if (opts?.imports?.length) {
    sections.push(...opts.imports.map(([from, to]) => `imports: ${from} -> ${to}`), '');
  }

  const docPaths = opts?.docPaths;
  const ordered = docPaths
    ? [...files].sort((a, b) => Number(docPaths.has(b.path)) - Number(docPaths.has(a.path)))
    : files;
  const lines = ordered.map((f) => {
    const line: { path: string; content: string; note?: string } = {
      path: f.path,
      content: f.content.slice(0, FILE_CONTENT_MAX_CHARS),
    };
    if (docPaths?.has(f.path)) line.note = "the author's own guide to this project";
    return JSON.stringify(line);
  });

  return [...sections, ...lines, '', HOW_LINE_CONTRACT].join('\n');
}

/** Output budget: ~250 tokens a card plus a little room, capped sanely. */
export function howMaxTokens(cardTarget: number): number {
  return Math.min(4000, 250 + cardTarget * 250);
}

export type HowCard = { title: string; body: string; files: string[] };

/**
 * One JSONL reply line → a validated card, or null. Everything here is
 * untrusted: title and body are flattened to one line and capped (a card
 * over budget is sliced, not dropped — the card it promised still
 * renders), and files are filtered to the batch's own paths, because the
 * app draws edges from real imports — a file that was not sent is a claim
 * the map cannot cash. A card with no surviving files still stands; only
 * an empty title or body drops it. A dropped line is silence, never an
 * error — same doctrine as summaryFromLine.
 */
export function cardFromLine(line: string, validPaths: ReadonlySet<string>): HowCard | null {
  const parsed = parseJsonObject(line);
  if (!parsed) return null;

  const title = typeof parsed.title === 'string' ? parsed.title.replace(/\s+/g, ' ').trim() : '';
  if (!title) return null;

  const body = typeof parsed.body === 'string' ? parsed.body.replace(/\s+/g, ' ').trim() : '';
  if (!body) return null;

  const files = Array.isArray(parsed.files)
    ? parsed.files.filter((f): f is string => typeof f === 'string' && validPaths.has(f))
    : [];

  return {
    title: title.slice(0, CARD_TITLE_MAX),
    body: body.slice(0, CARD_BODY_MAX),
    files,
  };
}
