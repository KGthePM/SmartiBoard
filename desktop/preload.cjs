'use strict';

const { contextBridge, ipcRenderer } = require('electron');

let closeHandler = null;
let closeCancelledHandler = null;

ipcRenderer.on('desktop:prepare-close', async (_event, requestId) => {
  try {
    const result = closeHandler ? await closeHandler() : { ok: true };
    ipcRenderer.send('desktop:close-result', requestId, result ?? { ok: true });
  } catch (error) {
    ipcRenderer.send('desktop:close-result', requestId, {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not save the board.',
    });
  }
});

ipcRenderer.on('desktop:close-cancelled', () => closeCancelledHandler?.());

contextBridge.exposeInMainWorld('smartiDesktop', {
  getInfo: () => ipcRenderer.invoke('desktop:get-info'),
  checkForUpdates: () => ipcRenderer.invoke('desktop:check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:download-update'),
  restartAndInstall: () => ipcRenderer.invoke('desktop:restart-and-install'),
  setCloseHandler: (handler) => {
    closeHandler = typeof handler === 'function' ? handler : null;
  },
  clearCloseHandler: () => {
    closeHandler = null;
  },
  setCloseCancelledHandler: (handler) => {
    closeCancelledHandler = typeof handler === 'function' ? handler : null;
  },
  clearCloseCancelledHandler: () => {
    closeCancelledHandler = null;
  },
  onUpdateState: (handler) => {
    const listener = (_event, state) => handler(state);
    ipcRenderer.on('desktop:update-state', listener);
    return () => ipcRenderer.removeListener('desktop:update-state', listener);
  },
});
