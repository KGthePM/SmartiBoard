/**
 * Board identity: naming and at-a-glance summaries.
 *
 * Two ideas carry the whole feature. First, a board names itself — `title` is
 * empty until someone renames it, and until then the name is derived from the
 * first idea on the board. Nobody should have to name a thing before they are
 * allowed to think in it, which is the same reason there is no save button.
 * Second, boards are recognized by shape: `previewOf` normalizes the graph into
 * a unit box so the index can draw a real minimap rather than a generic tile.
 *
 * Everything here is pure — no DOM, no db — so both the server (listing) and
 * the client (chrome, switcher) can call it.
 */

import { stripMarks } from './richtext';
import { NODE_W, type Board, type IdeaNode, type Layer } from './graph';

export const UNTITLED = 'Untitled board';

/** Long enough for a real sentence fragment, short enough for a card. */
const TITLE_CHARS = 48;

/** Past this the minimap is noise, and parsing every node stops being free. */
const THUMB_NODES = 60;

/**
 * A floor on the projected extent, so a board with two ideas draws two small
 * cards in a mostly empty field instead of two blocks filling the frame. The
 * emptiness is information: it reads as "barely started".
 */
const MIN_SPAN = NODE_W * 2.5;

/**
 * The board's name as taken from its content. Returns '' when there is nothing
 * to name it after — callers wanting a display string want `boardTitle`.
 */
export function deriveTitle(board: Board): string {
  const source = firstIdea(board);
  if (!source) return '';
  const plain = stripMarks(source.text).replace(/\s+/g, ' ').trim();
  return truncate(plain, TITLE_CHARS);
}

/** The name to show. An explicit rename always wins over the derived one. */
export function boardTitle(board: Board): string {
  return board.title.trim() || deriveTitle(board) || UNTITLED;
}

/**
 * The oldest idea with text in it, preferring one the user wrote. A board
 * should be named after its author's thinking, not after a suggestion that
 * happened to be accepted early.
 */
function firstIdea(board: Board): IdeaNode | undefined {
  const withText = board.nodes.filter((n) => stripMarks(n.text).trim().length > 0);
  const byAge = [...withText].sort((a, b) => a.createdAt - b.createdAt);
  return byAge.find((n) => n.layer === 'user') ?? byAge[0];
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  // Only break on a word if the word boundary is late enough to leave a name.
  const body = space > max * 0.5 ? cut.slice(0, space) : cut;
  return `${body.trimEnd()}…`;
}

/* ---------- minimap ---------- */

export type ThumbNode = { id: string; x: number; y: number; w: number; h: number; layer: Layer };
export type ThumbEdge = { id: string; x1: number; y1: number; x2: number; y2: number; layer: Layer };

/** Board geometry projected into a 0..1 box, aspect ratio preserved. */
export type Thumb = { nodes: ThumbNode[]; edges: ThumbEdge[] };

export function previewOf(board: Board, max = THUMB_NODES): Thumb {
  const kept = [...board.nodes].sort((a, b) => a.createdAt - b.createdAt).slice(0, max);
  if (kept.length === 0) return { nodes: [], edges: [] };

  const minX = Math.min(...kept.map((n) => n.x));
  const minY = Math.min(...kept.map((n) => n.y));
  const maxX = Math.max(...kept.map((n) => n.x + n.w));
  const maxY = Math.max(...kept.map((n) => n.y + n.h));

  // One span for both axes keeps the layout's proportions — squashing a wide
  // board into a square would destroy the thing being recognized. MIN_SPAN
  // doubles as the divide-by-zero guard for a degenerate zero-extent board.
  const span = Math.max(maxX - minX, maxY - minY, MIN_SPAN);
  const padX = (span - (maxX - minX)) / 2;
  const padY = (span - (maxY - minY)) / 2;

  const nodes: ThumbNode[] = kept.map((n) => ({
    id: n.id,
    x: (n.x - minX + padX) / span,
    y: (n.y - minY + padY) / span,
    w: n.w / span,
    h: n.h / span,
    layer: n.layer,
  }));

  const byId = new Map(nodes.map((n) => [n.id, n]));

  const edges: ThumbEdge[] = board.edges.flatMap((e) => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    // An edge to a node that fell outside the cap has nothing to connect.
    if (!a || !b) return [];
    return [
      {
        id: e.id,
        x1: a.x + a.w / 2,
        y1: a.y + a.h / 2,
        x2: b.x + b.w / 2,
        y2: b.y + b.h / 2,
        layer: e.layer,
      },
    ];
  });

  return { nodes, edges };
}

/* ---------- summaries ---------- */

export type BoardMeta = { createdAt: number; updatedAt: number; archivedAt: number | null };

export type BoardSummary = BoardMeta & {
  id: string;
  /** Already resolved through `boardTitle` — never empty. */
  title: string;
  nodeCount: number;
  edgeCount: number;
  thumb: Thumb;
};

export function summarize(board: Board, meta: BoardMeta): BoardSummary {
  return {
    id: board.id,
    title: boardTitle(board),
    nodeCount: board.nodes.length,
    edgeCount: board.edges.length,
    thumb: previewOf(board),
    ...meta,
  };
}

/**
 * `now` is a parameter rather than a `Date.now()` call so the server and the
 * client render the same string — a relative time computed twice is a
 * hydration mismatch waiting to happen.
 */
export function relativeTime(then: number, now: number): string {
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.round(months / 12)}y ago`;
}
