/**
 * The boards you can start from (v3.0).
 *
 * There was one template before this — the tutorial — and the whole mechanism
 * was a `=== 'tutorial'` ternary in the POST route. A second one is what turns
 * that into a lookup. It is still barely a mechanism: a template is a pure
 * function from an id to a complete `Board`, and `createBoard` already accepts
 * a prebuilt board, so nothing here touches the database or the schema.
 *
 * `buildTemplate` returning null rather than throwing is the load-bearing part:
 * an absent, malformed or unknown template falls through to a blank board at
 * the call site, because **creating a board must never be refusable**. A person
 * who mistypes a template name gets a board, not an error.
 *
 * Pure and node-free, so the route and the tests import the same registry.
 */

import type { Board } from './graph';
import { kanbanBoard, KANBAN_TITLE } from './kanban';
import { mindMapBoard, MINDMAP_TITLE } from './mindmap';
import { swotBoard, SWOT_TITLE } from './swot';
import { tutorialBoard, TUTORIAL_TITLE } from './tutorial';

// Append-only: each id is the wire name a POST body may carry.
export const TEMPLATE_IDS = ['tutorial', 'kanban', 'swot', 'mindmap'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export const TEMPLATES: Record<TemplateId, { label: string; build: (id: string) => Board }> = {
  tutorial: { label: TUTORIAL_TITLE, build: tutorialBoard },
  kanban: { label: KANBAN_TITLE, build: kanbanBoard },
  swot: { label: SWOT_TITLE, build: swotBoard },
  mindmap: { label: MINDMAP_TITLE, build: mindMapBoard },
};

export function isTemplateId(v: unknown): v is TemplateId {
  return typeof v === 'string' && (TEMPLATE_IDS as readonly string[]).includes(v);
}

/** The named template, or null — which the caller reads as "a blank board". */
export function buildTemplate(v: unknown, id: string): Board | null {
  return isTemplateId(v) ? TEMPLATES[v].build(id) : null;
}
