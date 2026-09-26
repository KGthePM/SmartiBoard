import { createNode, newId, edgePair, OBJECTIVE_MAX, type Board, type Edge, type IdeaNode } from './graph';
import type { HowCard } from './ai/how-prompt';

const CARD_W = 300;
const CARD_H = 120;
const LAYER_DX = 360;
const GAP_Y = 24;
const FONT = 17;

/** The conceptual board: cards in layered columns by import direction.
 * Edges are REAL import pairs — file on importer card → file on imported card. */
export function buildHowBoard(cards: HowCard[], imports: ReadonlyArray<[string, string]>, projectName: string): Board {
  const t = Date.now();
  let seq = 0;

  // file → card index; first card claiming a file wins.
  const fileCard = new Map<string, number>();
  cards.forEach((c, i) => { for (const p of c.files) if (!fileCard.has(p)) fileCard.set(p, i); });

  // Card-level adjacency from real import pairs.
  const adj = new Map<number, Set<number>>();
  for (const [from, to] of imports) {
    const a = fileCard.get(from);
    const b = fileCard.get(to);
    if (a === undefined || b === undefined || a === b) continue;
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  }

  // Layered layout: longest-path layering (importer left of imported).
  const layer = new Map<number, number>();
  const depth = (i: number, seen: Set<number>): number => {
    if (layer.has(i)) return layer.get(i)!;
    if (seen.has(i)) return 0; // cycle: join its earliest layer
    seen.add(i);
    let d = 0;
    for (const j of adj.get(i) ?? []) d = Math.max(d, depth(j, seen) + 1);
    layer.set(i, d);
    return d;
  };
  cards.forEach((_, i) => depth(i, new Set()));

  const byLayer = new Map<number, number[]>();
  cards.forEach((_, i) => {
    const l = layer.get(i) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(i);
  });

  const nodes: IdeaNode[] = [];
  // ids[i] is aligned by card index — i below is the card index, not column order.
  const ids = new Array<string>(cards.length).fill('');
  for (const l of [...byLayer.keys()].sort((a, b) => a - b)) {
    const col = byLayer.get(l)!;
    col.sort((a, b) => cmpCard(cards[a], cards[b]));
    let y = 0;
    for (const i of col) {
      const node = createNode({
        x: l * LAYER_DX,
        y,
        w: CARD_W,
        h: CARD_H,
        fontSize: FONT,
        text: `${cards[i].title}\n${cards[i].body}`,
        createdAt: t + seq++,
      });
      nodes.push(node);
      ids[i] = node.id;
      y += CARD_H + GAP_Y;
    }
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const [a, bset] of adj) {
    for (const b of bset) {
      const key = edgePair(ids[a], ids[b]).join('\0');
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ id: newId('e'), from: ids[a], to: ids[b], layer: 'user' });
    }
  }

  const name = projectName.trim();
  const objective = `How ${name || 'this project'} works — the systems and info flows from its major files. Ordinary board content.`;
  return {
    id: newId('b'),
    title: name ? `${name} — how it works` : 'How it works',
    objective: objective.slice(0, OBJECTIVE_MAX),
    privacy: false,
    nodes,
    edges,
    updatedAt: t,
  };
}

function cmpCard(a: HowCard, b: HowCard): number {
  const t = a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
  return t || (a.body < b.body ? -1 : a.body > b.body ? 1 : 0);
}
