'use client';

import { useEffect, useRef } from 'react';
import { OBJECTIVE_MAX } from '@/lib/graph';
import { useBoard } from '@/lib/store';

/**
 * What this board is for, written by the person and read by the model.
 *
 * The one field here is bound straight to the board — no local draft, no Save
 * button, no fetch of its own. An objective is board content, so it rides the
 * same 700ms autosave a node edit does; there is no save button anywhere in
 * this app and this is not the place to introduce one.
 *
 * Nothing in this panel is ever model-written. The objective is the person's
 * framing of their own work, and a model that rewrote or summarized it would
 * be answering a question nobody asked.
 */
export function ObjectivePanel({ onClose }: { onClose: () => void }) {
  const objective = useBoard((s) => s.board.objective);
  const setObjective = useBoard((s) => s.setObjective);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Open with the cursor at the end, not over a selection: reopening is
    // usually to add a line, and a select-all makes the next keystroke a delete.
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const left = OBJECTIVE_MAX - objective.length;

  return (
    <div className="objective-back" onPointerDown={onClose}>
      <div
        className="objective"
        role="dialog"
        aria-label="Board objective"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="objective-head">
          <span className="objective-title">Objective</span>
          <button className="objective-x" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </div>

        <textarea
          ref={ref}
          className="objective-input"
          value={objective}
          maxLength={OBJECTIVE_MAX}
          rows={6}
          placeholder="What is this board for? A goal, who it's for, anything the plan can't do."
          onChange={(e) => setObjective(e.target.value)}
        />

        <div className="objective-foot">
          <span className="objective-hint">
            Shapes what the AI suggests and how it reads your board.
          </span>
          <span className={`objective-count${left <= 40 ? ' tight' : ''}`}>
            {objective.length} / {OBJECTIVE_MAX}
          </span>
        </div>
      </div>
    </div>
  );
}
