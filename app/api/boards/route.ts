import { NextResponse } from 'next/server';
import { createBoard, listBoards } from '@/lib/db';
import { newId } from '@/lib/graph';
import { tutorialBoard } from '@/lib/tutorial';

export const runtime = 'nodejs';

/** The collection. Feeds the ⌘K switcher; the index page calls the db directly. */
export async function GET() {
  return NextResponse.json({ boards: listBoards() });
}

/**
 * A new board, blank unless a template is named. `template: 'tutorial'` is how
 * the library's restore link brings the tutorial back after it was deleted;
 * an absent, malformed, or unknown body falls through to a blank board rather
 * than failing, because creating a board must not be refusable.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { template?: unknown } | null;
  const board =
    body?.template === 'tutorial' ? createBoard(tutorialBoard(newId('b'))) : createBoard();
  return NextResponse.json(board, { status: 201 });
}
