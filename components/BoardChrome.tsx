'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { canGenerateIdeas } from '@/lib/ai/trigger';
import { boardTitle } from '@/lib/boards';
import { useBoard } from '@/lib/store';
import { BoardSwitcher } from './BoardSwitcher';
import { ObjectivePanel } from './ObjectivePanel';
import { SettingsPanel } from './SettingsPanel';
import { IdeasPanel } from './IdeasPanel';
import { SearchPanel } from './SearchPanel';

/**
 * Board identity, top-left: the name leads the board. The buttons stay
 * top-right, with the canvas directions behind the ? at the row's end.
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
  const ideasOpen = useBoard((s) => s.ideasOpen);
  const setIdeasOpen = useBoard((s) => s.setIdeasOpen);
  const settingsOpen = useBoard((s) => s.settingsOpen);
  const setSettingsOpen = useBoard((s) => s.setSettingsOpen);
  const objectiveOpen = useBoard((s) => s.objectiveOpen);
  const searchOpen = useBoard((s) => s.searchOpen);
  const setObjectiveOpen = useBoard((s) => s.setObjectiveOpen);
  const hasObjective = useBoard((s) => s.board.objective.trim().length > 0);
  const privacy = useBoard((s) => s.board.privacy);
  const setPrivacy = useBoard((s) => s.setPrivacy);
  const canUndo = useBoard((s) => s.undoStack.length > 0);
  const canRedo = useBoard((s) => s.redoStack.length > 0);

  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  /**
   * The directions, pinned open by a press. Hover alone used to be the only
   * way in, which made the one piece of in-app help unreachable from the one
   * kind of device whose gestures are least obvious. */
  const [helpOpen, setHelpOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  /** The title as it was before this rename, so Escape can put it back. */
  const beforeRef = useRef('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        // Still ⌘. — the user-invoked slot, whatever occupies it. ⌘B/⌘I/⌘U are
        // spoken for by rich-text formatting inside a card.
        e.preventDefault();
        useBoard.getState().setIdeasOpen(!useBoard.getState().ideasOpen);
      } else if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        useBoard.getState().setSettingsOpen(!useBoard.getState().settingsOpen);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        useBoard.getState().setObjectiveOpen(!useBoard.getState().objectiveOpen);
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        useBoard.getState().setPrivacy(!useBoard.getState().board.privacy);
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
        // Opens, never toggles: ⌘F pressed again while the bar is open means
        // "search for something else", and the bar itself answers that by
        // re-selecting its input. preventDefault is what keeps the browser's
        // own find bar — which cannot see a card that is off screen — shut.
        e.preventDefault();
        useBoard.getState().setSearchOpen(true);
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        // Present. This handler is unmounted while presenting (the overlay
        // replaces the chrome), so from here it is always the way in.
        e.preventDefault();
        useBoard.getState().setPresenting(true);
      } else if (e.key === 'Escape') {
        // The directions close like every other panel does.
        setHelpOpen(false);
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

  // A lower floor than the ghost's, on purpose: an objective on an empty board
  // is exactly when generating is worth most. Privacy Mode is inside the
  // predicate and refuses absolutely — this ships the board upstream.
  const canGenerate = loaded && canGenerateIdeas(board);

  // A name the board gave itself (or no name at all) is provisional; one that
  // was typed is the author's. The muted style draws that line.
  const named = board.title.trim().length > 0;

  return (
    <>
      <div className="board-name">
        {editing ? (
          <input
            ref={inputRef}
            className="board-name-input"
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
            className={`board-name-button${named ? '' : ' derived'}`}
            title="Rename this board"
            onClick={startEditing}
            disabled={!loaded}
          >
            {loaded ? boardTitle(board) : ' '}
          </button>
        )}
      </div>

      <div className="chrome">
        <button
          className="chrome-undo"
          title={canUndo ? 'Undo (⌘Z)' : 'Nothing to undo'}
          disabled={!canUndo}
          onClick={() => useBoard.getState().undo()}
        >
          Undo
        </button>

        <button
          className="chrome-redo"
          title={canRedo ? 'Redo (⌘⇧Z)' : 'Nothing to redo'}
          disabled={!canRedo}
          onClick={() => useBoard.getState().redo()}
        >
          Redo
        </button>

        <button
          className={`chrome-search${searchOpen ? ' on' : ''}`}
          title="Find & replace (⌘F)"
          aria-pressed={searchOpen}
          disabled={!loaded}
          onClick={() => useBoard.getState().setSearchOpen(!searchOpen)}
        >
          Find
        </button>

        <button
          className={`chrome-objective${hasObjective ? ' set' : ''}`}
          // No node floor here, unlike Summary: writing the objective before
          // there is anything on the board is the point of having one.
          title={hasObjective ? 'Board objective (⌘J)' : 'Set a board objective (⌘J)'}
          onClick={() => setObjectiveOpen(!objectiveOpen)}
        >
          {hasObjective ? '●' : '○'} Objective
        </button>

        <button
          className={`chrome-privacy${privacy ? ' on' : ''}`}
          // No node floor, like Objective: a board can be declared private
          // before there is anything on it to keep private.
          title={
            privacy
              ? 'Privacy Mode on — nothing on this board is sent to a model (⌘⇧P)'
              : 'Privacy Mode off — the AI may read this board (⌘⇧P)'
          }
          aria-pressed={privacy}
          onClick={() => setPrivacy(!privacy)}
        >
          {privacy ? '●' : '○'} Private
        </button>

        <button
          className="chrome-ideas"
          title={
            canGenerate
              ? 'Generate ideas (⌘.)'
              : privacy
                ? 'Privacy Mode is on'
                : 'Needs an objective or at least one idea'
          }
          disabled={!canGenerate}
          onClick={() => setIdeasOpen(!ideasOpen)}
        >
          Ideas
        </button>

        <button
          className="chrome-present"
          title="Present this board (⌘⇧F)"
          disabled={!loaded}
          onClick={() => useBoard.getState().setPresenting(true)}
        >
          Present
        </button>

        {/* window.print() fires beforeprint, which mounts the sheets — the
            button carries no logic of its own, exactly like native ⌘P. */}
        <button
          className="chrome-print"
          title="Print this board (⌘P)"
          disabled={!loaded}
          onClick={() => window.print()}
        >
          Print
        </button>

        {/* Navigation, not a board action: leaving unmounts the canvas, whose
            cleanup flushes any unsaved edit fire-and-forget — the same exit the
            board switch takes. */}
        <Link className="chrome-home" href="/" title="All boards">
          Home
        </Link>

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

        {/* Hover or keyboard focus reveals the directions in passing; a press
            pins them, which is the only way in without a pointer that hovers.
            Escape closes it, as it closes every panel. */}
        <div className={`chrome-help-wrap ${helpOpen ? 'open' : ''}`}>
          <button
            className="chrome-help"
            aria-label="Canvas controls"
            aria-expanded={helpOpen}
            onClick={() => setHelpOpen((v) => !v)}
          >
            ?
          </button>
          <div className="chrome-help-tip">
            <span>Double-click to add an idea</span>
            <span>Drag the dot to connect</span>
            <span>Drag a corner to resize</span>
            <span>A− / A+ for text size</span>
            <span>D marks it done</span>
            <span>Shift+click or Shift+drag selects several</span>
            <span>On touch, hold instead of Shift</span>
            <span>Pinch to zoom</span>
            <span>Click a line to select it</span>
            <span>⌘Z / ⌘⇧Z to undo &amp; redo</span>
            <span>⌘F to find &amp; replace</span>
            <span>⌘P to print</span>
          </div>
        </div>
      </div>

      {open ? <BoardSwitcher onClose={() => setOpen(false)} currentId={board.id} /> : null}
      {searchOpen ? <SearchPanel /> : null}
      {ideasOpen ? <IdeasPanel /> : null}
      {objectiveOpen ? <ObjectivePanel onClose={() => setObjectiveOpen(false)} /> : null}
      {settingsOpen ? <SettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
    </>
  );
}
