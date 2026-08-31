'use client';

import { useEffect, useRef, useState } from 'react';
import type { IdeaNode } from '@/lib/graph';
import type { Match } from '@/lib/search';
import {
  PALETTE,
  stripMarks,
  toggleColor,
  toggleWrap,
  type ColorKey,
  type Edit,
} from '@/lib/richtext';
import { REACTIONS, REACTION_GLYPH, REACTION_LABEL, type ReactionKey } from '@/lib/reactions';
import { viewRect, type CollapseView } from '@/lib/collapse';
import { DRAG_SLOP } from '@/lib/gesture';
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
  /**
   * How this card is drawn: a one-line stub, a dot, or null for an ordinary
   * card. Folded means done, with the setting on and no peek open (v2.8). A
   * view of `done` and nothing more — the node is untouched, so expanding
   * restores the card exactly as it was.
   */
  view: CollapseView | null;
  /** The fold control belongs on this card: the setting is on and it is done. */
  foldable: boolean;
  onCardDown: (e: React.PointerEvent) => void;
  /** Double-click: collapse the selection to this card and edit it. */
  onEdit: () => void;
  onChange: (text: string, format?: boolean) => void;
  onPortDown: (e: React.PointerEvent) => void;
  onResizeStart: (e: React.PointerEvent) => void;
  onAdjustFont: (dir: 1 | -1) => void;
  onToggleDone: () => void;
  onToggleFold: () => void;
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
  view,
  foldable,
  onCardDown,
  onEdit,
  onChange,
  onPortDown,
  onResizeStart,
  onAdjustFont,
  onToggleDone,
  onToggleFold,
  onToggleReaction,
  onDelete,
}: Props) {
  /** Folded either way. The dot is the fold that also gives up its width. */
  const collapsed = view !== null;
  const dot = view === 'dot';
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
  /**
   * Where a press on the dot's face began.
   *
   * The dot wears its ▸ as its whole surface, so — unlike every other control
   * on a card — that button must let the press through to the card underneath
   * or a dot could not be dragged, selected, or long-pressed. What comes back
   * is the browser's own rule that a `click` fires after a press and release on
   * the same element however far it travelled in between, which would open
   * every dot the person merely moved. So the click is guarded by the same 3px
   * that already tells a card drag from a click.
   */
  const dotPressAt = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    // Newly created nodes are empty and should be ready to type into — but
    // only when this card is the whole selection: shift-clicking an empty
    // card into a multi-selection must not jump it into editing.
    if (selected && sole && node.text === '' && !collapsed) setEditing(true);
  }, [selected, sole, node.text, collapsed]);

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
      className={`card ${editing ? 'editing' : ''} ${node.layer === 'accepted' ? 'accepted' : ''} ${node.done ? 'done' : ''} ${collapsed ? 'collapsed' : ''} ${dot ? 'dot' : ''} ${dot && matches.length > 0 ? 'dot-hit' : ''} ${selected ? 'selected' : ''}`}
      // A dot shows no text at all, so the card says what it is the one way
      // that costs nothing: the browser's own tooltip, on the readable text.
      title={dot ? stripMarks(node.text) : undefined}
      style={{
        left: node.x,
        top: node.y,
        // A fold's size comes from viewRect, the same measure the edges that
        // meet this card and the rubber band that catches it read. The node's
        // own w/h are never written, which is what makes expanding exact.
        width: viewRect(node, view).w,
        height: viewRect(node, view).h,
        fontSize: node.fontSize,
      }}
      onPointerDown={(e) => onCardDown(e)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        // A stub has nothing to edit, so the gesture that would open it for
        // typing opens it for reading instead — and saves hunting for the
        // fold control.
        if (collapsed) {
          onToggleFold();
          return;
        }
        // A double-click edits this card, and only this card.
        onEdit();
        setEditing(true);
      }}
    >
      {editing && !collapsed ? (
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
      ) : dot ? null : (
        <div className="rt">
          {/* Read view only: the edit view is a textarea over the raw marked-up
              text, where a match's offsets do not even mean the same thing. */}
          <RichTextView text={node.text} matches={matches} activeMatch={activeMatch} />
        </div>
      )}
      {/* The mirror of the × at the opposite corner: cross the idea off.
          A dot has no room for it: three 18px circles cannot share a 28px
          edge, and the dot's own shape already says the card is done. It, the
          ×, the A± pair and the resize bracket all come back the moment the
          ▸ opens the card, which is the one control a dot always shows. */}
      {dot ? null : (
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
      )}
      {/* Fold (v2.8): only on a done card, and only while the setting is on —
          there is nothing to fold otherwise. Top-centre is the one edge with
          no affordance on it (✓ top-left, × top-right, port right, resize
          bottom-right, A± bottom-left), and it sits identically on a full card
          and on a 28px stub. On a dot (v2.9) it is not a pip at all: it is the
          dot's whole face, which is why the press has to fall through it. */}
      {foldable ? (
        <button
          type="button"
          className="fold"
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand card' : 'Collapse card'}
          // A dot's face carries no title of its own, so the card's tooltip —
          // the text this dot is standing for — is what the hover reveals. It
          // is the more useful of the two, and the aria-label still says what
          // pressing does.
          title={dot ? undefined : collapsed ? 'Expand' : 'Collapse'}
          onPointerDown={(e) => {
            // On a dot this button *is* the card's face, so it lets the press
            // through — see dotPressAt. Everywhere else it is a pip on the
            // card's edge and swallows the press like every other control.
            if (!dot) {
              e.stopPropagation();
              return;
            }
            dotPressAt.current = { x: e.clientX, y: e.clientY };
          }}
          onClick={(e) => {
            e.stopPropagation();
            if (dot) {
              const from = dotPressAt.current;
              dotPressAt.current = null;
              // The press became a drag: the card has just been moved, and
              // moving a card is not asking to read it.
              if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > DRAG_SLOP) return;
            }
            onToggleFold();
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      ) : null}
      {dot ? null : (
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
      )}
      {/* The text size pair, at the one free corner. Presentation, like the
          resize bracket it sits beside — the ladder ends hold, so holding a
          click can never run away. */}
      {/* Neither of these means anything on a stub: its height is not the
          node's, and its one line of text is already clipped. */}
      {collapsed ? null : (
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
      )}
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
        {/* A stub is a summary, so it shows only the marks that were placed —
            the print sheet's rule. The "all five slots always" rule above is
            about aiming at a hover target, which a folded card has no room
            for anyway. */}
        {(collapsed ? REACTIONS.filter((k) => node.reactions.includes(k)) : REACTIONS).map(
          (key) => {
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
          },
        )}
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
      {collapsed ? null : (
        <div
          className="resize"
          title="Drag to resize"
          onPointerDown={(e) => {
            e.stopPropagation();
            onResizeStart(e);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );
}
