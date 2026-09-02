/**
 * The save path as a diff, not a document (v3.6).
 *
 * Until this module the canvas autosaved the *whole board* as a PUT, and
 * `saveBoard` upserts on id with no version check — so two browser tabs on one
 * board destroyed each other's work, silently, last writer wins. That is a
 * single-user bug (a second tab, a second monitor) before it is a multiplayer
 * blocker, and this is the fix: send what changed.
 *
 * **The node is the unit of merge.** One `node.put` covers text, position,
 * size, font step, `done` and reactions at once, so two people on *different*
 * cards both win and two on the *same* card resolve last-write-wins on that
 * card alone — the rest of the board is never in the blast radius. Field-level
 * ops would cost a large op set and a large test surface to settle a collision
 * nobody has: nobody edits one card's text and another person's edit of that
 * same card's colour in the same breath.
 *
 * **`applyOps` takes `parseBoard`'s doctrine — total and tolerant.** An unknown
 * `t`, a malformed node, a `node.del` for an id that is already gone are each
 * dropped in silence and the rest of the batch applies. A corrupt op must
 * degrade to a missing change, never to a 500, for the same reason a corrupt
 * row degrades to an empty board.
 *
 * **Delivery is at-least-once, so every op must be idempotent** — a response
 * lost on the wire is re-sent from the same basis on the next tick. All of them
 * are for free except one: `edge.add` upserts by id, or a lost ack quietly
 * doubles the line. The property is a test — applying any batch twice leaves
 * the board exactly as applying it once did.
 *
 * Pure and node-free, like ./search and ./transfer: the hook and the route
 * import the same functions, and so do the tests. No board-schema change —
 * ./graph is untouched, which is the whole reason this needs no migration.
 */

import {
  createNode,
  OBJECTIVE_MAX,
  snapFontSize,
  removeNodes,
  TITLE_MAX,
  type Board,
  type Edge,
  type IdeaNode,
  type NodeId,
} from './graph';
import { normalizeReactions } from './reactions';

export type Op =
  /** Add or full-replace. The one op behind every per-card mutation. */
  | { t: 'node.put'; node: IdeaNode }
  | { t: 'node.del'; id: NodeId }
  | { t: 'edge.add'; edge: Edge }
  | { t: 'edge.del'; id: string }
  /** The board's own fields. Only what changed rides along. */
  | { t: 'board.set'; title?: string; objective?: string; privacy?: boolean };

/**
 * What `next` says that `prev` did not. Minimal by construction: a card nobody
 * touched produces no op, which is exactly what stops one tab's save from
 * carrying its stale copy of another tab's card.
 *
 * `id` and `updatedAt` are never compared — the first is the row key and the
 * second is a server stamp, so neither is something a client changed.
 */
export function diffBoards(prev: Board, next: Board): Op[] {
  const ops: Op[] = [];

  const set: Extract<Op, { t: 'board.set' }> = { t: 'board.set' };
  let anyField = false;
  if (prev.title !== next.title) ((set.title = next.title), (anyField = true));
  if (prev.objective !== next.objective) ((set.objective = next.objective), (anyField = true));
  if (prev.privacy !== next.privacy) ((set.privacy = next.privacy), (anyField = true));
  if (anyField) ops.push(set);

  const wasNode = new Map(prev.nodes.map((n) => [n.id, n]));
  for (const node of next.nodes) {
    const before = wasNode.get(node.id);
    if (!before || !sameNode(before, node)) ops.push({ t: 'node.put', node });
  }
  const isNode = new Set(next.nodes.map((n) => n.id));
  for (const n of prev.nodes) if (!isNode.has(n.id)) ops.push({ t: 'node.del', id: n.id });

  const wasEdge = new Map(prev.edges.map((e) => [e.id, e]));
  for (const edge of next.edges) {
    const before = wasEdge.get(edge.id);
    if (!before || !sameEdge(before, edge)) ops.push({ t: 'edge.add', edge });
  }
  const isEdge = new Set(next.edges.map((e) => e.id));
  for (const e of prev.edges) if (!isEdge.has(e.id)) ops.push({ t: 'edge.del', id: e.id });

  return ops;
}

/**
 * A batch against a board. Total: `ops` is untrusted, so anything that is not a
 * recognised op is dropped and the rest still lands. Returns a new board and
 * never mutates the one it was given; `updatedAt` is the caller's to stamp,
 * because only the server knows when a batch actually arrived.
 */
export function applyOps(board: Board, ops: unknown): Board {
  if (!Array.isArray(ops)) return board;

  let next = board;
  for (const raw of ops) {
    if (typeof raw !== 'object' || raw === null) continue;
    const op = raw as Record<string, unknown>;

    switch (op.t) {
      case 'node.put': {
        const node = parseNode(op.node);
        if (!node) break;
        const i = next.nodes.findIndex((n) => n.id === node.id);
        const nodes = next.nodes.slice();
        if (i < 0) nodes.push(node);
        else nodes[i] = node;
        next = { ...next, nodes };
        break;
      }
      case 'node.del': {
        if (typeof op.id !== 'string') break;
        // Deleting a card takes its edges with it — the rule the multi-delete
        // already obeys, so it is that function rather than a second filter.
        if (!next.nodes.some((n) => n.id === op.id)) break;
        next = removeNodes(next, [op.id]);
        break;
      }
      case 'edge.add': {
        const edge = parseEdge(op.edge, next);
        if (!edge) break;
        // Upsert, not push: this is the one op that is not idempotent for free.
        const i = next.edges.findIndex((e) => e.id === edge.id);
        const edges = next.edges.slice();
        if (i < 0) edges.push(edge);
        else edges[i] = edge;
        next = { ...next, edges };
        break;
      }
      case 'edge.del': {
        if (typeof op.id !== 'string') break;
        if (!next.edges.some((e) => e.id === op.id)) break;
        next = { ...next, edges: next.edges.filter((e) => e.id !== op.id) };
        break;
      }
      case 'board.set': {
        const patch: Partial<Board> = {};
        if (typeof op.title === 'string') patch.title = op.title.slice(0, TITLE_MAX);
        if (typeof op.objective === 'string') {
          patch.objective = op.objective.slice(0, OBJECTIVE_MAX);
        }
        // Strictly true or it is not private — ./graph's rule, for the same
        // reason: a board is only silent because someone said so.
        if (typeof op.privacy === 'boolean') patch.privacy = op.privacy === true;
        next = { ...next, ...patch };
        break;
      }
      default:
        // An op from a newer version of the app. Dropping it loses a change;
        // throwing would lose the batch.
        break;
    }
  }

  return next;
}

/**
 * An untrusted node through the same gate `parseBoard` uses, so a synced card
 * cannot carry a font size off the ladder or a reaction key that renders as a
 * blank chip.
 */
function parseNode(raw: unknown): IdeaNode | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const n = raw as Record<string, unknown>;
  if (typeof n.id !== 'string') return null;
  if (typeof n.x !== 'number' || typeof n.y !== 'number') return null;
  if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return null;

  return createNode({
    id: n.id,
    text: typeof n.text === 'string' ? n.text : '',
    x: n.x,
    y: n.y,
    ...(typeof n.w === 'number' ? { w: n.w } : {}),
    ...(typeof n.h === 'number' ? { h: n.h } : {}),
    // Anything off the ladder snaps onto it, and unknown reaction keys are
    // dropped: `createNode` normalizes neither, so this is the same pair of
    // guards `parseBoard` puts in front of it.
    fontSize: snapFontSize(n.fontSize),
    layer: n.layer === 'accepted' ? 'accepted' : 'user',
    done: n.done === true,
    reactions: normalizeReactions(n.reactions),
    ...(typeof n.createdAt === 'number' ? { createdAt: n.createdAt } : {}),
  });
}

/** Dangling edges are dropped rather than drawn to nowhere — ./graph's rule. */
function parseEdge(raw: unknown, board: Board): Edge | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== 'string') return null;
  if (typeof e.from !== 'string' || typeof e.to !== 'string') return null;
  if (!board.nodes.some((n) => n.id === e.from)) return null;
  if (!board.nodes.some((n) => n.id === e.to)) return null;
  return { id: e.id, from: e.from, to: e.to, layer: e.layer === 'accepted' ? 'accepted' : 'user' };
}

function sameNode(a: IdeaNode, b: IdeaNode): boolean {
  return (
    a.text === b.text &&
    a.x === b.x &&
    a.y === b.y &&
    a.w === b.w &&
    a.h === b.h &&
    a.fontSize === b.fontSize &&
    a.layer === b.layer &&
    a.done === b.done &&
    a.createdAt === b.createdAt &&
    a.reactions.length === b.reactions.length &&
    a.reactions.every((r, i) => r === b.reactions[i])
  );
}

function sameEdge(a: Edge, b: Edge): boolean {
  return a.from === b.from && a.to === b.to && a.layer === b.layer;
}
