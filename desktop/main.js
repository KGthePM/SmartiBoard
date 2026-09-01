/**
 * The desktop shell.
 *
 * It adds nothing to Smarti Board. There is no feature here, no state, no AI behavior and no
 * token spent: this file starts the same Next server the web install runs, on loopback, and
 * points a window at it. Nothing in `lib/` or `app/` knows it exists.
 *
 * Plain CommonJS on purpose — the same choice as scripts/check-node.js and stage.js. A shell
 * this small should not need a build step of its own.
 */

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { fork } = require('node:child_process');
const net = require('node:net');
const { join } = require('node:path');

const HOST = '127.0.0.1';
const READY_TIMEOUT_MS = 45_000;

// electron-builder unpacks app/** out of the asar (see package.json), because the Next server
// reads its own build output off disk and an archive is a worse place to do that from than a
// directory. In development the same tree sits right here.
const APP_DIR = app.isPackaged
  ? join(process.resourcesPath, 'app.asar.unpacked', 'app')
  : join(__dirname, 'app');

let serverProcess = null;
let win = null;

/**
 * Two copies of the app would race on one SQLite file and one port, and the second one would
 * lose in a way that looks like corruption rather than like a mistake. One window, and a second
 * launch raises the one that exists.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

/**
 * A double-clicked app has no meaningful working directory, so the default relative
 * './data/smarti.db' would create a fresh empty database wherever the OS happened to start us —
 * which reads as "my boards vanished". lib/db.ts already honours SMARTI_DB_PATH; that seam is
 * the entire reason the app itself needs no change to be packaged.
 */
const DB_PATH = join(app.getPath('userData'), 'data', 'smarti.db');

/** An OS-assigned free port, asked for and released, so we never guess at 3000. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, HOST, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Poll until the server answers, or give up. Next is up in about a second; the ceiling is for
 *  a cold, slow first launch, not for a hang we should sit through in silence. */
async function waitForServer(url, signal) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal.dead) throw new Error(signal.dead);
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status < 500) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`The board did not start within ${READY_TIMEOUT_MS / 1000} seconds.`);
}

/**
 * ELECTRON_RUN_AS_NODE makes this same binary behave as plain Node, so the child is an ordinary
 * Node process that happens to carry Electron's ABI — which is exactly what the one native
 * module (better-sqlite3, swapped in by stage.js) is built against. Running the server out of
 * process also keeps it off the UI thread and out of Electron's app lifecycle.
 */
function startServer(port) {
  const signal = { dead: null };
  const child = fork(join(APP_DIR, 'standalone', 'server.js'), [], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: String(port),
      HOSTNAME: HOST,
      SMARTI_DB_PATH: DB_PATH,
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) signal.dead = `The board's server exited with code ${code}.`;
    serverProcess = null;
  });
  return { child, signal };
}

function stopServer() {
  if (!serverProcess) return;
  const child = serverProcess;
  serverProcess = null;
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

/**
 * Electron's default menu registers Undo, Redo and Select All as menu accelerators, and a menu
 * accelerator is handled before the page ever sees the key. components/canvas/Board.tsx owns
 * Cmd/Ctrl-Z and Cmd/Ctrl-Y itself — the board's undo stack — so the default menu would quietly
 * break the single most important reversibility guarantee in the product. This menu therefore
 * carries no undo, no redo and no select-all; the browser still handles all three natively
 * inside a focused text field, which is the only place they mean something else.
 */
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Smarti Board on GitHub',
          click: () => shell.openExternal('https://github.com/KGthePM/SmartiBoard'),
        },
        {
          label: 'Where your boards are stored',
          click: () => shell.showItemInFolder(DB_PATH),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#ffffff',
    show: false,
    title: 'Smarti Board',
    icon: process.platform === 'linux' ? join(__dirname, 'build', 'icon.png') : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The renderer is an ordinary browser tab pointed at loopback. It gets no preload and no
  // bridge, because it needs none: everything it wants is already an HTTP route.

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    win = null;
  });

  // Four links in the app carry target="_blank" (the settings panel's provider docs and the
  // library's footer). Without this they open chromeless Electron windows with no way back.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

async function boot() {
  buildMenu();
  const window = createWindow();
  await window.loadFile(join(__dirname, 'loading.html'));

  try {
    const port = await freePort();
    const { child, signal } = startServer(port);
    serverProcess = child;
    const url = `http://${HOST}:${port}`;
    await waitForServer(url, signal);
    console.log(`[smarti] desktop shell on ${url}`);
    await window.loadURL(url);
  } catch (err) {
    stopServer();
    dialog.showErrorBox(
      'Smarti Board could not start',
      `${err && err.message ? err.message : err}\n\nDatabase: ${DB_PATH}`,
    );
    app.quit();
  }
}

app.whenReady().then(boot);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) boot();
});

// The server is the app. There is no background mode and nothing to keep warm, so closing the
// last window ends both — on every platform including macOS, where the usual convention assumes
// a document-based app with a Dock presence worth keeping.
app.on('window-all-closed', () => {
  stopServer();
  app.quit();
});

app.on('before-quit', stopServer);
process.on('exit', stopServer);
