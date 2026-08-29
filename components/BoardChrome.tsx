'use client';

import { useEffect, useRef, useState } from 'react';
import { canGenerateIdeas } from '@/lib/ai/trigger';
import { boardTitle } from '@/lib/boards';
import { useBoard } from '@/lib/store';
import { BoardSwitcher } from './BoardSwitcher';
import { ObjectivePanel } from './ObjectivePanel';
import { SettingsPanel } from './SettingsPanel';
import { IdeasPanel } from './IdeasPanel';

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
  const setObjectiveOpen = useBoard((s) => s.setObjectiveOpen);
  const hasObjective = useBoard((s) => s.board.objective.trim().length > 0);
  const privacy = useBoard((s) => s.board.privacy);
  const setPrivacy = useBoard((s) => s.setPrivacy);
  const canUndo = useBoard((s) => s.undoStack.length > 0);
  const canRedo = useBoard((s) => s.redoStack.length > 0);

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

        {/* Hover or keyboard focus reveals the directions; click just focuses
            the button, which holds the tip open until focus moves on. */}
        <div className="chrome-help-wrap">
          <button className="chrome-help" aria-label="Canvas controls">
            ?
          </button>
          <div className="chrome-help-tip">
            <span>Double-click to add an idea</span>
            <span>Drag the dot to connect</span>
            <span>Drag a corner to resize</span>
            <span>A− / A+ for text size</span>
            <span>D marks it done</span>
            <span>Click a line to select it</span>
            <span>⌘Z / ⌘⇧Z to undo &amp; redo</span>
          </div>
        </div>
      </div>

      {open ? <BoardSwitcher onClose={() => setOpen(false)} currentId={board.id} /> : null}
      {ideasOpen ? <IdeasPanel /> : null}
      {objectiveOpen ? <ObjectivePanel onClose={() => setObjectiveOpen(false)} /> : null}
      {settingsOpen ? <SettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
    </>
  );
}
