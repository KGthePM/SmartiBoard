#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const stage = path.join(root, '.desktop-build', 'backend');
const desktopPackage = require(path.join(root, 'desktop', 'package.json'));
const electronVersion = desktopPackage.devDependencies.electron;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function copy(source, destination) {
  fs.cpSync(source, destination, { recursive: true });
}

run(process.execPath, [path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'], {
  env: { ...process.env, SMARTI_BUILD_TARGET: 'desktop', NEXT_TELEMETRY_DISABLED: '1' },
});

fs.rmSync(path.dirname(stage), { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
copy(path.join(root, '.next', 'standalone'), stage);
copy(path.join(root, '.next', 'static'), path.join(stage, '.next', 'static'));
if (fs.existsSync(path.join(root, 'public'))) copy(path.join(root, 'public'), path.join(stage, 'public'));
copy(path.join(root, 'desktop', 'backend.cjs'), path.join(stage, 'desktop-backend.cjs'));
copy(path.join(root, 'desktop', 'import-db.cjs'), path.join(stage, 'desktop-import-db.cjs'));

const rebuild = path.join(root, 'desktop', 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');
if (!fs.existsSync(rebuild)) {
  console.error('Desktop dependencies are missing. Run: npm run desktop:install');
  process.exit(1);
}
// Next's standalone output omits native build sources. Rebuild a full package copy in
// isolation, then replace only the binding in the staged runtime.
const nativeBuild = path.join(path.dirname(stage), 'native');
const nativePackage = path.join(nativeBuild, 'node_modules', 'better-sqlite3');
fs.mkdirSync(path.dirname(nativePackage), { recursive: true });
copy(path.join(root, 'node_modules', 'better-sqlite3'), nativePackage);
fs.writeFileSync(
  path.join(nativeBuild, 'package.json'),
  JSON.stringify({ name: 'smarti-board-native-build', private: true, dependencies: { 'better-sqlite3': '*' } }),
);
fs.writeFileSync(
  path.join(nativeBuild, 'package-lock.json'),
  JSON.stringify({ name: 'smarti-board-native-build', lockfileVersion: 3 }),
);
run(process.execPath, [
  rebuild,
  '--force',
  '--only',
  'better-sqlite3',
  '--arch',
  'x64',
  '--module-dir',
  '.',
  '--version',
  electronVersion,
], { cwd: nativeBuild });

const rebuiltBinding = fs
  .existsSync(path.join(nativePackage, 'build', 'Release', 'better_sqlite3.node'));
if (!rebuiltBinding) {
  console.error('Desktop build did not produce a better-sqlite3 native binding.');
  process.exit(1);
}
copy(
  path.join(nativePackage, 'build', 'Release', 'better_sqlite3.node'),
  path.join(stage, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
);
fs.rmSync(nativeBuild, { recursive: true, force: true });

run(process.execPath, [path.join(root, 'scripts', 'generate-icon.js')]);
run(process.execPath, [path.join(root, 'scripts', 'generate-third-party-notices.js')]);

const nativeRoot = path.join(stage, 'node_modules', 'better-sqlite3');
const nativeBinding = path.join(nativeRoot, 'build', 'Release', 'better_sqlite3.node');
if (!fs.existsSync(nativeBinding)) {
  console.error('Desktop build is missing the better-sqlite3 native binding.');
  process.exit(1);
}

console.log(`[desktop] staged backend for Electron ${electronVersion}`);
