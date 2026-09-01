'use client';

export type DesktopCloseTask = () => void | Promise<void>;

const tasks = new Set<DesktopCloseTask>();
const cancellations = new Set<() => void>();

/** Register one piece of renderer cleanup that must finish before the server stops. */
export function registerDesktopCloseTask(task: DesktopCloseTask): () => void {
  tasks.add(task);
  return () => tasks.delete(task);
}

export function registerDesktopCloseCancellation(task: () => void): () => void {
  cancellations.add(task);
  return () => cancellations.delete(task);
}

export function runDesktopCloseCancellations(): void {
  for (const cancel of cancellations) cancel();
}

export async function runDesktopCloseTasks(): Promise<{ ok: boolean; error?: string }> {
  // Start together, but wait for every task before main can cancel the close.
  // A fast settings failure must not race a still-writing board snapshot.
  const results = await Promise.allSettled(
    Array.from(tasks, (task) => Promise.resolve().then(task)),
  );
  const failed = results.find((result) => result.status === 'rejected');
  if (!failed || failed.status !== 'rejected') return { ok: true };
  return {
    ok: false,
    error:
      failed.reason instanceof Error
        ? failed.reason.message
        : 'Smarti Board could not finish closing.',
  };
}
