import { describe, expect, it } from 'vitest';
import { BoardSaveManager, type BoardSave } from './board-save';

describe('BoardSaveManager', () => {
  it('retries a failed final write during shutdown flush', async () => {
    const written: BoardSave[] = [];
    let attempts = 0;
    const saves = new BoardSaveManager(async (value) => {
      attempts++;
      if (attempts === 1) throw new Error('offline');
      written.push(value);
    });
    const value = { boardId: 'a', payload: '{"nodes":[]}' };

    await expect(saves.enqueue(value)).rejects.toThrow('offline');
    await saves.flush();

    expect(attempts).toBe(2);
    expect(written).toEqual([value]);
  });

  it('does not retry a failed payload superseded by a newer save', async () => {
    const attempted: string[] = [];
    const saves = new BoardSaveManager(async (value) => {
      attempted.push(value.payload);
      if (value.payload === 'old') throw new Error('offline');
    });

    const old = saves.enqueue({ boardId: 'a', payload: 'old' });
    const current = saves.enqueue({ boardId: 'a', payload: 'current' });
    await expect(old).rejects.toThrow('offline');
    await current;
    await saves.flush();

    expect(attempted).toEqual(['old', 'current']);
  });

  it('reports a final write that still fails when retried', async () => {
    const saves = new BoardSaveManager(async () => {
      throw new Error('offline');
    });

    await expect(saves.enqueue({ boardId: 'a', payload: 'current' })).rejects.toThrow('offline');
    await expect(saves.flush()).rejects.toThrow('latest board changes');
  });

  it('does not let another board failure block a read barrier', async () => {
    const saves = new BoardSaveManager(async (value) => {
      if (value.boardId === 'broken') throw new Error('offline');
    });

    await expect(saves.enqueue({ boardId: 'broken', payload: 'x' })).rejects.toThrow('offline');
    await saves.enqueue({ boardId: 'ready', payload: 'y' });

    await saves.flush('ready');
    await expect(saves.flush('broken')).rejects.toThrow('latest board changes');
  });
});
