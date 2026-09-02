import { NextResponse } from 'next/server';
import { guardBoard, guardManage } from '@/lib/access';
import { deleteBoard, loadBoard, saveBoard, setArchived } from '@/lib/db';
import { parseBoard } from '@/lib/graph';

export const runtime = 'nodejs';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // The one method here a guest may reach: this is how their canvas first loads
  // the board they were let into.
  const denied = guardBoard(req, id);
  if (denied) return denied;

  return NextResponse.json(loadBoard(id));
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // A whole-board replace, which is import and hand-editing rather than the
  // canvas — so it stays with the install, not the share. A guest writes through
  // the ops path or not at all.
  const denied = guardManage(req);
  if (denied) return denied;
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
  // Archiving is filing somebody else's library.
  const denied = guardManage(req);
  if (denied) return denied;
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
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // A guest holds no copy and cannot destroy what they do not hold.
  const denied = guardManage(req);
  if (denied) return denied;
  deleteBoard(id);
  return NextResponse.json({ ok: true });
}
