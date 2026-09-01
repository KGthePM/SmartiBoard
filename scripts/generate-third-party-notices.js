#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const projects = [root, path.join(root, 'desktop')];
const packages = new Map();

function addPackage(directory) {
  const manifestPath = path.join(directory, 'package.json');
  if (!fs.existsSync(manifestPath)) return;

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest.name || !manifest.version) return;
  const key = `${manifest.name}@${manifest.version}`;
  if (packages.has(key)) return;

  const licenseFiles = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(entry.name),
    )
    .map((entry) => ({
      name: entry.name,
      text: fs.readFileSync(path.join(directory, entry.name), 'utf8').trim(),
    }));

  packages.set(key, {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license || 'See package license file',
    homepage: manifest.homepage || manifest.repository?.url || '',
    licenseFiles,
  });
}

for (const project of projects) {
  const lockPath = path.join(project, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  for (const [relative, details] of Object.entries(lock.packages || {})) {
    if (!relative || details.dev === true || !relative.includes('node_modules/')) continue;
    addPackage(path.join(project, relative));
  }
}

// Electron is a build dependency but its runtime is part of every desktop package.
addPackage(path.join(root, 'desktop', 'node_modules', 'electron'));

const divider = '='.repeat(78);
const sections = [
  'SMARTI BOARD THIRD-PARTY NOTICES',
  '',
  'Smarti Board itself is licensed under AGPL-3.0-only; see LICENSE.txt.',
  'The installed Electron runtime also includes LICENSE.electron.txt and',
  'LICENSES.chromium.html beside the application executable.',
  '',
  'The following notices are generated from the locked production dependencies.',
];

for (const entry of [...packages.values()].sort((a, b) =>
  `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
)) {
  sections.push('', divider, `${entry.name} ${entry.version}`, `License: ${entry.license}`);
  if (entry.homepage) sections.push(`Project: ${entry.homepage}`);
  if (entry.licenseFiles.length === 0) {
    sections.push('No standalone license or notice file was present in the installed package.');
  } else {
    for (const license of entry.licenseFiles) {
      sections.push('', `--- ${license.name} ---`, license.text);
    }
  }
}

const destination = path.join(root, 'THIRD_PARTY_NOTICES.txt');
fs.writeFileSync(destination, `${sections.join('\n')}\n`);
console.log(`[desktop] notices: ${destination} (${packages.size} packages)`);
