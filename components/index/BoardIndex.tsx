'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { relativeTime, type BoardSummary } from '@/lib/boards';
import type { TemplateId } from '@/lib/templates';
import { SettingsPanel } from '../SettingsPanel';
import { IndexMark } from './IndexMark';
import { BoardThumb } from './BoardThumb';

/**
 * The project library. `now` comes from the server so the relative timestamps
 * render identically on both sides of hydration.
 */
export function BoardIndex({ boards, now }: { boards: BoardSummary[]; now: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  /**
   * Settings are install-level, not board-level, so the index can summon the
   * same panel the chrome does. Local state, like the chrome's switcher: the
   * store's settingsOpen is board-session UI that beginLoad clears, and this
   * panel belongs to no board. Leaving the page unmounts it, open or not.
   */
  const [settingsOpen, setSettingsOpen] = useState(false);

  // The chrome's ⌘,, answered here so the shortcut works before any board
  // exists. First-run setup is exactly when that matters most.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setSettingsOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const active = boards.filter((b) => b.archivedAt === null);
  const archived = boards.filter((b) => b.archivedAt !== null);

  /**
   * A new board, blank or from a template. `template` is also the tutorial's
   * only entry point once it has been deleted. An unknown name would still
   * make a blank board — the route never refuses — so nothing here has to
   * guard it.
   */
  const create = async (template?: TemplateId) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/boards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(template ? { template } : {}),
      });
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
        <IndexMark size={34} className="index-mark" />
        <h1 className="index-wordmark">Smarti Board</h1>
        <p className="index-motto" lang="la">
          Tabula quae tecum cogitat
        </p>
        <p className="index-count">
          {active.length === 0
            ? 'No boards yet — start one and it will name itself.'
            : `${active.length} ${active.length === 1 ? 'board' : 'boards'}`}
        </p>
        {/* The tutorial is an ordinary board, so it can be archived or deleted
            like any other; this is how it comes back. A quiet line rather than
            a card in the grid — it is a door, not a project. */}
        <button className="index-tutorial" disabled={busy} onClick={() => create('tutorial')}>
          Open the tutorial board
        </button>
      </header>

      <div className="index-grid">
        <button className="bcard bcard-new" onClick={() => create()} disabled={busy}>
          <span className="plus">+</span>
          <span>New board</span>
        </button>

        {/* A template is a project starter, so it sits in the grid beside the
            blank one — unlike the tutorial, which is a door and stays a quiet
            line in the header. The columns it ships are positions, not a mode:
            nothing about the board that comes out is special. */}
        <button
          className="bcard bcard-new bcard-template"
          onClick={() => create('kanban')}
          disabled={busy}
          title="Backlog · Doing · Blocked · Done, as ordinary cards you can move or delete"
        >
          <span className="plus" aria-hidden="true">
            ▥
          </span>
          <span>Kanban board</span>
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

      <footer className="index-foot">
        <IndexMark size={18} />
        <p className="index-foot-line">Smarti Board © 2026</p>
        <nav className="index-foot-links">
          {/* First among the meta-links: the install's settings are as much
              furniture of this page as of a board's chrome — more so before
              the first board exists. */}
          <button onClick={() => setSettingsOpen(true)}>Settings</button>
          <span aria-hidden="true">·</span>
          <a href="https://smartiboard.netlify.app/" target="_blank" rel="noopener noreferrer">
            Website
          </a>
          <span aria-hidden="true">·</span>
          <a
            href="https://smartiboard.netlify.app/support.html"
            target="_blank"
            rel="noopener noreferrer"
          >
            Support &amp; FAQ
          </a>
        </nav>
      </footer>

      {settingsOpen ? <SettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}
