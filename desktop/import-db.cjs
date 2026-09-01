'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { parentPort } = process;
let temporaryPath = '';

function report(message) {
  parentPort?.postMessage(message);
}

function validate(db) {
  const columns = db.pragma('table_info(boards)');
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('id') || !names.has('data') || !names.has('updated_at')) {
    throw new Error('That file is not a Smarti Board database.');
  }
}

async function run() {
  const sourcePath = path.resolve(process.argv[2] || '');
  const destinationPath = path.resolve(process.argv[3] || '');
  if (!sourcePath || !destinationPath || sourcePath === destinationPath) {
    throw new Error('Invalid import path.');
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  if (fs.existsSync(destinationPath)) throw new Error('Desktop data already exists.');
  temporaryPath = `${destinationPath}.importing`;
  fs.rmSync(temporaryPath, { force: true });

  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    validate(source);
    // SQLite's online backup sees a consistent snapshot, including committed
    // WAL pages. Copying only the .db file would silently miss those pages.
    await source.backup(temporaryPath);
  } finally {
    source.close();
  }

  const imported = new Database(temporaryPath, { readonly: true, fileMustExist: true });
  try {
    validate(imported);
  } finally {
    imported.close();
  }
  fs.renameSync(temporaryPath, destinationPath);
  temporaryPath = '';
}

run()
  .then(() => {
    report({ type: 'done' });
    process.exit(0);
  })
  .catch((error) => {
    try {
      if (temporaryPath && fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    } catch {}
    report({ type: 'error', message: error instanceof Error ? error.message : 'Import failed.' });
    process.exit(1);
  });
