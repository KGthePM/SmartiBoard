/**
 * The Mind map template (v3.2): the fourth board you can start from.
 *
 * The shape a whiteboard owns and a document does not: one topic in the
 * middle, themes branching off it, and branches off the branches. The edges
 * are the feature — a hub-and-spoke board renders as a star in the minimap
 * and reads to the model as a tree, which is exactly the structure the ghost
 * and the idea generator know how to extend ("this branch is thin" is only
 * sayable about a graph).
 *
 * One branch ships with a child of its own, because a mind map that stops at
 * one ring is a list. That child is the connect lesson: dragging from a
 * card's dot is how the tree gets deeper, and the template shows the result
 * rather than describing it.
 *
 * Like every template it is ordinary content — positions, not concepts.
 * Nothing snaps, the hub is not special (delete it and the spokes survive,
 * like any card), and no done card ships because nothing on a fresh map is
 * finished. Pure — no db, no DOM. Fresh ids per call, so two Mind map boards
 * may coexist.
 */

import { createNode, newId, type Board, type Edge, type IdeaNode } from './graph';

export const MINDMAP_TITLE = 'Mind map';

/**
 * Non-empty, like both templates before it, so ⌘. is live from the first
 * second — a map with four themes on it is already worth asking for more.
 */
export const MINDMAP_OBJECTIVE =
  'Map a topic from the middle out: themes branch off the center, and every branch can grow its own.';

export function mindMapBoard(id: string): Board {
  const t = Date.now();
  let seq = 0;
  // Ordered createdAt, so the minimap and `deriveTitle` read the board in the
  // order it was written rather than in whatever order the clock ticked.
  const card = (partial: Partial<IdeaNode> & Pick<IdeaNode, 'x' | 'y'>): IdeaNode =>
    createNode({ ...partial, createdAt: t + seq++ });

  // The topic, dead center and the biggest thing on the board — the one card
  // a stranger's eye lands on first.
  const hub = card({
    x: 390,
    y: 300,
    w: 280,
    h: 120,
    // Top rung of the font ladder (NODE_FONT_STEPS), so nothing snaps on reload.
    fontSize: 26,
    text: '**The topic.** Rename me — everything else grows out from here.',
  });

  // Two themes a side, wide of the hub so the spokes have room to be seen.
  const branchA = card({
    x: 0,
    y: 100,
    w: 240,
    h: 110,
    text: 'A theme. Drag from the dot on my edge to link a card of your own under me.',
  });

  const branchB = card({
    x: 0,
    y: 480,
    w: 240,
    h: 110,
    text: 'Another theme. Rename or delete me — the shape is yours, not the template’s.',
  });

  const branchC = card({
    x: 820,
    y: 100,
    w: 240,
    h: 110,
    text: 'A third theme. This one already has a child of its own…',
  });

  // The tree-depth lesson, one ring below its parent.
  const leaf = card({
    x: 820,
    y: 300,
    w: 240,
    h: 110,
    text: '…like this. A branch can hold branches: link, then keep going.',
  });

  const branchD = card({
    x: 820,
    y: 480,
    w: 240,
    h: 110,
    text: 'The fourth theme. When the map thins out, press **⌘.** and ask for candidates.',
  });

  const nodes = [hub, branchA, branchB, branchC, leaf, branchD];

  // Hub → branch, and one branch → leaf: a tree, not a star. Every node is
  // linked, so the minimap renders the whole board from the first second.
  const edges: Edge[] = [
    edge(hub, branchA),
    edge(hub, branchB),
    edge(hub, branchC),
    edge(branchC, leaf),
    edge(hub, branchD),
  ];

  return {
    id,
    title: MINDMAP_TITLE,
    objective: MINDMAP_OBJECTIVE,
    // Not private, like the tutorial: a ghost proposing the branch the map is
    // missing is the product working.
    privacy: false,
    nodes,
    edges,
    updatedAt: t,
  };
}

function edge(from: IdeaNode, to: IdeaNode): Edge {
  return { id: newId('e'), from: from.id, to: to.id, layer: 'user' };
}
