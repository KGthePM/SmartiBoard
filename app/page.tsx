import { BoardIndex } from '@/components/index/BoardIndex';
import { listBoards } from '@/lib/db';

// The index reflects the file on disk, which the canvas writes to continuously.
export const dynamic = 'force-dynamic';

export default function Home() {
  return <BoardIndex boards={listBoards()} now={Date.now()} />;
}
