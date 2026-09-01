/**
 * The SWOT template (v3.2): the third board you can start from.
 *
 * The Kanban's doctrine, one quadrant at a time. Smarti has no quadrant
 * concept and is not getting one: a quadrant here is a *position* — four
 * header cards at the corners of a 2×2, with the ideas each collects beneath
 * them. Nothing snaps, nothing is enforced, and dragging a card from
 * Strengths to Threats does not make it a threat. The sorting is the
 * exercise, so the sorting stays the person's.
 *
 * Internal on the top row (Strengths, Weaknesses), external below
 * (Opportunities, Threats) — the layout every strategy deck already draws,
 * so the board reads at a glance on a projector, which is what presentation
 * mode was built for.
 *
 * No done card ships here, unlike the Kanban: nothing in a SWOT is finished,
 * and the ✓ already has two demos (the tutorial teaches it, the Kanban shows
 * it). Edges run header → card, as in a Kanban column — the one piece of
 * structure a quadrant has, and what lets the minimap and the model read the
 * board as four buckets rather than a pile of sentences.
 *
 * Pure — no db, no DOM — so the registry and the tests import the same thing.
 * Fresh ids per call: two SWOT boards may coexist, so nothing here may be a
 * hardcoded id.
 */

import { createNode, newId, type Board, type Edge, type IdeaNode } from './graph';

export const SWOT_TITLE = 'SWOT analysis';

/**
 * Non-empty and load-bearing, like both templates before it: an objective is
 * what satisfies `canGenerateIdeas`, so ⌘. is live on a fresh SWOT board from
 * the first second — and a half-filled SWOT is exactly the board worth asking.
 */
export const SWOT_OBJECTIVE =
  'Size up a plan honestly: strengths and weaknesses inside, opportunities and threats outside — one card each.';

/** Where each quadrant starts. A quadrant is an (x, y) pair and nothing else. */
const QUAD_X = [0, 340];
const QUAD_Y = [0, 400];
const HEAD_H = 56;
const FIRST_GAP = 100;
/** Enough for a card plus a breath, so a quadrant reads as a quadrant. */
const ROW_H = 130;

type Quadrant = { title: string; cards: string[] };

/** Reading order: internal across the top, external across the bottom. */
const QUADRANTS: Quadrant[] = [
  {
    title: '**Strengths**',
    cards: [
      'What you are already good at — one card each, concrete enough that you would defend it in a pitch.',
      'Double-click the space below me to write your first.',
    ],
  },
  {
    title: '**Weaknesses**',
    cards: ['What works against you from the inside. The honest ones are the useful ones.'],
  },
  {
    title: '**Opportunities**',
    cards: [
      'Openings outside your control that you could ride — a shift, a tool, a rival stumbling.',
      'Half full is the moment to press **⌘.** — the candidates it streams in build on what is already here.',
    ],
  },
  {
    title: '**Threats**',
    cards: ['Outside forces that could hurt you. Naming one is the start of answering it.'],
  },
];

export function swotBoard(id: string): Board {
  const t = Date.now();
  let seq = 0;
  // Ordered createdAt, so the minimap and `deriveTitle` read the board in the
  // order it was written rather than in whatever order the clock ticked.
  const card = (partial: Partial<IdeaNode> & Pick<IdeaNode, 'x' | 'y'>): IdeaNode =>
    createNode({ ...partial, createdAt: t + seq++ });

  const nodes: IdeaNode[] = [];
  const edges: Edge[] = [];

  QUADRANTS.forEach((quad, i) => {
    const x = QUAD_X[i % 2];
    const y = QUAD_Y[Math.floor(i / 2)];

    const head = card({
      x,
      y,
      w: 240,
      h: HEAD_H,
      // On the font ladder (NODE_FONT_STEPS), so nothing snaps on reload.
      fontSize: 21,
      text: quad.title,
    });
    nodes.push(head);

    quad.cards.forEach((text, k) => {
      const n = card({
        x,
        y: y + FIRST_GAP + k * ROW_H,
        w: 240,
        h: 110,
        text,
      });
      nodes.push(n);
      edges.push(edge(head, n));
    });
  });

  return {
    id,
    title: SWOT_TITLE,
    objective: SWOT_OBJECTIVE,
    // Not private, like the tutorial and the Kanban: the ghost naming the
    // threat nobody has written down is the product working.
    privacy: false,
    nodes,
    edges,
    updatedAt: t,
  };
}

function edge(from: IdeaNode, to: IdeaNode): Edge {
  return { id: newId('e'), from: from.id, to: to.id, layer: 'user' };
}
