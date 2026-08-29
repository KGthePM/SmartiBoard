import { BoardIndex } from '@/components/index/BoardIndex';
import { listBoards, seedIfEmpty } from '@/lib/db';

// The index reflects the file on disk, which the canvas writes to continuously.
export const dynamic = 'force-dynamic';

export default function Home() {
  // A first run has nothing to list and nothing to explain itself with; the
  // tutorial board is both. Guarded on an empty table, so it happens once.
  seedIfEmpty();
  return <BoardIndex boards={listBoards()} now={Date.now()} />;
}
