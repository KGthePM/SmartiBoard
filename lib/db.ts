import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { summarize, type BoardSummary } from './boards';
import { emptyBoard, newId, parseBoard, type Board } from './graph';
import type { ProviderId, StoredSettings } from './ai/providers';

/**
 * One SQLite file, one table. Self-hosting should be `docker run`, not a
 * dependency graph — no external services in v1.
 *
 * The table has always been keyed by board id, so many boards were already
 * storable; what was missing was a way to enumerate them and a lifecycle.
 * `created_at` and `archived_at` are columns because they are queried on;
 * the title is not, because it lives in the board JSON and mirroring it into
 * a column would only give it a second place to drift.
 */

const DB_PATH = resolve(process.env.SMARTI_DB_PATH ?? './data/smarti.db');

let db: Database.Database | null = null;

function conn(): Database.Database {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS boards (
      id         TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      id       INTEGER PRIMARY KEY CHECK (id = 1),
      provider TEXT NOT NULL,
      api_key  TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL DEFAULT '',
      model    TEXT NOT NULL DEFAULT ''
    );
  `);
  migrate(db);
  return db;
}

/**
 * CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
 * columns added after the first release need an explicit, idempotent step.
 */
function migrate(d: Database.Database): void {
  const cols = new Set((d.pragma('table_info(boards)') as { name: string }[]).map((c) => c.name));

  if (!cols.has('created_at')) {
    d.exec(`ALTER TABLE boards ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`);
    // Pre-existing boards have no creation time on record; their last write is
    // the closest honest answer, and it keeps sort order sane.
    d.exec(`UPDATE boards SET created_at = updated_at WHERE created_at = 0`);
  }
  if (!cols.has('archived_at')) {
    d.exec(`ALTER TABLE boards ADD COLUMN archived_at INTEGER`);
  }
}

export function loadBoard(id: string): Board {
  const row = conn()
    .prepare('SELECT data FROM boards WHERE id = ?')
    .get(id) as { data: string } | undefined;

  if (!row) return emptyBoard(id);

  try {
    return parseBoard(id, JSON.parse(row.data));
  } catch {
    // A corrupt row degrades to an empty board rather than a 500.
    return emptyBoard(id);
  }
}

export function saveBoard(board: Board): void {
  conn()
    .prepare(
      `INSERT INTO boards (id, data, updated_at, created_at)
       VALUES (@id, @data, @updatedAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET data = @data, updated_at = @updatedAt`,
    )
    .run({
      id: board.id,
      data: JSON.stringify({
        title: board.title,
        nodes: board.nodes,
        edges: board.edges,
        updatedAt: board.updatedAt,
      }),
      updatedAt: board.updatedAt,
    });
}

type Row = {
  id: string;
  data: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
};

/**
 * Every board, newest first, archived ones included — the caller decides how to
 * partition them. Each row's JSON is parsed once, which the minimap needs
 * anyway; this is a single-user file, not a multi-tenant table.
 */
export function listBoards(): BoardSummary[] {
  const rows = conn()
    .prepare(
      `SELECT id, data, created_at, updated_at, archived_at
       FROM boards ORDER BY updated_at DESC`,
    )
    .all() as Row[];

  return rows.map((row) => {
    let board: Board;
    try {
      board = parseBoard(row.id, JSON.parse(row.data));
    } catch {
      board = emptyBoard(row.id);
    }
    return summarize(board, {
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
    });
  });
}

/**
 * Written to disk immediately and deliberately: an empty board that only gets a
 * row on first edit would be invisible in the index right after you made it.
 */
export function createBoard(): Board {
  const board = emptyBoard(newId('b'));
  saveBoard(board);
  return board;
}

/** Archiving is reversible and does not touch the board's content. */
export function setArchived(id: string, archived: boolean): void {
  conn()
    .prepare('UPDATE boards SET archived_at = @archivedAt WHERE id = @id')
    .run({ id, archivedAt: archived ? Date.now() : null });
}

export function deleteBoard(id: string): void {
  conn().prepare('DELETE FROM boards WHERE id = ?').run(id);
}

export function boardExists(id: string): boolean {
  return conn().prepare('SELECT 1 FROM boards WHERE id = ?').get(id) !== undefined;
}

/**
 * The single settings row. It holds the user's AI provider config — including
 * the API key, which is why nothing here may ever be returned verbatim by an
 * API route: the key stays in the file it was saved to and is read only when
 * a model call is actually made.
 */
export function loadSettings(): StoredSettings | null {
  const row = conn()
    .prepare('SELECT provider, api_key, base_url, model FROM settings WHERE id = 1')
    .get() as { provider: string; api_key: string; base_url: string; model: string } | undefined;
  if (!row) return null;
  return { provider: row.provider as ProviderId, apiKey: row.api_key, baseUrl: row.base_url, model: row.model };
}

/**
 * An absent/undefined `apiKey` keeps the stored one — the settings form leaves
 * the field blank rather than echoing the key back for editing.
 */
export function saveSettings(next: {
  provider: ProviderId;
  apiKey?: string;
  baseUrl: string;
  model: string;
}): void {
  conn()
    .prepare(
      `INSERT INTO settings (id, provider, api_key, base_url, model)
       VALUES (1, @provider, @apiKey, @baseUrl, @model)
       ON CONFLICT(id) DO UPDATE SET
         provider = @provider,
         api_key = CASE WHEN @keepKey THEN settings.api_key ELSE @apiKey END,
         base_url = @baseUrl,
         model = @model`,
    )
    .run({
      provider: next.provider,
      apiKey: next.apiKey ?? '',
      // better-sqlite3 binds numbers, not booleans.
      keepKey: next.apiKey === undefined ? 1 : 0,
      baseUrl: next.baseUrl,
      model: next.model,
    });
}

/** Forgetting a key keeps the rest of the provider selection. */
export function clearSettingsApiKey(): void {
  conn().prepare(`UPDATE settings SET api_key = '' WHERE id = 1`).run();
}
