'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { relativeTime, type BoardSummary } from '@/lib/boards';

/**
 * ⌘K board switcher. The list is fetched when it opens rather than held in
 * memory, so having many boards costs nothing while you're working in one.
 * Archived boards are left out — they are still reachable by URL and from the
 * index, just not in the middle of a train of thought.
 */
export function BoardSwitcher({ onClose, currentId }: { onClose: () => void; currentId: string }) {
  const router = useRouter();
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const now = useRef(Date.now()).current;

  useEffect(() => {
    let cancelled = false;
    fetch('/api/boards')
      .then((r) => r.json())
      .then((d: { boards: BoardSummary[] }) => {
        if (!cancelled) setBoards(d.boards.filter((b) => b.archivedAt === null));
      })
      .catch(() => {
        if (!cancelled) setBoards([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = boards ?? [];
    return q ? all.filter((b) => b.title.toLowerCase().includes(q)) : all;
  }, [boards, query]);

  // `matches.length` is the "New board" row, one past the end of the list.
  const rows = matches.length + 1;
  const active = Math.min(cursor, rows - 1);

  const open = (id: string) => {
    onClose();
    if (id !== currentId) router.push(`/board/${id}`);
  };

  const create = async () => {
    const res = await fetch('/api/boards', { method: 'POST' });
    const board = (await res.json()) as { id: string };
    onClose();
    router.push(`/board/${board.id}`);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (Math.min(c, rows - 1) + 1) % rows);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (Math.min(c, rows - 1) + rows - 1) % rows);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const board = matches[active];
      if (board) open(board.id);
      else void create();
    }
  };

  return (
    <div className="switcher-back" onPointerDown={onClose}>
      <div className="switcher" onPointerDown={(e) => e.stopPropagation()}>
        <input
          className="switcher-input"
          autoFocus
          placeholder="Go to a board…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={onKeyDown}
        />

        <div className="switcher-list">
          {boards === null ? <div className="switcher-empty">loading…</div> : null}

          {matches.map((b, i) => (
            <button
              key={b.id}
              className={`switcher-row ${i === active ? 'active' : ''}`}
              onPointerEnter={() => setCursor(i)}
              onClick={() => open(b.id)}
            >
              <span className="switcher-name">{b.title}</span>
              <span className="switcher-sub">
                {b.id === currentId ? 'current · ' : ''}
                {b.nodeCount} {b.nodeCount === 1 ? 'idea' : 'ideas'} ·{' '}
                {relativeTime(b.updatedAt, now)}
              </span>
            </button>
          ))}

          <button
            className={`switcher-row new ${active === matches.length ? 'active' : ''}`}
            onPointerEnter={() => setCursor(matches.length)}
            onClick={() => void create()}
          >
            <span className="switcher-name">+ New board</span>
          </button>
        </div>
      </div>
    </div>
  );
}
