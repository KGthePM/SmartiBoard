'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { boardTitle, relativeTime, type BoardSummary } from '@/lib/boards';
import { downloadJson } from '@/lib/download';
import type { Board } from '@/lib/graph';
import type { TemplateId } from '@/lib/templates';
import {
  boardToFile,
  declaredNodeCount,
  fileNameFor,
  LIBRARY_FILE_NAME,
  readTransfer,
} from '@/lib/transfer';
import { SettingsPanel } from '../SettingsPanel';
import { IndexMark } from './IndexMark';
import { BoardThumb } from './BoardThumb';
import { TemplateLibrary } from './TemplateLibrary';

/**
 * What an import lost on the way in, in words. `parseBoard` drops a malformed
 * card in silence — right for a database row nobody is watching, wrong for a
 * file someone just chose — so the difference is said out loud. The find bar's
 * "1 skipped" ruling: content the app counted but never showed reads as a bug.
 */
function dropped(lost: number): string {
  if (lost <= 0) return '';
  return ` — ${lost} malformed ${lost === 1 ? 'card was' : 'cards were'} dropped`;
}

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

  /**
   * The template library, same pattern: local to the index, dismissed by the
   * backdrop / Escape / ×, and unmounted with the page. A successful create
   * navigates away, which closes it for free; a failed one leaves it open
   * with `busy` cleared, so the pick can simply be retried.
   */
  const [libOpen, setLibOpen] = useState(false);

  /**
   * What the last import or export had to say. One line under the header,
   * because both operations are otherwise silent: an export that failed and an
   * import that dropped three malformed cards would each look like success.
   */
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  /**
   * A board, or a whole library, out to a file. The app is loopback-only by
   * design, so this is the only path a board has off this machine.
   */
  const exportOne = async (b: BoardSummary) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const board = (await (await fetch(`/api/boards/${b.id}`)).json()) as Board;
      // `b.title` is already the derived one, and `boardToFile` drops the id —
      // an import always mints a fresh one, so a file carrying an id it never
      // reads would only suggest that overwrite-by-id works.
      downloadJson(fileNameFor(b.title, b.id), boardToFile(board));
    } catch {
      setNote({ text: 'Could not read that board.', bad: true });
    }
    setBusy(false);
  };

  const exportAll = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const { boards: full } = (await (await fetch('/api/boards?full=1')).json()) as {
        boards: Board[];
      };
      downloadJson(LIBRARY_FILE_NAME, full.map(boardToFile));
      setNote({
        text: `Exported ${full.length} ${full.length === 1 ? 'board' : 'boards'}.`,
        bad: false,
      });
    } catch {
      setNote({ text: 'Could not read the library.', bad: true });
    }
    setBusy(false);
  };

  /**
   * A file back in. `readTransfer` is the only refusal in the feature and it is
   * deliberately here rather than in the route: creating a board must never be
   * refusable, so the server turns junk into a blank board — which is the wrong
   * answer when there is a person watching who chose the wrong file.
   *
   * The server mints every id, so an import can only add boards, never
   * overwrite one. `parseBoard` drops malformed cards in silence, so the counts
   * are compared afterwards and the difference is said out loud.
   */
  const importFile = async (file: File) => {
    if (busy) return;
    setNote(null);
    const raws = readTransfer(await file.text().catch(() => ''));
    if (!raws) {
      setNote({ text: `“${file.name}” is not a Smarti Board file.`, bad: true });
      return;
    }

    setBusy(true);
    const claimed = declaredNodeCount(raws);
    const single = raws.length === 1;
    try {
      const res = await fetch('/api/boards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(single ? { board: raws[0] } : { boards: raws }),
      });

      if (single) {
        const board = (await res.json()) as Board;
        const lost = claimed - board.nodes.length;
        // A clean import goes straight to the board, like creating one does.
        // A lossy one keeps you here, because the note is the point of it.
        if (lost <= 0) {
          router.push(`/board/${board.id}`);
          return;
        }
        setNote({ text: `Imported “${boardTitle(board)}”${dropped(lost)}.`, bad: false });
      } else {
        const { imported, nodes } = (await res.json()) as { imported: number; nodes: number };
        setNote({ text: `Imported ${imported} boards${dropped(claimed - nodes)}.`, bad: false });
      }
      router.refresh();
    } catch {
      setNote({ text: 'Could not import that file.', bad: true });
    }
    setBusy(false);
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

        {note ? (
          <p className={`index-note${note.bad ? ' bad' : ''}`} role="status">
            {note.text}
          </p>
        ) : null}
      </header>

      <div className="index-grid">
        <button className="bcard bcard-new" onClick={() => create()} disabled={busy}>
          <span className="plus">+</span>
          <span>New board</span>
        </button>

        {/* The template library, behind one tile instead of one tile per
            template: the starter row grew a card for every template added,
            pushing the person's own boards down their own home page — and the
            registry is append-only, so it would keep growing. The tutorial is
            in the library too, while keeping its quiet header line above:
            both are doors to the same ordinary board. */}
        <button
          className="bcard bcard-new bcard-template"
          onClick={() => setLibOpen(true)}
          disabled={busy}
          title="Kanban, SWOT, mind map, and the tutorial — every board you can start from"
        >
          <span className="plus" aria-hidden="true">
            ▥
          </span>
          <span>Template library</span>
        </button>

        {/* Not a template — a door for content that already exists, which is
            why it sits at the end of the starters rather than among them. The
            input is reset on every open so choosing the same file twice fires
            change twice. */}
        <button
          className="bcard bcard-new bcard-import"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          title="Open a .smarti.json file exported from this or another machine"
        >
          <span className="plus" aria-hidden="true">
            ⇧
          </span>
          <span>Import board</span>
        </button>
        <input
          ref={fileRef}
          className="index-file"
          type="file"
          accept=".json,application/json"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void importFile(file);
          }}
        />

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
            {/* Beside the archive ×, and revealed the same way — hover, or
                always under a coarse pointer, per the v2.6 reachability rule. */}
            <button
              className="bcard-dl"
              title="Export as a file"
              aria-label={`Export ${b.title}`}
              disabled={busy}
              onClick={() => exportOne(b)}
            >
              ⇩
            </button>
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
                  {/* An archived board is the one most worth having a copy of
                      before Delete, so Export sits between the two. */}
                  <button disabled={busy} onClick={() => exportOne(b)}>
                    Export
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
          {/* The whole working library in one file — the answer to "I am moving
              to a new machine". Archived boards are deliberately not in it: they
              would arrive unarchived, resurrecting what someone filed away. */}
          {active.length > 0 ? (
            <>
              <button disabled={busy} onClick={exportAll}>
                Export all
              </button>
              <span aria-hidden="true">·</span>
            </>
          ) : null}
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
      {libOpen ? (
        <TemplateLibrary onClose={() => setLibOpen(false)} onPick={create} busy={busy} />
      ) : null}
    </div>
  );
}
