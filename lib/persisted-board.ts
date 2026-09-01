import { parseBoard, type Board } from './graph';
import { REACTIONS } from './reactions';

const LAYERS = new Set(['user', 'accepted']);
const REACTION_KEYS = new Set<string>(REACTIONS);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Disk rows get a stricter contract than request bodies. A tolerant wire
 * normalizer may drop junk; doing that to the only persisted copy can turn a
 * recoverable row into a valid empty board that the next PUT destroys.
 */
export function parsePersistedBoard(id: string, raw: unknown): Board {
  if (!record(raw) || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    throw new Error(`Board ${id} contains unreadable data.`);
  }
  if ('title' in raw && typeof raw.title !== 'string') {
    throw new Error(`Board ${id} has an invalid title.`);
  }
  if ('objective' in raw && typeof raw.objective !== 'string') {
    throw new Error(`Board ${id} has an invalid objective.`);
  }
  if ('privacy' in raw && typeof raw.privacy !== 'boolean') {
    throw new Error(`Board ${id} has an invalid privacy flag.`);
  }
  if ('updatedAt' in raw && !finite(raw.updatedAt)) {
    throw new Error(`Board ${id} has an invalid timestamp.`);
  }

  const nodeIds = new Set<string>();
  for (const candidate of raw.nodes) {
    if (!record(candidate)) throw new Error(`Board ${id} has an invalid node.`);
    if (
      typeof candidate.id !== 'string' ||
      candidate.id.length === 0 ||
      nodeIds.has(candidate.id) ||
      typeof candidate.text !== 'string' ||
      !finite(candidate.x) ||
      !finite(candidate.y) ||
      !finite(candidate.w) ||
      !finite(candidate.h) ||
      !LAYERS.has(String(candidate.layer)) ||
      !finite(candidate.createdAt)
    ) {
      throw new Error(`Board ${id} has an invalid node.`);
    }
    if ('fontSize' in candidate && !finite(candidate.fontSize)) {
      throw new Error(`Board ${id} has an invalid node font size.`);
    }
    if ('done' in candidate && typeof candidate.done !== 'boolean') {
      throw new Error(`Board ${id} has an invalid done flag.`);
    }
    if (
      'reactions' in candidate &&
      (!Array.isArray(candidate.reactions) ||
        candidate.reactions.some(
          (reaction) => typeof reaction !== 'string' || !REACTION_KEYS.has(reaction),
        ))
    ) {
      throw new Error(`Board ${id} has invalid reactions.`);
    }
    nodeIds.add(candidate.id);
  }

  const edgeIds = new Set<string>();
  for (const candidate of raw.edges) {
    if (
      !record(candidate) ||
      typeof candidate.id !== 'string' ||
      candidate.id.length === 0 ||
      edgeIds.has(candidate.id) ||
      typeof candidate.from !== 'string' ||
      typeof candidate.to !== 'string' ||
      !nodeIds.has(candidate.from) ||
      !nodeIds.has(candidate.to) ||
      !LAYERS.has(String(candidate.layer))
    ) {
      throw new Error(`Board ${id} has an invalid edge.`);
    }
    edgeIds.add(candidate.id);
  }

  return parseBoard(id, raw);
}
