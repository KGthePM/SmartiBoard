'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { centerOn, containsRect, rectOf, visibleRect } from '@/lib/graph';
import {
  findMatches,
  planReplaceAll,
  replaceInText,
  type Match,
  type SearchOptions,
} from '@/lib/search';
import { useBoard } from '@/lib/store';

/**
 * Find and Replace (⌘F). Deliberately *not* a scrim modal like the switcher or
 * the settings panel: the whole point is to keep looking at the board while you
 * step through it, so this is a bar pinned under the chrome with the canvas
 * live underneath. It borrows the switcher's internals — autofocus, keys handled
 * on the input rather than on window, a cursor clamped at render — and none of
 * its geometry.
 *
 * Finding spends nothing: no snapshot, no token, not in the fingerprint.
 * Replacing is an ordinary content edit and goes through one store action, so a
 * Replace All across the board is a single ⌘Z. See `replaceText` in lib/store.
 */

/** The matches on the current board, derived — never stored. */
export function useSearchMatches(): Match[] {
  const board = useBoard((s) => s.board);
  const query = useBoard((s) => s.searchQuery);
  const caseSensitive = useBoard((s) => s.searchCase);
  const wholeWord = useBoard((s) => s.searchWhole);

  return useMemo(
    () => findMatches(board, query, { caseSensitive, wholeWord }),
    [board, query, caseSensitive, wholeWord],
  );
}

/** The match being stood on, as an index that is always in range (or -1). */
export function activeIndex(matches: Match[], searchIndex: number): number {
  if (matches.length === 0) return -1;
  return Math.min(Math.max(searchIndex, 0), matches.length - 1);
}

export function SearchPanel() {
  const board = useBoard((s) => s.board);
  const query = useBoard((s) => s.searchQuery);
  const replacement = useBoard((s) => s.searchReplace);
  const caseSensitive = useBoard((s) => s.searchCase);
  const wholeWord = useBoard((s) => s.searchWhole);
  const searchIndex = useBoard((s) => s.searchIndex);

  const inputRef = useRef<HTMLInputElement>(null);
  /** What the last Replace did, said out loud. Cleared by the next search. */
  const [note, setNote] = useState('');

  const matches = useSearchMatches();
  const at = activeIndex(matches, searchIndex);
  const active = at >= 0 ? matches[at] : null;
  const unreplaceable = matches.filter((m) => !m.replaceable).length;

  const close = () => useBoard.getState().setSearchOpen(false);

  const step = (dir: 1 | -1) => {
    if (matches.length === 0) return;
    useBoard.getState().setSearchIndex((at + dir + matches.length) % matches.length);
  };

  // ⌘F while the bar is already open re-selects the query, the way a browser's
  // find bar does — you press it again to search for something else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'f' && !e.shiftKey) {
        e.preventDefault();
        inputRef.current?.select();
      } else if (k === 'g') {
        e.preventDefault();
        step(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // Deliberately no dependency array: ⌘G steps relative to the *current*
    // match list, and a mount-only handler would close over the list as it was
    // when the bar opened — which is empty. Re-binding per render is what the
    // other handlers avoid by reading useBoard.getState(); there is no
    // getState() for a value derived in the component.
  });

  /**
   * Walking to a match takes the canvas with it: the card is selected, and the
   * camera moves only when the card is not already fully on screen. Viewport
   * changes are hard cuts everywhere in this app, so re-centering on every step
   * would make the board lurch under a held-down ⌘G. The zoom is never touched.
   */
  const activeKey =
    active && active.target.kind === 'node' ? `${active.target.id}:${active.start}` : '';

  useEffect(() => {
    if (!activeKey) return;
    const id = activeKey.slice(0, activeKey.lastIndexOf(':'));
    const s = useBoard.getState();
    const node = s.board.nodes.find((n) => n.id === id);
    if (!node) return;

    s.select(node.id);
    const rect = rectOf(node);
    if (!containsRect(visibleRect(s.viewport, s.surface), rect)) {
      s.setViewport(centerOn(rect, s.surface, s.viewport.scale));
    }
  }, [activeKey]);

  const setQuery = (q: string) => {
    setNote('');
    useBoard.getState().setSearchQuery(q);
  };

  const setOptions = (o: Partial<SearchOptions>) => {
    setNote('');
    useBoard.getState().setSearchOptions(o);
  };

  const replaceActive = () => {
    if (!active?.replaceable) return;
    const store = useBoard.getState();
    const target = active.target;
    if (target.kind === 'objective') {
      store.replaceText([], replaceInText(board.objective, [active], replacement, false));
    } else {
      const node = board.nodes.find((n) => n.id === target.id);
      if (!node) return;
      store.replaceText([{ id: node.id, text: replaceInText(node.text, [active], replacement) }]);
    }
    setNote('');
  };

  const replaceAll = () => {
    const plan = planReplaceAll(board, query, { caseSensitive, wholeWord }, replacement);
    if (plan.replaced === 0 && plan.skipped === 0) return;
    useBoard.getState().replaceText(plan.nodes, plan.objective ?? undefined);
    // A skip has to be said out loud: a match still sitting there after you
    // pressed the button reads as a bug otherwise.
    setNote(
      plan.skipped
        ? `${plan.replaced} replaced · ${plan.skipped} left alone (spans formatting)`
        : `${plan.replaced} replaced`,
    );
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  };

  const count = !query
    ? ''
    : matches.length === 0
      ? 'no matches'
      : `${at + 1} of ${matches.length}`;

  return (
    <div className="search" role="search" aria-label="Find and replace">
      <div className="search-row">
        <input
          ref={inputRef}
          className="search-input"
          autoFocus
          placeholder="Find on this board…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className={`search-opt${caseSensitive ? ' on' : ''}`}
          aria-pressed={caseSensitive}
          title="Match case"
          onClick={() => setOptions({ caseSensitive: !caseSensitive })}
        >
          Aa
        </button>
        <button
          type="button"
          className={`search-opt${wholeWord ? ' on' : ''}`}
          aria-pressed={wholeWord}
          title="Whole word"
          onClick={() => setOptions({ wholeWord: !wholeWord })}
        >
          |ab|
        </button>
        <span className="search-count">{count}</span>
        <button
          type="button"
          className="search-nav"
          title="Previous match (⇧⏎)"
          aria-label="Previous match"
          disabled={matches.length === 0}
          onClick={() => step(-1)}
        >
          ‹
        </button>
        <button
          type="button"
          className="search-nav"
          title="Next match (⏎)"
          aria-label="Next match"
          disabled={matches.length === 0}
          onClick={() => step(1)}
        >
          ›
        </button>
        <button type="button" className="search-x" title="Close (Esc)" onClick={close}>
          ×
        </button>
      </div>

      <div className="search-row">
        <input
          className="search-input"
          placeholder="Replace with…"
          value={replacement}
          onChange={(e) => useBoard.getState().setSearchReplace(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="search-do"
          title={
            active && !active.replaceable
              ? 'This match spans formatting — replacing it would break the card'
              : 'Replace this match'
          }
          disabled={!active?.replaceable}
          onClick={replaceActive}
        >
          Replace
        </button>
        <button
          type="button"
          className="search-do"
          title="Replace every match on this board — one undo"
          disabled={matches.length === 0}
          onClick={replaceAll}
        >
          All
        </button>
      </div>

      {/* The objective is not on the canvas, so its matches are shown here
          rather than by opening ⌘J over the board you are searching. */}
      {active?.target.kind === 'objective' ? (
        <div className="search-where">
          <span className="search-where-tag">Objective</span>
          <span className="search-where-text">
            {board.objective.slice(Math.max(0, active.start - 24), active.start)}
            <mark className="find active">
              {board.objective.slice(active.start, active.end)}
            </mark>
            {board.objective.slice(active.end, active.end + 24)}
          </span>
        </div>
      ) : null}

      {note || unreplaceable ? (
        <div className="search-note">
          {note ||
            `${unreplaceable} ${unreplaceable === 1 ? 'match spans' : 'matches span'} formatting and cannot be replaced`}
        </div>
      ) : null}
    </div>
  );
}
