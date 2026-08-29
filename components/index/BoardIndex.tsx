'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { relativeTime, type BoardSummary } from '@/lib/boards';
import { BoardThumb } from './BoardThumb';

/**
 * The project library. `now` comes from the server so the relative timestamps
 * render identically on both sides of hydration.
 */
export function BoardIndex({ boards, now }: { boards: BoardSummary[]; now: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const active = boards.filter((b) => b.archivedAt === null);
  const archived = boards.filter((b) => b.archivedAt !== null);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/boards', { method: 'POST' });
      const board = (await res.json()) as { id: string };
      router.push(`/board/${board.id}`);
    } catch {
      setBusy(false);
    }
  };

  const archive = async (id: string, archived_: boolean) => {
    setBusy(true);
    await fetch(`/api/boards/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ archived: archived_ }),
    }).catch(() => {});
    router.refresh();
    setBusy(false);
  };

  const purge = async (b: BoardSummary) => {
    if (!window.confirm(`Delete “${b.title}” permanently? This cannot be undone.`)) return;
    setBusy(true);
    await fetch(`/api/boards/${b.id}`, { method: 'DELETE' }).catch(() => {});
    router.refresh();
    setBusy(false);
  };

  return (
    <div className="index">
      <header className="index-head">
        <svg
          className="index-mark"
          width="34"
          height="34"
          viewBox="0 0 22 22"
          aria-hidden="true"
        >
          <rect x="1.5" y="7" width="11" height="9" rx="2" fill="#fff" stroke="#c9c9c2" />
          <rect
            x="8.5"
            y="3.5"
            width="11"
            height="9"
            rx="2"
            fill="#f2f4fb"
            stroke="#7f93c4"
            strokeDasharray="2.5 2"
          />
          <rect x="5" y="10.5" width="11" height="9" rx="2" fill="#fff" stroke="#9aa8c4" />
          <circle cx="8.2" cy="13.7" r="1.3" fill="#4f6ba8" />
        </svg>
        <h1 className="index-wordmark">Smarti Board</h1>
        <p className="index-motto" lang="la">
          Tabula quae tecum cogitat
        </p>
        <p className="index-count">
          {active.length === 0
            ? 'No boards yet — start one and it will name itself.'
            : `${active.length} ${active.length === 1 ? 'board' : 'boards'}`}
        </p>
      </header>

      <div className="index-grid">
        <button className="bcard bcard-new" onClick={create} disabled={busy}>
          <span className="plus">+</span>
          <span>New board</span>
        </button>

        {active.map((b) => (
          <div className="bcard" key={b.id}>
            <Link className="bcard-hit" href={`/board/${b.id}`}>
              <BoardThumb thumb={b.thumb} />
              <div className="bcard-meta">
                <span className="bcard-title">{b.title}</span>
                <span className="bcard-sub">
                  {b.nodeCount} {b.nodeCount === 1 ? 'idea' : 'ideas'} ·{' '}
                  {relativeTime(b.updatedAt, now)}
                </span>
              </div>
            </Link>
            <button
              className="bcard-x"
              title="Archive"
              aria-label={`Archive ${b.title}`}
              disabled={busy}
              onClick={() => archive(b.id, true)}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {archived.length > 0 ? (
        <section className="archive">
          <h2>Archived</h2>
          <div className="index-grid">
            {archived.map((b) => (
              <div className="bcard archived" key={b.id}>
                <Link className="bcard-hit" href={`/board/${b.id}`}>
                  <BoardThumb thumb={b.thumb} />
                  <div className="bcard-meta">
                    <span className="bcard-title">{b.title}</span>
                    <span className="bcard-sub">
                      archived {relativeTime(b.archivedAt ?? b.updatedAt, now)}
                    </span>
                  </div>
                </Link>
                <div className="bcard-actions">
                  <button disabled={busy} onClick={() => archive(b.id, false)}>
                    Restore
                  </button>
                  <button className="danger" disabled={busy} onClick={() => purge(b)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
