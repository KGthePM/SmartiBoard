'use client';

import { useEffect, useRef, useState } from 'react';
import { MIN_NODES, substantiveNodes } from '@/lib/ai/trigger';
import { boardTitle } from '@/lib/boards';
import { useBoard } from '@/lib/store';
import { BoardSwitcher } from './BoardSwitcher';
import { SettingsPanel } from './SettingsPanel';
import { SummaryPanel } from './SummaryPanel';

/**
 * Board identity, in the one corner the canvas wasn't already using.
 *
 * Renaming is inline and optional: the field's value is the stored title and
 * its placeholder is the derived one, so clearing the field hands the name back
 * to the board's content rather than leaving it blank. There is no naming step
 * anywhere — for the same reason there is no save button.
 */
export function BoardChrome() {
  const board = useBoard((s) => s.board);
  const loaded = useBoard((s) => s.loaded);
  const setTitle = useBoard((s) => s.setTitle);
  const summaryOpen = useBoard((s) => s.summaryOpen);
  const setSummaryOpen = useBoard((s) => s.setSummaryOpen);
  const settingsOpen = useBoard((s) => s.settingsOpen);
  const setSettingsOpen = useBoard((s) => s.setSettingsOpen);

  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /** The title as it was before this rename, so Escape can put it back. */
  const beforeRef = useRef('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault();
        useBoard.getState().setSummaryOpen(!useBoard.getState().summaryOpen);
      } else if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        useBoard.getState().setSettingsOpen(!useBoard.getState().settingsOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A board switch must not leave the previous board's name under an edit cursor.
  useEffect(() => setEditing(false), [board.id]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const startEditing = () => {
    beforeRef.current = board.title;
    setEditing(true);
  };

  // Same floor as the ghost: below three real ideas there is nothing to read.
  const canSummarize =
    loaded && substantiveNodes(board).length >= MIN_NODES;

  return (
    <>
      <div className="chrome">
        {editing ? (
          <input
            ref={inputRef}
            className="chrome-input"
            value={board.title}
            placeholder={boardTitle(board)}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              } else if (e.key === 'Escape') {
                setTitle(beforeRef.current);
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            className="chrome-title"
            title="Rename this board"
            onClick={startEditing}
            disabled={!loaded}
          >
            {loaded ? boardTitle(board) : ' '}
          </button>
        )}

        <button
          className="chrome-summarize"
          title={canSummarize ? 'Summarize this board (⌘.)' : 'Needs at least 3 ideas'}
          disabled={!canSummarize}
          onClick={() => setSummaryOpen(!summaryOpen)}
        >
          Summarize
        </button>

        <button className="chrome-switch" title="Switch board" onClick={() => setOpen(true)}>
          ⌘K
        </button>

        <button
          className="chrome-settings"
          title="Model settings (⌘,)"
          aria-label="Model settings"
          onClick={() => setSettingsOpen(true)}
        >
          ⚙
        </button>
      </div>

      {open ? <BoardSwitcher onClose={() => setOpen(false)} currentId={board.id} /> : null}
      {summaryOpen ? <SummaryPanel /> : null}
      {settingsOpen ? <SettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
    </>
  );
}
