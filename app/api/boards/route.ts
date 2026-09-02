import { NextResponse } from 'next/server';
import { guardManage } from '@/lib/access';
import { allBoards, createBoard, listBoards } from '@/lib/db';
import { newId, parseBoard } from '@/lib/graph';
import { buildTemplate } from '@/lib/templates';

export const runtime = 'nodejs';

/**
 * The collection. Feeds the ⌘K switcher; the index page calls the db directly.
 *
 * `?full=1` is the whole-library export (v3.3) and is opt-in for a reason: the
 * switcher wants summaries, and shipping every board's nodes to satisfy a
 * dropdown would be the wrong default for the sake of one button.
 */
export async function GET(req: Request) {
  // The library is the install, not a board: a share token names one board and
  // therefore reaches neither the list nor `?full=1`. See lib/access.ts.
  const denied = guardManage(req);
  if (denied) return denied;

  if (new URL(req.url).searchParams.get('full') === '1') {
    return NextResponse.json({ boards: allBoards() });
  }
  return NextResponse.json({ boards: listBoards() });
}

/**
 * A new board: blank, from a template, or imported from a file.
 *
 * `'tutorial'` is how the library's restore link brings the tutorial back after
 * it was deleted, and `'kanban'`/`'swot'`/`'mindmap'` are shapes people reach
 * for. `board` and `boards` are the import (v3.3) — one file's worth, where an
 * object is a board and an array is boards.
 *
 * An absent, malformed, or unknown body falls through to a blank board rather
 * than failing, because creating a board must not be refusable. That is why
 * `buildTemplate` returns null instead of throwing on a name it does not know,
 * and why an import of junk is a blank board here rather than a 400: "not a
 * Smarti Board file" is said in the library, where there is a person to say it
 * to (`looksLikeBoard` in lib/transfer).
 *
 * **The server always mints the id; a file's own `id` is never read.**
 * `saveBoard` upserts on id, so this is the one real safety requirement of the
 * whole feature: an import can only ever add boards, never overwrite one.
 */
export async function POST(req: Request) {
  const denied = guardManage(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as {
    template?: unknown;
    board?: unknown;
    boards?: unknown;
  } | null;

  // A bundle. Each entry gets its own fresh id and its own parse, so one
  // unreadable board in a file of twelve costs that board and not the import.
  if (Array.isArray(body?.boards)) {
    const created = body.boards.map((raw) => createBoard(parseBoard(newId('b'), raw)));
    return NextResponse.json(
      {
        imported: created.length,
        ids: created.map((b) => b.id),
        // What survived parsing, so the caller can say what the file lost.
        nodes: created.reduce((n, b) => n + b.nodes.length, 0),
      },
      { status: 201 },
    );
  }

  // One board from a file. parseBoard does the rest: it drops malformed nodes
  // and dangling edges, clamps the title and objective, snaps font sizes, and
  // defaults every per-era field — the same job it does for the PUT route.
  if (typeof body?.board === 'object' && body.board !== null) {
    return NextResponse.json(createBoard(parseBoard(newId('b'), body.board)), { status: 201 });
  }

  const board = createBoard(buildTemplate(body?.template, newId('b')) ?? undefined);
  return NextResponse.json(board, { status: 201 });
}
