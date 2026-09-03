/**
 * The folder import's AI pass — the per-file summary prompt and wire contract
 * (phase 2; see folder-import-plan.md). The second user-invoked AI behavior,
 * and deliberately the ideas generator's shape-mate: JSONL in the message for
 * every provider (no structured output, so a batch streams), one JSON object
 * per line out, everything that isn't a usable line dropped in silence.
 *
 * The input is one JSON line per file — {"path": …, "content": …} — which is
 * what makes a batch unambiguous (JSON-escaped content rides inside the line,
 * so no file can impersonate a delimiter). The output echoes the path, which
 * is the only key the client matches on.
 */

import { parseJsonObject } from './parse';

/** The cap a summary is held to after validation — a card annotation, not
 *  documentation. One honest line fits far inside this. */
export const FOLDER_SUMMARY_MAX_CHARS = 200;

export const FOLDER_SYSTEM_PROMPT = `You are summarizing files from a person's own project folder. They are
looking at a map of the project — one card per file — and have asked for a one-line summary on each
card so the map reads without opening anything.

The files arrive in the message as one JSON line each: {"path": "...", "content": "..."}. Answer with
exactly one JSON line per input line, echoing that file's path unchanged, with a one-line summary of
what the file is or does.

A summary is a card annotation, not documentation: one short sentence — about fifteen words — in the
person's own vocabulary. Say what the file is for, not what its name already says. When a file gives
you nothing to work with, describe it plainly ("generated data", "empty scaffold", "lockfile") rather
than inventing a purpose. Skipping a file is not an option: the map needs its line.

Reply with one JSON object per line and nothing else — no markdown fence, no numbering, no prose
before, between, or after. Each line must be exactly:

{"path": "the input line's path, unchanged", "summary": "one short sentence"}`;

/** The per-turn contract, appended after the input lines. Separate from the
 *  system prompt so it sits next to the files it describes. */
export const FOLDER_LINE_CONTRACT = `One reply line per input line above, same paths, any order. Nothing else —
no fence, no preamble. Each line exactly:

{"path": "the file's path, unchanged", "summary": "one short sentence, ~15 words"}`;

/**
 * Files → the user turn. Content rides inside a JSON line per file, so a
 * batch of twenty is twenty unambiguous lines and a stream can answer file by
 * file as each line completes.
 */
export function folderInstruction(files: Array<{ path: string; content: string }>): string {
  const lines = files.map((f) => JSON.stringify({ path: f.path, content: f.content }));
  return [...lines, '', FOLDER_LINE_CONTRACT].join('\n');
}

/** Output budget: ~70 tokens a line plus a little room, capped sanely. */
export function summaryMaxTokens(fileCount: number): number {
  return Math.min(4000, 250 + fileCount * 70);
}

export type FileSummary = { path: string; summary: string };

/**
 * One JSONL reply line → a validated summary, or null. Everything here is
 * untrusted: the path must be one of the batch's own (a model naming a file
 * that was not sent is a line for nobody's card), the summary must be
 * non-empty, and both are flattened to one line and capped so the card gets
 * the annotation it was promised, whatever the model felt like punctuating.
 * A dropped line is silence, never an error — a fence or a preamble costs
 * nothing, same doctrine as ideaFromLine.
 */
export function summaryFromLine(line: string, validPaths: ReadonlySet<string>): FileSummary | null {
  const parsed = parseJsonObject(line);
  if (!parsed) return null;

  const path = typeof parsed.path === 'string' ? parsed.path : '';
  if (!path || !validPaths.has(path)) return null;

  const summary =
    typeof parsed.summary === 'string' ? parsed.summary.replace(/\s+/g, ' ').trim() : '';
  if (!summary) return null;

  return { path, summary: summary.slice(0, FOLDER_SUMMARY_MAX_CHARS) };
}
