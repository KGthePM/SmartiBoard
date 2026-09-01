/**
 * The Kanban template (v3.0): the second board you can start from.
 *
 * Smarti has no column concept and is not getting one. A column here is a
 * *position* — four header cards with work arranged beneath them — and nothing
 * snaps, nothing is enforced, and dragging a card under "Done" does not cross
 * it off. That is deliberate rather than unfinished: `done` is content the
 * model reads (it is in the fingerprint and in the prompt), so a rule that set
 * it from an x coordinate would make a drag start spending tokens, and moving
 * a card would quietly become an edit. The ✓ stays the person's to press.
 *
 * So the template is exactly what the tutorial board is: ordinary content,
 * arranged so that reading it is using it. It is editable, archivable,
 * deletable, autosaving, counted in the index; wrecking it is allowed; nothing
 * in the schema knows it exists.
 *
 * Edges run header → card rather than card → card, which is the one piece of
 * structure a Kanban actually has. An edgeless board would render as a blank
 * minimap and read to the model as a pile of unrelated sentences; this way the
 * graph says which column each item is in, which is the whole point of keeping
 * a typed graph rather than a pixel canvas.
 *
 * Pure — no db, no DOM — so the route, the registry and the tests all import
 * the same thing. Fresh ids per call: two Kanban boards may coexist, so nothing
 * here may be a hardcoded id.
 */

import { createNode, newId, type Board, type Edge, type IdeaNode } from './graph';

export const KANBAN_TITLE = 'Kanban board';

/**
 * Non-empty, and load-bearing for the same reason the tutorial's is: an
 * objective is what satisfies `canGenerateIdeas`, so ⌘. is live on a fresh
 * Kanban board from the first second — before there is enough on it to satisfy
 * the ghost's 3-idea floor.
 */
export const KANBAN_OBJECTIVE =
  'Track work in flight: one card per item, moved left to right as it progresses.';

/** Where each column starts. A column is an x coordinate and nothing else. */
const COL_X = [0, 300, 600, 900];
const HEAD_Y = 0;
const FIRST_Y = 100;
/** Enough for a card plus a breath, so a column reads as a column. */
const ROW_H = 130;

type Column = { title: string; cards: { text: string; done?: boolean }[] };

const COLUMNS: Column[] = [
  {
    title: '**Backlog**',
    cards: [
      { text: 'Everything not started yet. Double-click the space below to add one.' },
      { text: 'Drag a card to the right when you pick it up — a column is just a place.' },
    ],
  },
  {
    title: '**Doing**',
    cards: [{ text: 'What is actually in flight right now. Keep this column short.' }],
  },
  {
    title: '**Blocked**',
    cards: [{ text: 'Waiting on something. Say what, so the board can answer for you.' }],
  },
  {
    title: '**Done**',
    cards: [
      {
        text: 'Finished. Press **D** on a card to cross it off — the column and the ✓ are separate, and both are yours.',
        done: true,
      },
    ],
  },
];

export function kanbanBoard(id: string): Board {
  const t = Date.now();
  let seq = 0;
  // Ordered createdAt, so the minimap and `deriveTitle` read the board in the
  // order it was written rather than in whatever order the clock ticked.
  const card = (partial: Partial<IdeaNode> & Pick<IdeaNode, 'x' | 'y'>): IdeaNode =>
    createNode({ ...partial, createdAt: t + seq++ });

  const nodes: IdeaNode[] = [];
  const edges: Edge[] = [];

  COLUMNS.forEach((col, i) => {
    const head = card({
      x: COL_X[i],
      y: HEAD_Y,
      w: 240,
      h: 56,
      // On the font ladder (NODE_FONT_STEPS), so nothing snaps on reload.
      fontSize: 21,
      text: col.title,
    });
    nodes.push(head);

    col.cards.forEach((c, k) => {
      const n = card({
        x: COL_X[i],
        y: FIRST_Y + k * ROW_H,
        w: 240,
        h: 110,
        text: c.text,
        done: c.done ?? false,
      });
      nodes.push(n);
      edges.push(edge(head, n));
    });
  });

  return {
    id,
    title: KANBAN_TITLE,
    objective: KANBAN_OBJECTIVE,
    // Not private, like the tutorial: the ghost reading a work board and
    // proposing the item nobody has written down yet is the product working.
    privacy: false,
    nodes,
    edges,
    updatedAt: t,
  };
}

function edge(from: IdeaNode, to: IdeaNode): Edge {
  return { id: newId('e'), from: from.id, to: to.id, layer: 'user' };
}
