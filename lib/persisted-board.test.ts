import { describe, expect, it } from 'vitest';
import { parsePersistedBoard } from './persisted-board';

const node = {
  id: 'n1',
  text: 'Keep me',
  x: 1,
  y: 2,
  w: 200,
  h: 96,
  layer: 'user',
  createdAt: 10,
};

describe('parsePersistedBoard', () => {
  it('loads legacy rows that predate optional board and node fields', () => {
    const board = parsePersistedBoard('b1', { title: '', nodes: [node], edges: [] });
    expect(board.nodes[0].text).toBe('Keep me');
    expect(board.objective).toBe('');
    expect(board.privacy).toBe(false);
    expect(board.nodes[0].done).toBe(false);
  });

  it.each([null, {}, [], { nodes: [], edges: null }])(
    'rejects a structurally unreadable row %#',
    (raw) => {
      expect(() => parsePersistedBoard('b1', raw)).toThrow('unreadable');
    },
  );

  it('rejects a malformed node instead of silently dropping it', () => {
    expect(() =>
      parsePersistedBoard('b1', { nodes: [{ ...node, text: 4 }], edges: [] }),
    ).toThrow('invalid node');
  });

  it('rejects dangling edges instead of silently dropping them', () => {
    expect(() =>
      parsePersistedBoard('b1', {
        nodes: [node],
        edges: [{ id: 'e1', from: 'n1', to: 'missing', layer: 'user' }],
      }),
    ).toThrow('invalid edge');
  });

  it('rejects an ambiguous privacy flag', () => {
    expect(() =>
      parsePersistedBoard('b1', { privacy: 'yes', nodes: [node], edges: [] }),
    ).toThrow('privacy');
  });
});
