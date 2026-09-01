#!/usr/bin/env node

const { spawn } = require('node:child_process');

const command = process.argv[2];
const extra = process.argv.slice(3);
const allowed = new Set(['dev', 'start']);

if (!allowed.has(command)) {
  console.error('Usage: node scripts/run-next.js <dev|start> [next args...]');
  process.exit(1);
}

const hasHostArg = extra.some(
  (arg) => arg === '-H' || arg === '--hostname' || arg.startsWith('-H=') || arg.startsWith('--hostname='),
);
const configuredHost = (process.env.SMARTI_HOST || '').trim();
const host = configuredHost || '127.0.0.1';
const nextBin = require.resolve('next/dist/bin/next');
const args = [nextBin, command];

if (!hasHostArg) args.push('-H', host);
args.push(...extra);

const child = spawn(process.execPath, args, {
  stdio: 'inherit',
  env: process.env,
  windowsHide: false,
});

child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});

child.on('close', (code, signal) => {
  if (typeof code === 'number') process.exit(code);
  if (signal === 'SIGINT') process.exit(130);
  if (signal === 'SIGTERM') process.exit(143);
  process.exit(1);
});
