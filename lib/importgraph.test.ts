import { describe, expect, it } from 'vitest';
import {
  buildImportEdges,
  chunkSummaries,
  estTokens,
  extractImports,
  hasImportExt,
  isSecretFile,
  partitionSummaries,
  resolveImport,
  SUMMARY_BATCH_FILES,
  SUMMARY_BATCH_TOKENS,
  SUMMARY_FILE_MAX,
  SUMMARY_MAX,
} from './importgraph';

describe('isSecretFile', () => {
  it('never ships .env and its variants, or key material, wherever they sit', () => {
    expect(isSecretFile('.env')).toBe(true);
    expect(isSecretFile('proj/.env')).toBe(true);
    expect(isSecretFile('proj/.env.local')).toBe(true);
    expect(isSecretFile('certs/server.pem')).toBe(true);
    expect(isSecretFile('id_rsa.key')).toBe(true);
    expect(isSecretFile('proj/keystore.p12')).toBe(true);
    expect(isSecretFile('proj/keystore.pfx')).toBe(true);
  });

  it('lets ordinary files through, including dotfiles that are not secrets', () => {
    expect(isSecretFile('proj/src/a.ts')).toBe(false);
    expect(isSecretFile('proj/env.d.ts')).toBe(false);
    expect(isSecretFile('proj/.gitignore')).toBe(false);
    expect(isSecretFile('proj/keyboard.ts')).toBe(false);
  });
});

describe('extractImports', () => {
  const SRC = `
    import a from './a';
    import { b, c } from "./b";
    import type { T } from './types';
    import * as ns from '../lib/ns';
    import './polyfill';
    export { a } from './reexport';
    export * from './star';
    const d = require('./cjs');
    const e = await import('./dynamic');
  `;

  it('finds every JS/TS import form, including side-effect and re-export', () => {
    const specs = extractImports('src/x.ts', SRC);
    expect(specs).toEqual([
      './a',
      './b',
      './types',
      '../lib/ns',
      './polyfill',
      './reexport',
      './star',
      './cjs',
      './dynamic',
    ]);
  });

  it('extracts across multiline import braces and leaves package imports as-is', () => {
    const specs = extractImports('x.ts', [
      'import {',
      '  one,',
      '  two,',
      '} from "./multi";',
      "import fs from 'node:fs';",
      "import x from 'some-pkg';",
    ].join('\n'));
    expect(specs).toEqual(['./multi', 'node:fs', 'some-pkg']);
  });

  it('runs only on files the table knows — other extensions are one entry away', () => {
    expect(extractImports('x.py', "import os\nfrom x import y")).toEqual([]);
    expect(hasImportExt('a/b.tsx')).toBe(true);
    expect(hasImportExt('a/b.py')).toBe(false);
    expect(hasImportExt('a/.env')).toBe(false);
  });
});

describe('resolveImport', () => {
  const files = new Set([
    'proj/src/a.ts',
    'proj/src/b.tsx',
    'proj/src/lib/util.js',
    'proj/src/lib/index.ts',
    'proj/src/styles.css',
    'proj/src/data.json',
    'proj/README.md',
  ]);

  it('resolves relative to the importing file, adding extensions and trying index', () => {
    expect(resolveImport('proj/src/a.ts', './b', files)).toBe('proj/src/b.tsx');
    expect(resolveImport('proj/src/a.ts', './lib/util', files)).toBe('proj/src/lib/util.js');
    expect(resolveImport('proj/src/a.ts', './lib', files)).toBe('proj/src/lib/index.ts');
    expect(resolveImport('proj/src/a.ts', './styles.css', files)).toBe('proj/src/styles.css');
    expect(resolveImport('proj/src/a.ts', './data', files)).toBe('proj/src/data.json');
  });

  it('walks parent segments and clamps at the drop root', () => {
    expect(resolveImport('proj/src/lib/x.ts', '../a', files)).toBe('proj/src/a.ts');
    expect(resolveImport('proj/src/a.ts', '../README.md', files)).toBe('proj/README.md');
    // '..' past the dropped folder clamps at the drop root, where no card lives.
    expect(resolveImport('proj/src/a.ts', '../../../../out/of/range', files)).toBeNull();
  });

  it('drops package specifiers, absolute-ish specifiers, and the unresolvable', () => {
    expect(resolveImport('proj/src/a.ts', 'react', files)).toBeNull();
    expect(resolveImport('proj/src/a.ts', '/abs/path', files)).toBeNull();
    expect(resolveImport('proj/src/a.ts', './missing', files)).toBeNull();
  });

  it('resolves only to files on a card — a bare folder with no index is null', () => {
    // src exists as a folder but has no src/index.*; only src/a.ts and src/b.tsx do.
    const noIndex = new Set(['proj/src/a.ts']);
    expect(resolveImport('proj/README.md', './src', noIndex)).toBeNull();
    expect(resolveImport('proj/README.md', './src/a', noIndex)).toBe('proj/src/a.ts');
  });
});

describe('buildImportEdges', () => {
  it('produces resolved, deduped, undirected edges and drops self/unresolvable/package', () => {
    const files = new Set(['proj/src/a.ts', 'proj/src/b.ts', 'proj/src/c.css', 'proj/src/unused.ts']);
    const edges = buildImportEdges(
      [
        {
          path: 'proj/src/a.ts',
          content: [
            "import { b } from './b';",
            "import './b';", // same pair, opposite direction of nothing — dedupes
            "import './a';", // self
            "import x from './missing';", // unresolvable
            "import r from 'react';", // package
            "import './c.css';",
          ].join('\n'),
        },
        {
          path: 'proj/src/b.ts',
          // a↔b cycle: the undirected pair already exists from a.ts.
          content: "import a from './a';",
        },
        { path: 'proj/src/c.css', content: '@import "./a";' }, // not an import-ext file
      ],
      files,
    );
    expect(edges).toEqual([
      ['proj/src/a.ts', 'proj/src/b.ts'],
      ['proj/src/a.ts', 'proj/src/c.css'],
    ]);
  });

  it('resolves against every included path, not just the code files it read', () => {
    const edges = buildImportEdges(
      [{ path: 'proj/src/a.ts', content: "import d from './data';" }],
      new Set(['proj/src/a.ts', 'proj/src/data.json']),
    );
    expect(edges).toEqual([['proj/src/a.ts', 'proj/src/data.json']]);
  });

  it('is deterministic: the same input yields the same order', () => {
    const mk = () => [
      { path: 'p/x.ts', content: "import './y';\nimport './z';" },
      { path: 'p/z.ts', content: "import './y';" },
    ];
    const files = new Set(['p/x.ts', 'p/y.ts', 'p/z.ts']);
    expect(buildImportEdges(mk(), files)).toEqual(buildImportEdges(mk(), files));
  });
});

describe('partitionSummaries', () => {
  it('keeps text files under the size cap, counts every skip class', () => {
    const plan = partitionSummaries([
      { path: 'src/a.ts', size: 500 },
      { path: 'src/logo.png', size: 500 }, // not text
      { path: 'src/big.ts', size: SUMMARY_FILE_MAX + 1 },
      { path: '.env', size: 20 },
      { path: 'cert.pem', size: 20 },
    ]);
    expect(plan.eligible.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(plan.skippedExt).toBe(1);
    expect(plan.skippedBig).toBe(1);
    expect(plan.skippedSecret).toBe(2);
    expect(plan.overMax).toBe(false);
  });

  it('disables outright past SUMMARY_MAX rather than truncating to a partial set', () => {
    const files = Array.from({ length: SUMMARY_MAX + 1 }, (_, i) => ({
      path: `f${i}.ts`,
      size: 10,
    }));
    const plan = partitionSummaries(files);
    expect(plan.overMax).toBe(true);
    expect(plan.eligible).toEqual([]);
  });
});

describe('chunkSummaries', () => {
  it('respects the file ceiling and splits on the token ceiling', () => {
    const files = Array.from({ length: SUMMARY_BATCH_FILES + 5 }, (_, i) => ({
      path: `f${i}.ts`,
      size: 100,
    }));
    const batches = chunkSummaries(files);
    expect(batches[0]).toHaveLength(SUMMARY_BATCH_FILES);
    expect(batches).toHaveLength(2);
    // Token estimate is bytes ÷ 4, the number the consent screen shows.
    expect(estTokens(400)).toBe(100);
  });

  it('starts a new batch when the token budget would overflow', () => {
    // 24 K tokens a file (96 KB): two fit the 60 K budget, the third starts a
    // new batch.
    const bytesEach = 24_000 * 4;
    const batches = chunkSummaries([
      { path: 'a.ts', size: bytesEach },
      { path: 'b.ts', size: bytesEach },
      { path: 'c.ts', size: bytesEach },
    ]);
    expect(batches.map((b) => b.map((f) => f.path))).toEqual([['a.ts', 'b.ts'], ['c.ts']]);
  });

  it('lets a single oversized file ride alone rather than refusing it', () => {
    // 400 KB → ~100 K estimated tokens, far past the 60 K budget, but alone.
    const batches = chunkSummaries([
      { path: 'small.ts', size: 100 },
      { path: 'huge.md', size: 400_000 },
    ]);
    expect(batches.map((b) => b.map((f) => f.path))).toEqual([['small.ts'], ['huge.md']]);
  });
});
