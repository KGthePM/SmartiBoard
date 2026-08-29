'use client';

import { useEffect, useRef, useState } from 'react';
import type { IdeaNode } from '@/lib/graph';
import type { Match } from '@/lib/search';
import { PALETTE, toggleColor, toggleWrap, type ColorKey, type Edit } from '@/lib/richtext';
import { REACTIONS, REACTION_GLYPH, REACTION_LABEL, type ReactionKey } from '@/lib/reactions';
import { RichTextView } from './RichTextView';

type Props = {
  node: IdeaNode;
  /** Search hits in this card's readable text, in order. Empty when idle. */
  matches: Match[];
  /** Which of this card's matches is the one being stood on, if any. */
  activeMatch: number | null;
  /** In the selection — one card or many. */
  selected: boolean;
  /** This card is the entire selection. Gates the empty-card auto-edit. */
  sole: boolean;
  onCardDown: (e: React.PointerEvent) => void;
  /** Double-click: collapse the selection to this card and edit it. */
  onEdit: () => void;
  onChange: (text: string, format?: boolean) => void;
  onPortDown: (e: React.PointerEvent) => void;
  onResizeStart: (e: React.PointerEvent) => void;
  onAdjustFont: (dir: 1 | -1) => void;
  onToggleDone: () => void;
  onToggleReaction: (key: ReactionKey) => void;
  onDelete: () => void;
};

/**
 * The canvas card. The read view itself lives in RichTextView, shared with
 * the print sheet; everything else here is editing surface.
 */

export function NodeCard({
  node,
  matches,
  activeMatch,
  selected,
  sole,
  onCardDown,
  onEdit,
  onChange,
  onPortDown,
  onResizeStart,
  onAdjustFont,
  onToggleDone,
  onToggleReaction,
  onDelete,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [editing, setEditing] = useState(false);
  // Selection to restore after a toolbar toggle re-renders the textarea.
  const pendingSelection = useRef<[number, number] | null>(null);
  /**
   * When a press last landed on this card's own toolbar.
   *
   * A mouse never needs this: the buttons cancel mousedown, so focus never
   * leaves the textarea. A tap on iOS is not so obliging — it dismisses the
   * keyboard and blurs before the click lands, and `relatedTarget` is null, so
   * there is nothing in the blur event itself to tell a toolbar tap from a tap
   * out on the canvas. This remembers, and the blur handler puts the focus back
   * instead of ending the session under the finger that was about to press B.
   */
  const toolbarPressAt = useRef(0);

  useEffect(() => {
    // Newly created nodes are empty and should be ready to type into — but
    // only when this card is the whole selection: shift-clicking an empty
    // card into a multi-selection must not jump it into editing.
    if (selected && sole && node.text === '') setEditing(true);
  }, [selected, sole, node.text]);

  useEffect(() => {
    if (!editing) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(node.text.length, node.text.length);
  }, [editing]);

  useEffect(() => {
    const el = ref.current;
    const sel = pendingSelection.current;
    if (!el || !sel) return;
    pendingSelection.current = null;
    el.focus();
    el.setSelectionRange(sel[0], sel[1]);
  }, [node.text]);

  const applyFormat = (r: Edit) => {
    if (r.text === node.text) return;
    pendingSelection.current = [r.start, r.end];
    onChange(r.text, true);
  };

  const wrapSelection = (open: string, close: string) => {
    const el = ref.current;
    if (!el || el.selectionStart === el.selectionEnd) return;
    applyFormat(toggleWrap(el.value, el.selectionStart, el.selectionEnd, open, close));
  };

  const colorSelection = (color: ColorKey) => {
    const el = ref.current;
    if (!el || el.selectionStart === el.selectionEnd) return;
    applyFormat(toggleColor(el.value, el.selectionStart, el.selectionEnd, color));
  };

  return (
    <div
      className={`card ${editing ? 'editing' : ''} ${node.layer === 'accepted' ? 'accepted' : ''} ${node.done ? 'done' : ''} ${selected ? 'selected' : ''}`}
      style={{ left: node.x, top: node.y, width: node.w, height: node.h, fontSize: node.fontSize }}
      onPointerDown={(e) => onCardDown(e)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        // A double-click edits this card, and only this card.
        onEdit();
        setEditing(true);
      }}
    >
      {editing ? (
        <>
          {/* Buttons keep the textarea's focus so a toolbar press never ends
              the editing session: a mouse by cancelling mousedown, a finger by
              way of `toolbarPressAt` and the blur handler below. */}
          <div
            className="rt-bar"
            onPointerDown={(e) => {
              e.stopPropagation();
              toolbarPressAt.current = Date.now();
            }}
          >
            <button type="button" className="f-b" aria-label="Bold" title="Bold (⌘B)"
              onMouseDown={(e) => e.preventDefault()} onClick={() => wrapSelection('**', '**')}>
              B
            </button>
            <button type="button" className="f-i" aria-label="Italic" title="Italic (⌘I)"
              onMouseDown={(e) => e.preventDefault()} onClick={() => wrapSelection('*', '*')}>
              I
            </button>
            <button type="button" className="f-u" aria-label="Underline" title="Underline (⌘U)"
              onMouseDown={(e) => e.preventDefault()} onClick={() => wrapSelection('__', '__')}>
              U
            </button>
            <button type="button" className="f-s" aria-label="Strikethrough" title="Strikethrough"
              onMouseDown={(e) => e.preventDefault()} onClick={() => wrapSelection('~~', '~~')}>
              S
            </button>
            <span className="rt-swatches">
              {PALETTE.map((c) => (
                <button key={c} type="button" className={`rt-sw rt-sw-${c}`}
                  aria-label={`Text color: ${c}`} title={c}
                  onMouseDown={(e) => e.preventDefault()} onClick={() => colorSelection(c)}
                />
              ))}
            </span>
          </div>
          <textarea
            ref={ref}
            value={node.text}
            placeholder="an idea…"
            onChange={(e) => onChange(e.target.value)}
            onPointerDown={(e) => {
              // Only while editing does the textarea own the pointer (text selection);
              // otherwise it is pointer-events:none so the whole card drags.
              if (editing) e.stopPropagation();
            }}
            onBlur={() => {
              // A toolbar press is not leaving the card, whatever the browser
              // thinks focus just did.
              if (Date.now() - toolbarPressAt.current < 700) {
                ref.current?.focus();
                return;
              }
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                ref.current?.blur();
                return;
              }
              if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
                const k = e.key.toLowerCase();
                if (k === 'b') {
                  e.preventDefault();
                  wrapSelection('**', '**');
                } else if (k === 'i') {
                  e.preventDefault();
                  wrapSelection('*', '*');
                } else if (k === 'u') {
                  e.preventDefault();
                  wrapSelection('__', '__');
                }
              }
            }}
          />
        </>
      ) : (
        <div className="rt">
          {/* Read view only: the edit view is a textarea over the raw marked-up
              text, where a match's offsets do not even mean the same thing. */}
          <RichTextView text={node.text} matches={matches} activeMatch={activeMatch} />
        </div>
      )}
      {/* The mirror of the × at the opposite corner: cross the idea off. */}
      <button
        type="button"
        className="tick"
        aria-pressed={node.done}
        aria-label={node.done ? 'Mark as not done' : 'Mark as done'}
        title={node.done ? 'Mark as not done (D)' : 'Mark as done (D)'}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onToggleDone();
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        ✓
      </button>
      <button
        type="button"
        className="del"
        aria-label="Delete node"
        title="Delete"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        ×
      </button>
      {/* The text size pair, at the one free corner. Presentation, like the
          resize bracket it sits beside — the ladder ends hold, so holding a
          click can never run away. */}
      <div
        className="fs"
        onPointerDown={(e) => {
          e.stopPropagation();
          toolbarPressAt.current = Date.now();
        }}
      >
        <button
          type="button"
          className="fs-down"
          aria-label="Smaller text"
          title="Smaller text"
          onMouseDown={(e) => e.preventDefault()}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onAdjustFont(-1);
          }}
        >
          A
        </button>
        <button
          type="button"
          className="fs-up"
          aria-label="Larger text"
          title="Larger text"
          onMouseDown={(e) => e.preventDefault()}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onAdjustFont(1);
          }}
        >
          A
        </button>
      </div>
      {/* Reactions (v2.7): how you feel about the idea, said to the board and
          not to the model. All five slots are always rendered, and the unchosen
          ones only fade — so the glyph you want never moves between the resting
          card and the hovered one, and the click is not a gamble. Below the
          card rather than inside it: a card at the height floor has no room to
          give, and a mark you have to hover to see is not a mark. */}
      <div
        className="reactions"
        onPointerDown={(e) => {
          e.stopPropagation();
          toolbarPressAt.current = Date.now();
        }}
      >
        {REACTIONS.map((key) => {
          const on = node.reactions.includes(key);
          return (
            <button
              key={key}
              type="button"
              className={`react ${on ? 'on' : ''}`}
              aria-pressed={on}
              aria-label={REACTION_LABEL[key]}
              title={REACTION_LABEL[key]}
              onMouseDown={(e) => e.preventDefault()}
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onToggleReaction(key);
              }}
            >
              {REACTION_GLYPH[key]}
            </button>
          );
        })}
      </div>
      <div
        className="port"
        title="Drag to connect"
        onPointerDown={(e) => {
          e.stopPropagation();
          onPortDown(e);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      />
      <div
        className="resize"
        title="Drag to resize"
        onPointerDown={(e) => {
          e.stopPropagation();
          onResizeStart(e);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
