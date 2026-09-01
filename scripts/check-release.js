#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const files = ['package.json', 'package-lock.json', 'desktop/package.json', 'desktop/package-lock.json'];

const versions = files.map((file) => {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) throw new Error(`Missing ${file}`);
  const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
  const value = parsed.version;
  if (file.endsWith('package-lock.json') && parsed.packages?.['']?.version !== value) {
    throw new Error(`${file} root package is ${parsed.packages?.['']?.version}; expected ${value}`);
  }
  return { file, value };
});
const expected = versions[0].value;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(expected)) {
  throw new Error(`Desktop releases require a stable SemVer: ${expected}`);
}
for (const entry of versions) {
  if (entry.value !== expected) throw new Error(`${entry.file} is ${entry.value}; expected ${expected}`);
}

const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : process.argv[2];
if (tag && tag !== `v${expected}`) throw new Error(`Tag ${tag} does not match v${expected}`);
console.log(`[release] version ${expected}${tag ? ` matches ${tag}` : ''}`);
