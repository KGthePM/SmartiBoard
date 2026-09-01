import { describe, expect, it } from 'vitest';
import { SaveQueue } from './save-queue';

describe('SaveQueue', () => {
  it('persists full replacements in enqueue order', async () => {
    const written: number[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const queue = new SaveQueue<number>(async (value) => {
      if (value === 1) await first;
      written.push(value);
    });

    const a = queue.enqueue(1);
    const b = queue.enqueue(2);
    await Promise.resolve();
    expect(written).toEqual([]);
    releaseFirst();
    await Promise.all([a, b]);
    expect(written).toEqual([1, 2]);
  });

  it('continues after one failed write', async () => {
    const written: number[] = [];
    const queue = new SaveQueue<number>(async (value) => {
      if (value === 1) throw new Error('no');
      written.push(value);
    });

    await expect(queue.enqueue(1)).rejects.toThrow('no');
    await queue.enqueue(2);
    expect(written).toEqual([2]);
  });
});
