'use client';

import { SaveQueue } from './save-queue';

export type BoardSave = { boardId: string; payload: string };

/**
 * Owns board writes outside the canvas lifetime. Navigation can unmount the
 * board while its final PUT is still queued; desktop shutdown still has to
 * await and, once, retry that write from the library page.
 */
export class BoardSaveManager {
  private readonly queue: SaveQueue<BoardSave>;
  private readonly desired = new Map<string, string>();
  private readonly failed = new Map<string, BoardSave>();

  constructor(write: (value: BoardSave) => Promise<void>) {
    this.queue = new SaveQueue(async (value) => {
      try {
        await write(value);
        if (this.desired.get(value.boardId) === value.payload) this.failed.delete(value.boardId);
      } catch (error) {
        if (this.desired.get(value.boardId) === value.payload) {
          this.failed.set(value.boardId, value);
        }
        throw error;
      }
    });
  }

  enqueue(value: BoardSave): Promise<void> {
    this.desired.set(value.boardId, value.payload);
    return this.queue.enqueue(value);
  }

  async flush(boardId?: string): Promise<void> {
    await this.queue.idle();
    const retries = [...this.failed.values()].filter(
      (value) =>
        (boardId === undefined || value.boardId === boardId) &&
        this.desired.get(value.boardId) === value.payload,
    );
    if (retries.length === 0) return;

    await Promise.allSettled(retries.map((value) => this.enqueue(value)));
    await this.queue.idle();
    const stillFailed =
      boardId === undefined ? this.failed.size > 0 : this.failed.has(boardId);
    if (stillFailed) throw new Error('The latest board changes could not be saved.');
  }
}

const boardSaves = new BoardSaveManager(async ({ boardId, payload }) => {
  const response = await fetch(`/api/boards/${boardId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: payload,
  });
  if (!response.ok) throw new Error(`save failed: ${response.status}`);
});

export function enqueueBoardSave(value: BoardSave): Promise<void> {
  return boardSaves.enqueue(value);
}

export function flushBoardSaves(): Promise<void> {
  return boardSaves.flush();
}

export function flushBoardSave(boardId: string): Promise<void> {
  return boardSaves.flush(boardId);
}
