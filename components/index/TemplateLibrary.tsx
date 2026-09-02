'use client';

import { useEffect } from 'react';
import { TEMPLATE_IDS, TEMPLATES, type TemplateId } from '@/lib/templates';

/**
 * The template library (v3.4): every board you can start from, in one modal.
 *
 * The index's starter row used to grow a tile per template, pushing the
 * person's own boards further down their home page with every addition — and
 * each description lived in a `title` tooltip a finger cannot hover. The
 * library is the UI the registry already wanted: it renders `TEMPLATES`
 * itself, so a template remains one registry entry and nothing else.
 *
 * The tutorial is listed here like any other template while keeping its quiet
 * header line on the index — both are doors to the same ordinary board. Pure
 * index furniture: boards are created through the same `create` closure the
 * starter tiles use, so the route, the store, and the board are untouched.
 */
export function TemplateLibrary({
  onClose,
  onPick,
  busy,
}: {
  onClose: () => void;
  onPick: (id: TemplateId) => void;
  busy: boolean;
}) {
  // Escape closes it, as it closes every panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="tplib-back" onPointerDown={onClose}>
      <div
        className="tplib"
        role="dialog"
        aria-label="Template library"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="tplib-head">
          <span className="tplib-title">Start from a template</span>
          <button className="tplib-x" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="tplib-grid">
          {TEMPLATE_IDS.map((id) => (
            <button
              className="tplib-card"
              key={id}
              disabled={busy}
              onClick={() => onPick(id)}
            >
              <span className="tplib-icon" aria-hidden="true">
                {TEMPLATES[id].icon}
              </span>
              <span className="tplib-name">{TEMPLATES[id].label}</span>
              <span className="tplib-blurb">{TEMPLATES[id].blurb}</span>
            </button>
          ))}
        </div>

        <p className="tplib-foot">
          A template is ordinary content — every card, column and quadrant it
          ships can be moved, edited or deleted. Nothing about the board it
          becomes is special.
        </p>
      </div>
    </div>
  );
}
