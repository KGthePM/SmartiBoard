import { NextResponse } from 'next/server';
import { createBoard, listBoards } from '@/lib/db';
import { newId } from '@/lib/graph';
import { buildTemplate } from '@/lib/templates';

export const runtime = 'nodejs';

/** The collection. Feeds the ⌘K switcher; the index page calls the db directly. */
export async function GET() {
  return NextResponse.json({ boards: listBoards() });
}

/**
 * A new board, blank unless a template is named — `'tutorial'` is how the
 * library's restore link brings the tutorial back after it was deleted, and
 * `'kanban'` is the shape people reach for when a board is about work.
 *
 * An absent, malformed, or unknown body falls through to a blank board rather
 * than failing, because creating a board must not be refusable. That is why
 * `buildTemplate` returns null instead of throwing on a name it does not know.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { template?: unknown } | null;
  const board = createBoard(buildTemplate(body?.template, newId('b')) ?? undefined);
  return NextResponse.json(board, { status: 201 });
}
