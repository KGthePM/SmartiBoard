/**
 * "Check for Updates…" — a click, never a launch-time or background check.
 *
 * Not a self-updater. electron-updater, app-update.yml and a `publish` target are all
 * deliberately absent from package.json (see its comments and README.md) because this app has
 * no signed auto-update story worth trusting silently. This module does the opposite: it is
 * inert until the menu item fires, and every step past the version check needs the user to have
 * asked for it (the menu click) or to say yes again (the install confirm). What it automates is
 * only the parts a person would otherwise do by hand — find the right asset, download it,
 * verify it, open the platform's own installer — not the decision to install.
 *
 * Zero dependencies, plain CommonJS, same as main.js/stage.js/verify-arch.js. desktop/ has no
 * build step and this module ships inside the asar (see package.json's `files`), so it can only
 * ever be plain JS read off disk, never a spawned binary of its own.
 */

const { app, dialog, net, shell, Menu } = require('electron');
const { createHash } = require('node:crypto');
const { createWriteStream, promises: fs } = require('node:fs');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');

const REPO = 'KGthePM/SmartiBoard';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const CHECK_TIMEOUT_MS = 5_000;

// Same suffix table as landing/index.html's DL_PICK, so the two can never silently disagree
// about which asset answers for which platform. Extended with the one case the landing page
// doesn't need: a .deb has no APPIMAGE env var to distinguish it from an AppImage by, so that
// split happens here instead of in the regex table.
function assetPattern() {
  if (process.platform === 'win32') return /-win-x64-setup\.exe$/i;
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? /-mac-arm64\.dmg$/i : /-mac-x64\.dmg$/i;
  }
  if (process.platform === 'linux') {
    return process.env.APPIMAGE ? /-linux-x86_64\.AppImage$/i : /-linux-x64\.deb$/i;
  }
  return null;
}

// Hand-rolled because the only comparison that matters is "is the tag newer than what's
// running", and CI's tag-vs-desktop/package.json guard (.github/workflows/release.yml) already
// guarantees a pushed tag and app.getVersion() are directly comparable dotted triples.
function isNewer(tag, current) {
  const a = tag.replace(/^v/, '').split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function findAsset(release, pattern) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  return assets.find((a) => typeof a.name === 'string' && pattern.test(a.name)) || null;
}

async function downloadTo(url, destPath, onProgress) {
  const res = await net.fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  const hash = createHash('sha256');
  const out = createWriteStream(destPath);

  const reader = res.body.getReader();
  await pipeline(
    (async function* () {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        received += value.length;
        hash.update(value);
        if (total) onProgress(received / total);
        yield value;
      }
    })(),
    out,
  );

  return hash.digest('hex');
}

// Absent for a given asset means "verify by HTTPS alone" — GitHub's TLS is the real guarantee
// here, SHASUMS256.txt is belt-and-braces on top of it, not the gate. Older releases (published
// before this shipped) simply never carry the file.
async function expectedChecksum(release, assetName) {
  const sums = findAsset(release, /^SHASUMS256\.txt$/);
  if (!sums) return null;
  const res = await net.fetch(sums.browser_download_url);
  if (!res.ok) return null;
  const text = await res.text();
  for (const line of text.split('\n')) {
    const [hash, name] = line.trim().split(/\s+\*?/);
    if (name === assetName) return hash;
  }
  return null;
}

async function installWindows(win, filePath) {
  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    buttons: ['Install and Restart', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Ready to install the update',
    detail:
      "Smarti Board will quit and the installer will open. Windows may warn that the app is " +
      'from an unrecognized publisher, the same warning you saw on first install — this build ' +
      'is unsigned.',
  });
  if (response !== 0) return;
  spawn(filePath, [], { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}

async function installMac(win, filePath) {
  await dialog.showMessageBox(win, {
    type: 'info',
    buttons: ['OK'],
    message: 'Downloaded — finish the install manually',
    detail:
      'The disk image will open. Drag Smarti Board to Applications, replacing the old copy, ' +
      'then quit this app and reopen it from Applications.',
  });
  await shell.openPath(filePath);
}

async function installLinuxAppImage(win, filePath) {
  const current = process.env.APPIMAGE;
  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    buttons: ['Install and Restart', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Ready to install the update',
    detail: `This replaces ${current} in place, then restarts Smarti Board.`,
  });
  if (response !== 0) return;
  await fs.chmod(filePath, 0o755);
  await fs.rename(filePath, current);
  app.relaunch();
  app.quit();
}

async function installLinuxDeb(win, filePath) {
  await dialog.showMessageBox(win, {
    type: 'info',
    buttons: ['OK'],
    message: 'Downloaded — finish the install manually',
    detail: 'Your system’s package installer will open. It may ask you to quit Smarti Board first.',
  });
  await shell.openPath(filePath);
}

let inFlight = false;

async function checkForUpdates(win) {
  if (inFlight) return;
  inFlight = true;
  const appMenu = Menu.getApplicationMenu();
  const menuItem = appMenu && appMenu.getMenuItemById('check-for-updates');
  if (menuItem) menuItem.enabled = false;
  win.setProgressBar(0);
  try {
    let release;
    try {
      release = await fetchJson(API_URL, CHECK_TIMEOUT_MS);
    } catch {
      const { response } = await dialog.showMessageBox(win, {
        type: 'error',
        buttons: ['Open Releases Page', 'Cancel'],
        defaultId: 1,
        message: "Couldn't check for updates",
        detail: 'Smarti Board could not reach GitHub. Check your connection and try again.',
      });
      if (response === 0) shell.openExternal(RELEASES_URL);
      return;
    }

    if (!release || !release.tag_name || !isNewer(release.tag_name, app.getVersion())) {
      await dialog.showMessageBox(win, {
        type: 'info',
        buttons: ['OK'],
        message: "You're up to date",
        detail: `Smarti Board ${app.getVersion()} is the latest version.`,
      });
      return;
    }

    const pattern = assetPattern();
    const asset = pattern && findAsset(release, pattern);
    if (!asset) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'info',
        buttons: ['Open Releases Page', 'Cancel'],
        defaultId: 0,
        message: `Smarti Board ${release.tag_name} is available`,
        detail: "The download for your platform isn't attached to this release yet — try again shortly, or grab it from the Releases page.",
      });
      if (response === 0) shell.openExternal(RELEASES_URL);
      return;
    }

    const { response: goAhead } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Download', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `Smarti Board ${release.tag_name} is available`,
      detail: `You have ${app.getVersion()}. Download ${asset.name}?`,
    });
    if (goAhead !== 0) return;

    const destPath = join(app.getPath('userData'), asset.name);
    let actualHash;
    try {
      actualHash = await downloadTo(asset.browser_download_url, destPath, (frac) =>
        win.setProgressBar(frac),
      );
    } catch (err) {
      await fs.rm(destPath, { force: true });
      dialog.showErrorBox('Download failed', (err && err.message) || String(err));
      return;
    } finally {
      win.setProgressBar(-1);
    }

    const wantHash = await expectedChecksum(release, asset.name).catch(() => null);
    if (wantHash && wantHash.toLowerCase() !== actualHash) {
      await fs.rm(destPath, { force: true });
      dialog.showErrorBox(
        'Checksum mismatch',
        'The downloaded file did not match the published checksum and was deleted. Please try again.',
      );
      return;
    }

    if (process.platform === 'win32') await installWindows(win, destPath);
    else if (process.platform === 'darwin') await installMac(win, destPath);
    else if (process.env.APPIMAGE) await installLinuxAppImage(win, destPath);
    else await installLinuxDeb(win, destPath);
  } finally {
    win.setProgressBar(-1);
    inFlight = false;
    if (menuItem) menuItem.enabled = true;
  }
}

module.exports = { checkForUpdates, isNewer, assetPattern };
