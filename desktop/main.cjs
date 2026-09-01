'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  utilityProcess,
} = require('electron');
const { autoUpdater } = require('electron-updater');

const APP_ID = 'com.smartiboard.app';
const PRODUCT = 'Smarti Board';
const RELEASES_URL = 'https://github.com/KGthePM/SmartiBoard-Releases/releases';
const START_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 15_000;
const BACKEND_STOP_MS = 6_000;

app.setName(PRODUCT);
app.setAppUserModelId(APP_ID);

// Keep boards, provider settings, Chromium state, and updater state local to
// this machine. Nothing writable belongs under Program Files or $INSTDIR.
const localRoot = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), PRODUCT);
const sessionRoot = path.join(localRoot, 'session');
fs.mkdirSync(sessionRoot, { recursive: true });
app.setPath('userData', localRoot);
app.setPath('sessionData', sessionRoot);
app.setAppLogsPath(path.join(localRoot, 'logs'));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let window = null;
let backend = null;
let backendExit = null;
let heartbeat = null;
let backendExpectedToExit = false;
let shutdownPromise = null;
let allowWindowClose = false;
let updateDownloaded = false;
let automaticCheck = false;
let promptedVersion = null;
let updateState = {
  phase: 'idle',
  currentVersion: app.getVersion(),
};
const closeRequests = new Map();

function backendDirectory() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'backend')
    : path.resolve(__dirname, '..', '.desktop-build', 'backend');
}

function dataPath() {
  return path.join(localRoot, 'data', 'smarti.db');
}

function trusted(event) {
  return Boolean(window && !window.isDestroyed() && event.sender === window.webContents);
}

function publishUpdate(next) {
  updateState = { ...updateState, ...next, currentVersion: app.getVersion() };
  if (window && !window.isDestroyed()) window.webContents.send('desktop:update-state', updateState);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function pipeBackendLogs(child) {
  const logPath = path.join(app.getPath('logs'), 'backend.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.createWriteStream(logPath, { flags: 'a' });
  log.on('error', () => {
    child.stdout?.unpipe(log);
    child.stderr?.unpipe(log);
  });
  log.write(`\n[${new Date().toISOString()}] backend start\n`);
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.once('exit', (code) => {
    log.write(`[${new Date().toISOString()}] backend exit ${code}\n`);
    log.end();
  });
}

async function waitUntilReady(origin, token, instance, child) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!child.pid) throw new Error('The local backend exited during startup.');
    try {
      // Prove this is the child we started before disclosing the request token.
      // A local process that wins the free-port race cannot forge this value.
      const ready = await fetch(`${origin}/__smarti_desktop_ready`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (ready.status !== 204 || ready.headers.get('x-smarti-desktop-instance') !== instance) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
      const response = await fetch(`${origin}/api/settings`, {
        headers: { 'x-smarti-desktop-token': token },
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok) return;
      if (response.status === 404) throw new Error('The desktop request gate rejected its own session.');
    } catch (error) {
      if (error instanceof Error && error.message.includes('request gate')) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('The local backend did not become ready in time.');
}

async function startBackend() {
  const port = await freePort();
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  const token = crypto.randomBytes(32).toString('base64url');
  const instance = crypto.randomBytes(32).toString('base64url');
  const dir = backendDirectory();
  const entry = path.join(dir, 'desktop-backend.cjs');
  if (!fs.existsSync(entry)) throw new Error('The packaged backend is missing.');

  backendExpectedToExit = false;
  const child = utilityProcess.fork(entry, [], {
    cwd: dir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NEXT_TELEMETRY_DISABLED: '1',
      HOSTNAME: '127.0.0.1',
      PORT: String(port),
      SMARTI_DB_PATH: dataPath(),
      SMARTI_DESKTOP_TOKEN: token,
      SMARTI_DESKTOP_HOST: host,
      SMARTI_DESKTOP_INSTANCE: instance,
    },
    serviceName: 'Smarti Board Backend',
    stdio: 'pipe',
  });
  backend = child;
  pipeBackendLogs(child);
  backendExit = new Promise((resolve) => child.once('exit', resolve));
  child.once('exit', () => {
    if (!backendExpectedToExit && !shutdownPromise) void fatal('The local backend stopped unexpectedly.');
  });
  heartbeat = setInterval(() => child.postMessage({ type: 'heartbeat' }), 2_000);
  heartbeat.unref();

  await waitUntilReady(origin, token, instance, child);
  return { origin, token };
}

async function stopBackend() {
  if (!backend) return;
  backendExpectedToExit = true;
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  const child = backend;
  child.postMessage({ type: 'shutdown' });
  await Promise.race([
    backendExit,
    new Promise((resolve) => setTimeout(resolve, BACKEND_STOP_MS)),
  ]);
  if (child.pid) child.kill();
  backend = null;
}

async function runImporter(source, destination) {
  const entry = path.join(backendDirectory(), 'desktop-import-db.cjs');
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(entry, [source, destination], {
      cwd: backendDirectory(),
      serviceName: 'Smarti Board Data Import',
      stdio: 'pipe',
    });
    let message = null;
    child.on('message', (next) => {
      message = next;
    });
    child.once('exit', (code) => {
      if (code === 0 && message?.type === 'done') resolve();
      else reject(new Error(message?.message || 'The database could not be imported.'));
    });
  });
}

async function firstRunImport() {
  const destination = dataPath();
  if (fs.existsSync(destination)) return true;

  while (!fs.existsSync(destination)) {
    const choice = await dialog.showMessageBox({
      type: 'question',
      title: 'Set up Smarti Board',
      message: 'Start with your existing boards?',
      detail:
        'Import reads a consistent copy of an existing smarti.db, including its boards, preferences, and saved provider key. The original file is not changed.',
      buttons: ['Import existing data', 'Start fresh', 'Quit'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (choice.response === 2) return false;
    if (choice.response === 1) return true;

    const picked = await dialog.showOpenDialog({
      title: 'Choose your existing Smarti Board database',
      properties: ['openFile'],
      filters: [
        { name: 'SQLite databases', extensions: ['db', 'sqlite', 'sqlite3'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (picked.canceled || !picked.filePaths[0]) continue;
    try {
      await runImporter(picked.filePaths[0], destination);
      await dialog.showMessageBox({
        type: 'info',
        title: 'Import complete',
        message: 'Your boards and settings are ready.',
      });
      return true;
    } catch (error) {
      await dialog.showMessageBox({
        type: 'error',
        title: 'Import failed',
        message: error instanceof Error ? error.message : 'The database could not be imported.',
      });
    }
  }
  return true;
}

function requestRendererClose() {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return Promise.resolve({ ok: true });
  }
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      closeRequests.delete(id);
      resolve({ ok: false, error: 'Timed out while saving the board.' });
    }, CLOSE_TIMEOUT_MS);
    closeRequests.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    window.webContents.send('desktop:prepare-close', id);
  });
}

async function prepareRendererToClose() {
  while (true) {
    const result = await requestRendererClose();
    if (result?.ok) return true;
    const answer = await dialog.showMessageBox(window, {
      type: 'warning',
      title: 'Board not saved',
      message: result?.error || 'Smarti Board could not save the latest changes.',
      detail: 'Retry, keep the app open, or explicitly quit without those unsaved changes.',
      buttons: ['Retry', 'Keep open', 'Quit without saving'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (answer.response === 1) {
      if (window && !window.isDestroyed()) window.webContents.send('desktop:close-cancelled');
      return false;
    }
    if (answer.response === 2) return true;
  }
}

async function beginShutdown(mode = 'quit') {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    if (window && !window.isDestroyed()) window.setEnabled(false);
    const mayClose = await prepareRendererToClose();
    if (!mayClose) {
      if (window && !window.isDestroyed()) window.setEnabled(true);
      shutdownPromise = null;
      return;
    }
    await stopBackend();
    allowWindowClose = true;
    if (window && !window.isDestroyed()) window.destroy();

    if (updateDownloaded && (mode === 'restart-update' || mode === 'quit')) {
      autoUpdater.quitAndInstall(true, mode === 'restart-update');
      return;
    }
    app.exit(0);
  })();
  return shutdownPromise;
}

async function fatal(message) {
  backendExpectedToExit = true;
  await dialog.showMessageBox({
    type: 'error',
    title: `${PRODUCT} stopped`,
    message,
    detail: `A diagnostic log is available in ${app.getPath('logs')}.`,
  });
  await stopBackend();
  allowWindowClose = true;
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(1);
}

function configureNavigation(origin) {
  const allowedExternalHosts = new Set(['smartiboard.netlify.app', 'github.com']);
  const openExternal = (raw) => {
    try {
      const url = new URL(raw);
      if (url.protocol === 'https:' && allowedExternalHosts.has(url.hostname)) {
        void shell.openExternal(url.toString());
      }
    } catch {}
  };

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(`${origin}/`)) return;
    event.preventDefault();
    openExternal(url);
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (url.startsWith(`${origin}/`)) return;
    event.preventDefault();
    openExternal(url);
  });
}

function configureKeys() {
  window.webContents.on('before-input-event', (event, input) => {
    const key = input.key.toLowerCase();
    const command = input.control || input.meta;
    if (command && key === 'p') {
      event.preventDefault();
      void window.webContents.executeJavaScript('window.print()');
    } else if ((command && key === 'w') || (input.alt && key === 'f4')) {
      event.preventDefault();
      window.close();
    } else if (key === 'f5' || (command && key === 'r') || (command && input.shift && key === 'i')) {
      event.preventDefault();
    }
  });
}

async function createWindow(origin, token) {
  const partition = 'smarti-desktop';
  const appSession = session.fromPartition(partition, { cache: true });
  appSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  appSession.setPermissionCheckHandler(() => false);
  appSession.webRequest.onBeforeSendHeaders(
    { urls: [`${origin}/*`] },
    (details, callback) => {
      details.requestHeaders['X-Smarti-Desktop-Token'] = token;
      callback({ requestHeaders: details.requestHeaders });
    },
  );

  window = new BrowserWindow({
    title: PRODUCT,
    width: 1440,
    height: 920,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: '#f5f4ef',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      devTools: !app.isPackaged,
    },
  });
  configureNavigation(origin);
  configureKeys();
  window.on('close', (event) => {
    if (allowWindowClose) return;
    event.preventDefault();
    void beginShutdown('quit');
  });
  window.on('query-session-end', (event) => {
    if (allowWindowClose) return;
    event.preventDefault();
    void beginShutdown('quit');
  });
  window.on('session-end', () => {
    backendExpectedToExit = true;
    backend?.kill();
  });
  window.webContents.on('render-process-gone', () => {
    if (!shutdownPromise) void fatal('The application window stopped unexpectedly.');
  });
  window.once('ready-to-show', () => window.show());
  window.webContents.once('did-finish-load', () => publishUpdate(updateState));
  await window.loadURL(`${origin}/`);
}

function configureUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('checking-for-update', () => publishUpdate({ phase: 'checking', error: undefined }));
  autoUpdater.on('update-not-available', () => publishUpdate({ phase: 'current', error: undefined }));
  autoUpdater.on('update-available', (info) => {
    publishUpdate({ phase: 'available', availableVersion: info.version, error: undefined });
    if (!automaticCheck || promptedVersion === info.version || !window) return;
    promptedVersion = info.version;
    void dialog
      .showMessageBox(window, {
        type: 'info',
        title: 'Smarti Board update',
        message: `Smarti Board ${info.version} is available.`,
        detail: 'Download it now? You can keep working while it downloads.',
        buttons: ['Download', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .then((answer) => {
        if (answer.response === 0) void downloadUpdate().catch(() => {});
      });
  });
  autoUpdater.on('download-progress', (progress) =>
    publishUpdate({
      phase: 'downloading',
      percent: Math.max(0, Math.min(100, progress.percent)),
      error: undefined,
    }),
  );
  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true;
    publishUpdate({ phase: 'downloaded', availableVersion: info.version, percent: 100, error: undefined });
    if (!window) return;
    void dialog
      .showMessageBox(window, {
        type: 'info',
        title: 'Update ready',
        message: `Smarti Board ${info.version} is ready to install.`,
        detail: 'Restart now, or install it the next time Smarti Board closes normally.',
        buttons: ['Restart and update', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .then((answer) => {
        if (answer.response === 0) void beginShutdown('restart-update');
      });
  });
  autoUpdater.on('error', (error) =>
    publishUpdate({
      phase: 'error',
      error: error instanceof Error ? error.message : 'Update check failed.',
    }),
  );
}

async function checkForUpdates(isAutomatic = false) {
  if (!app.isPackaged) {
    publishUpdate({ phase: 'disabled', error: undefined });
    return updateState;
  }
  automaticCheck = isAutomatic;
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    publishUpdate({
      phase: 'error',
      error: error instanceof Error ? error.message : 'Update check failed.',
    });
  } finally {
    automaticCheck = false;
  }
  return updateState;
}

async function downloadUpdate() {
  if (updateState.phase !== 'available' && updateState.phase !== 'error') return updateState;
  publishUpdate({ phase: 'downloading', percent: 0, error: undefined });
  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    publishUpdate({
      phase: 'error',
      error: error instanceof Error ? error.message : 'Update download failed.',
    });
  }
  return updateState;
}

ipcMain.on('desktop:close-result', (event, id, result) => {
  if (!trusted(event)) return;
  const resolve = closeRequests.get(id);
  if (!resolve) return;
  closeRequests.delete(id);
  resolve(result && typeof result === 'object' ? result : { ok: false });
});
ipcMain.handle('desktop:get-info', (event) => {
  if (!trusted(event)) return null;
  return { version: app.getVersion(), update: updateState, releasesUrl: RELEASES_URL };
});
ipcMain.handle('desktop:check-for-updates', (event) => {
  if (!trusted(event)) return null;
  return checkForUpdates(false);
});
ipcMain.handle('desktop:download-update', (event) => {
  if (!trusted(event)) return null;
  return downloadUpdate();
});
ipcMain.handle('desktop:restart-and-install', (event) => {
  if (!trusted(event) || !updateDownloaded) return false;
  void beginShutdown('restart-update');
  return true;
});

app.on('second-instance', () => {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});
app.on('before-quit', (event) => {
  if (allowWindowClose) return;
  event.preventDefault();
  void beginShutdown('quit');
});
app.on('window-all-closed', () => {
  if (!shutdownPromise) void beginShutdown('quit');
});

if (gotLock) {
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    try {
      if (!(await firstRunImport())) {
        app.exit(0);
        return;
      }
      const runtime = await startBackend();
      await createWindow(runtime.origin, runtime.token);
      configureUpdater();
      setTimeout(() => void checkForUpdates(true).catch(() => {}), 10_000).unref();
    } catch (error) {
      await fatal(error instanceof Error ? error.message : 'Smarti Board could not start.');
    }
  });
}
