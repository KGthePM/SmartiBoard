'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { IdeaNode } from '@/lib/graph';
import {
  PALETTE,
  parseRichText,
  toggleColor,
  toggleWrap,
  type ColorKey,
  type Edit,
  type Segment,
} from '@/lib/richtext';

type Props = {
  node: IdeaNode;
  selected: boolean;
  onSelect: () => void;
  onChange: (text: string, format?: boolean) => void;
  onDragStart: (e: React.PointerEvent) => void;
  onPortDown: (e: React.PointerEvent) => void;
  onResizeStart: (e: React.PointerEvent) => void;
  onAdjustFont: (dir: 1 | -1) => void;
  onToggleDone: () => void;
  onDelete: () => void;
};

function markClasses(s: Segment): string {
  return [
    s.bold && 'rt-b',
    s.italic && 'rt-i',
    s.underline && 'rt-u',
    s.strike && 'rt-s',
    s.color && `rt-c-${s.color}`,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * The read view. Segments become React spans — never innerHTML — so stored
 * text can never inject markup.
 */
function RichTextView({ text }: { text: string }) {
  const segments = useMemo(() => parseRichText(text), [text]);
  if (segments.length === 0) return null;
  return (
    <>
      {segments.map((s, i) => (
        <span key={i} className={markClasses(s)}>
          {s.text}
        </span>
      ))}
    </>
  );
}

export function NodeCard({
  node,
  selected,
  onSelect,
  onChange,
  onDragStart,
  onPortDown,
  onResizeStart,
  onAdjustFont,
  onToggleDone,
  onDelete,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [editing, setEditing] = useState(false);
  // Selection to restore after a toolbar toggle re-renders the textarea.
  const pendingSelection = useRef<[number, number] | null>(null);

  useEffect(() => {
    // Newly created nodes are empty and should be ready to type into.
    if (selected && node.text === '') setEditing(true);
  }, [selected, node.text]);

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
      onPointerDown={(e) => {
        onSelect();
        onDragStart(e);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
    >
      {editing ? (
        <>
          {/* Buttons keep the textarea's focus (mousedown is prevented) so a
              toolbar click never ends the editing session. */}
          <div className="rt-bar" onPointerDown={(e) => e.stopPropagation()}>
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
            onBlur={() => setEditing(false)}
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
          <RichTextView text={node.text} />
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
      <div className="fs" onPointerDown={(e) => e.stopPropagation()}>
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
