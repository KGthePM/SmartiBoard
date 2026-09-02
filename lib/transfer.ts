/**
 * Moving a board between devices as a file (v3.3).
 *
 * The app is loopback-only by design — no auth, no sync, no account — so a file
 * is the only path a board has off the machine it was made on, and it is the
 * right one: a board is already JSON and `parseBoard` is already a full
 * untrusted-JSON validator. Almost nothing here is new machinery; this module is
 * the small pure part that both directions need.
 *
 * **The format has no envelope: an object is a board, an array is boards.**
 * `parseBoard`'s per-era tolerance *is* the versioning strategy — a file written
 * today opens in a future version exactly the way an old database row does — so
 * a `{version, …}` wrapper would only be a second thing to keep true. It also
 * keeps a file hand-editable and round-trippable through the existing PUT.
 *
 * Pure and node-free: the API route and the tests import the same functions.
 * The one DOM line lives in ./download.
 */

import type { Board } from './graph';

/** Plain JSON, but a Downloads folder full of `.json` says nothing. */
export const TRANSFER_EXT = '.smarti.json';

/** The whole-library bundle. One name, because there is one library. */
export const LIBRARY_FILE_NAME = `Smarti Board library${TRANSFER_EXT}`;

/** Long enough for a derived title, short of any filesystem's limit. */
const NAME_MAX = 80;

/**
 * What a board is called on disk. Callers pass the **derived** title
 * (`boardTitle` in ./boards, or `BoardSummary.title` which is already derived) —
 * a board's stored title is empty until someone renames it, and `.smarti.json`
 * with nothing in front of it is not a filename.
 *
 * The id is the fallback rather than "Untitled", so two unnamed boards exported
 * in a row do not land on the same name.
 */
export function fileNameFor(title: string, id: string): string {
  const cleaned = title
    // Control characters, and the set that is reserved on at least one of the
    // three platforms this runs on. A wrong-looking name beats a failed save.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/["*/:<>?\\|]/g, ' ')
    .replace(/\s+/g, ' ')
    // A leading dot is a hidden file on two of them, and `..` is worse. Trimmed
    // together with the whitespace, so `../../etc` does not leave one behind.
    .replace(/^[\s.]+/, '')
    .slice(0, NAME_MAX)
    // Same class at the end: Windows silently drops a trailing dot, which would
    // desync the name the app said it wrote from the one on disk, and the length
    // cap can land the cut mid-space.
    .replace(/[\s.]+$/, '');

  return `${cleaned || id}${TRANSFER_EXT}`;
}

/**
 * The board as it goes into a file: everything except `id`.
 *
 * The id is stripped for the same reason `saveBoard` keeps it out of the stored
 * blob, plus one of this feature's own: **an import always mints a fresh id and
 * never trusts the file's.** A field that is unconditionally ignored invites
 * someone to believe overwrite-by-id works, and `saveBoard` upserts on id, so
 * that belief would be the one way this feature could destroy a board.
 */
export function boardToFile(board: Board): Omit<Board, 'id'> {
  const { id: _id, ...rest } = board;
  return rest;
}

/**
 * Is this thing a board at all? Deliberately loose: it answers "this is not a
 * Smarti Board file", never "this board is malformed" — that stays `parseBoard`'s
 * job, and it answers by dropping the bad part rather than refusing the file.
 *
 * The check has to be more than "is it an object", which is the trap: `{"a":1}`
 * is an object and `parseBoard` turns it into a blank board, so accepting it
 * would report success while importing nothing.
 */
export function looksLikeBoard(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const o = raw as Record<string, unknown>;
  return (
    Array.isArray(o.nodes) ||
    Array.isArray(o.edges) ||
    typeof o.title === 'string' ||
    typeof o.objective === 'string'
  );
}

/**
 * A file's text to the boards inside it, or null for "not a Smarti Board file".
 * One board and a whole library take the same path — the array is the only
 * difference — and an array with one usable entry among junk imports that one,
 * because dropping the unreadable part is what the rest of the ingestion does.
 */
export function readTransfer(text: string): unknown[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const boards = (Array.isArray(raw) ? raw : [raw]).filter(looksLikeBoard);
  return boards.length > 0 ? boards : null;
}

/**
 * How many cards the file *claims*, so the import can say what got dropped.
 * `parseBoard` discards a malformed node in silence, which is right for a
 * database row nobody is watching and wrong for a file someone just chose:
 * an import that quietly loses three cards reads as a success. The same ruling
 * as the find bar's "1 skipped".
 */
export function declaredNodeCount(raws: unknown[]): number {
  return raws.reduce<number>((total, raw) => {
    const nodes = (raw as Record<string, unknown>).nodes;
    return total + (Array.isArray(nodes) ? nodes.length : 0);
  }, 0);
}
