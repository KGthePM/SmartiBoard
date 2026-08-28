import { NextResponse } from 'next/server';
import { deleteBoard, loadBoard, saveBoard, setArchived } from '@/lib/db';
import { parseBoard } from '@/lib/graph';

export const runtime = 'nodejs';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return NextResponse.json(loadBoard(id));
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  // Never trust the wire shape; parseBoard drops anything malformed.
  const board = parseBoard(id, body);
  board.updatedAt = Date.now();
  saveBoard(board);
  return NextResponse.json({ ok: true, updatedAt: board.updatedAt });
}

/** Archive and restore. Content is untouched either way. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: { archived?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  if (typeof body.archived !== 'boolean') {
    return NextResponse.json({ error: 'archived must be a boolean' }, { status: 400 });
  }

  setArchived(id, body.archived);
  return NextResponse.json({ ok: true, archived: body.archived });
}

/**
 * Permanent. The UI only offers this on a board that is already archived, so
 * nothing is destroyed in a single action.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  deleteBoard(id);
  return NextResponse.json({ ok: true });
}
