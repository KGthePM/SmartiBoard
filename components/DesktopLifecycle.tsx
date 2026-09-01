'use client';

import { useEffect } from 'react';
import { flushBoardSaves } from '@/lib/board-save';
import { runDesktopCloseCancellations, runDesktopCloseTasks } from '@/lib/desktop-close';

/** The sole renderer-side bridge for Electron's save-before-shutdown request. */
export function DesktopLifecycle() {
  useEffect(() => {
    const desktop = window.smartiDesktop;
    if (!desktop) return;
    desktop.setCloseHandler(async () => {
      const result = await runDesktopCloseTasks();
      if (!result.ok) return result;
      try {
        await flushBoardSaves();
        return result;
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : 'Smarti Board could not finish saving.',
        };
      }
    });
    desktop.setCloseCancelledHandler(runDesktopCloseCancellations);
    return () => {
      desktop.clearCloseHandler();
      desktop.clearCloseCancelledHandler();
    };
  }, []);
  return null;
}
