import { NextResponse } from 'next/server';
import { createBoard, listBoards } from '@/lib/db';

export const runtime = 'nodejs';

/** The collection. Feeds the ⌘K switcher; the index page calls the db directly. */
export async function GET() {
  return NextResponse.json({ boards: listBoards() });
}

export async function POST() {
  return NextResponse.json(createBoard(), { status: 201 });
}
