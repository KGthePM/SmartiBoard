import { headers } from 'next/headers';
import { BoardIndex } from '@/components/index/BoardIndex';
import { accessForHeaders, canManage } from '@/lib/access';
import { listBoards, seedIfEmpty } from '@/lib/db';

// The index reflects the file on disk, which the canvas writes to continuously.
export const dynamic = 'force-dynamic';

export default async function Home() {
  // The library is install-scoped, and pages need the gate as much as routes
  // do (v4.2): every guard used to live on `/api/*`, so a bare tunnel hostname
  // server-rendered the whole library — titles, summaries, the seed — to
  // anyone who held it. A share token names one board and is never the
  // library's to honour, hence `canManage`, the same tier `/api/boards` asks
  // for. The refusal is words, not a redirect: there is nowhere to send them.
  const a = accessForHeaders(await headers());
  if (!canManage(a)) {
    return (
      <main className="gate-refusal">
        <p className="gate-title">Smarti Board</p>
        <p className="gate-note">
          This is somebody&rsquo;s own Smarti Board. Reaching a board here needs the full share
          link you were sent — the part after the <code>#</code> included.
        </p>
      </main>
    );
  }

  // A first run has nothing to list and nothing to explain itself with; the
  // tutorial board is both. Guarded on an empty table, so it happens once.
  seedIfEmpty();
  return <BoardIndex boards={listBoards()} now={Date.now()} />;
}
