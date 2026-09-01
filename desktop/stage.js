#!/usr/bin/env node
/**
 * Assembles everything electron-builder packs, in one place.
 *
 * Plain CommonJS with no build step and no dependencies of its own, for the same reason
 * `scripts/check-node.js` is: it runs before anything is guaranteed to be installed, and a
 * packaging script that needs packaging is a bad trade.
 *
 * Three jobs, in order:
 *
 *   1. Build the Next app with `output: 'standalone'` (see next.config.ts — it is gated on
 *      SMARTI_DESKTOP so the ordinary web build is untouched).
 *   2. Copy the standalone server here, plus `.next/static`, which standalone deliberately
 *      does not include. Forgetting that copy is the classic mistake and shows up as a board
 *      with no styles at all.
 *   3. Replace the native better-sqlite3 binary with one built for Electron's ABI.
 *
 * Step 3 is the whole reason this file exists rather than a shell one-liner. The traced copy
 * of better-sqlite3 carries the binary that was compiled for *Node*, and Electron is a
 * different ABI — loading it fails at the first database call with NODE_MODULE_VERSION, which
 * is to say after the window is already open. better-sqlite3 publishes Electron prebuilds, so
 * we ask prebuild-install for the right one rather than compiling: no C++ toolchain on any
 * runner, which is the same bargain scripts/check-node.js strikes for the Node floor.
 */

const { execFileSync } = require('node:child_process');
const { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const HERE = __dirname;
const ROOT = resolve(HERE, '..');
const OUT = join(HERE, 'app');

// The Electron version is pinned in package.json and pinning it is load-bearing: better-sqlite3
// publishes prebuilds up to a particular Electron ABI, and moving past it silently turns every
// build into a node-gyp compile. Read it from there so there is one number, not two.
const ELECTRON_VERSION = require('./package.json').devDependencies.electron.replace(/^[^\d]*/, '');

// A cross-build (Linux runner producing a Windows app, say) needs the prebuild for the target,
// not for the machine doing the work. electron-builder tells us via its own env vars when it
// invokes us; the flags are for driving it by hand.
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const PLATFORM = arg('platform', process.platform);
const ARCH = arg('arch', process.arch);

const say = (m) => console.log(`[stage] ${m}`);
const run = (cmd, args, opts) =>
  execFileSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });

// 1. Build.
say(`building Next (standalone) for ${PLATFORM}-${ARCH}...`);
// Plain `npm run build` with the flag in the environment, rather than an `SMARTI_DESKTOP=1 …`
// npm script: that prefix is POSIX shell syntax and does not survive a Windows runner.
run('npm', ['run', 'build'], { cwd: ROOT, env: { ...process.env, SMARTI_DESKTOP: '1' } });

const standalone = join(ROOT, '.next', 'standalone');
if (!existsSync(join(standalone, 'server.js'))) {
  throw new Error('next build did not emit .next/standalone/server.js — is output: standalone gated off?');
}

// 2. Copy.
say('copying the standalone server...');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(standalone, join(OUT, 'standalone'), { recursive: true });

// Standalone omits the static assets on purpose — they are meant to go on a CDN. There is no
// CDN here, so they go next to the server, which is where it looks for them.
say('copying .next/static...');
cpSync(join(ROOT, '.next', 'static'), join(OUT, 'standalone', '.next', 'static'), { recursive: true });

// The trace is conservative and keeps a few things the running server never opens: `typescript`
// (present only because next.config.ts is TypeScript) and sharp/@img (Next's image optimizer —
// the app has no `public/`, no next/image, and no images at all). Roughly 27 MB, pruned here
// rather than through electron-builder's `files` negations so that what is staged is exactly
// what ships, decided in one place.
for (const dead of ['typescript', 'sharp', '@img']) {
  rmSync(join(OUT, 'standalone', 'node_modules', dead), { recursive: true, force: true });
}

// 3. Swap the native binary for the Electron-ABI one.
const bs3Root = join(ROOT, 'node_modules', 'better-sqlite3');
const bs3Out = join(OUT, 'standalone', 'node_modules', 'better-sqlite3');
if (!existsSync(bs3Out)) {
  throw new Error('better-sqlite3 is not in the standalone trace — check serverExternalPackages');
}

// prebuild-install writes into build/Release of whatever directory it runs in, so it runs in a
// scratch copy rather than in node_modules. Fetching straight into the root tree would leave an
// Electron-ABI binary where the ordinary `npm run dev` expects a Node one — a landmine that only
// goes off at the first database call, which is exactly the failure this whole step exists to
// prevent.
const scratch = join(HERE, '.prebuild');
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
cpSync(join(bs3Root, 'package.json'), join(scratch, 'package.json'));

say(`fetching better-sqlite3 prebuild for electron ${ELECTRON_VERSION} (${PLATFORM}-${ARCH})...`);
run(
  process.execPath,
  [
    join(ROOT, 'node_modules', 'prebuild-install', 'bin.js'),
    '--runtime=electron',
    `--target=${ELECTRON_VERSION}`,
    `--platform=${PLATFORM}`,
    `--arch=${ARCH}`,
    '--force',
  ],
  { cwd: scratch, shell: false },
);

const built = join(scratch, 'build', 'Release', 'better_sqlite3.node');
if (!existsSync(built)) throw new Error(`prebuild-install produced nothing at ${built}`);
cpSync(built, join(bs3Out, 'build', 'Release', 'better_sqlite3.node'));
say(`native module in place (${statSync(built).size} bytes, electron ABI)`);
rmSync(scratch, { recursive: true, force: true });

// The native binary that just went in is specific to one platform and one architecture, and a
// mismatch is invisible until the app opens a window and then fails on its first database call.
// Record what this run actually staged so `verify-arch.js` can refuse to package the wrong pair.
writeFileSync(
  join(OUT, '.staged.json'),
  JSON.stringify({ platform: PLATFORM, arch: ARCH, electron: ELECTRON_VERSION }, null, 2),
);

say(`staged into ${OUT}`);
