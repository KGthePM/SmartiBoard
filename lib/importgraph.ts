/**
 * Folder import, phase 2 — which file imports which, read entirely on this
 * machine. See folder-import-plan.md.
 *
 * Import statements are extracted with table-driven regexes and resolved
 * against the set of included file paths: only relative specifiers
 * ('./x', '../x') can resolve, so a package import drops in silence, and an
 * unresolvable specifier (the file isn't in the checklist's build set) drops
 * the same way. Nothing here opens a network connection, spends a token, or
 * knows a model exists — links work with no provider configured, which is why
 * they are computed before the summaries are ever offered.
 *
 * This module also owns summary eligibility, the client-side half of the
 * egress gate: the consent screen shows the numbers `partitionSummaries`
 * returns, and the one class of file that never ships regardless of consent —
 * secret-bearing files — is decided here so the filter cannot drift from the
 * copy that explains it.
 *
 * A regex will match an import inside a comment or a template string; that is
 * accepted noise. The alternative is a parser per language, and a whiteboard
 * edge that is 1% wrong is worth more than a parser per language.
 */

/** Extensions whose files get import extraction. A language is one entry. */
const IMPORT_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

/**
 * Extensions a model may be asked to summarize: text a person writes, not
 * bytes a machine wrote. Anything else is skipped and counted — the consent
 * screen says how many, so "skipped" is a fact on screen, not a surprise.
 */
const SUMMARY_EXTS = new Set([
  ...IMPORT_EXTS,
  '.json',
  '.md',
  '.mdx',
  '.txt',
  '.css',
  '.scss',
  '.html',
  '.htm',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.c',
  '.h',
  '.cpp',
  '.cs',
  '.sh',
  '.yml',
  '.yaml',
  '.toml',
  '.xml',
  '.svg',
  '.sql',
  '.vue',
  '.svelte',
]);

/**
 * Extensions tried when a specifier arrives without one, in order. `./lib/foo`
 * may mean foo.ts or foo/index.ts; `./styles` may mean styles.css. Mirrors
 * what a bundler would try, minus everything it would try after these —
 * an unresolved specifier drops, and the board is none the poorer.
 */
const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css'] as const;

/** One summary per file, and past this a partial set would be invisible
 * after Apply — so summaries disable outright rather than truncate. */
export const SUMMARY_MAX = 300;
/** A file larger than this is not summary material; it is skipped and counted. */
export const SUMMARY_FILE_MAX = 100 * 1024;
/** Batch ceilings: files per POST, and the crude token estimate (bytes ÷ 4). */
export const SUMMARY_BATCH_FILES = 20;
export const SUMMARY_BATCH_TOKENS = 60_000;

/** The extension including its dot, lowercased; '' for none (dotfiles, bare names). */
export function extOf(path: string): string {
  const base = path.split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  // i === 0 is '.env' — a whole name that starts with a dot, not an extension.
  return i > 0 ? base.slice(i).toLowerCase() : '';
}

/**
 * Secret-bearing files never ship, consent or no consent: a `.env` or a
 * private key leaving the machine on a summary run is a trust disaster the
 * consent screen's "file contents leave this machine" technically covers and
 * practically does not. Not re-includable in the pass; links still read them,
 * locally, for free.
 */
export function isSecretFile(path: string): boolean {
  const base = path.split('/').pop() ?? '';
  if (base === '.env' || base.startsWith('.env.')) return true;
  return /\.(pem|key|p12|pfx)$/i.test(base);
}

/** Whether import extraction runs on this file — the table's membership test. */
export function hasImportExt(path: string): boolean {
  return (IMPORT_EXTS as readonly string[]).includes(extOf(path));
}

/* ---------- extraction ---------- */

/** The JS/TS family: every form a relative specifier can arrive in. */
const JS_PATTERNS: readonly RegExp[] = [
  // import … from '…' (covers `import type {X} from` and multiline braces)
  /\bimport\s+[^;()]*?\bfrom\s*['"]([^'"]+)['"]/g,
  // side-effect import '…'
  /\bimport\s*['"]([^'"]+)['"]/g,
  // export … from '…' (re-exports)
  /\bexport\s+[^;()]*?\bfrom\s*['"]([^'"]+)['"]/g,
  // require('…') (CommonJS, and TS's import x = require('…'))
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // import('…') (dynamic)
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * Raw import specifiers in one file's content, extraction order. Duplicates
 * are left in — dedupe is the edge builder's job, where it is undirected and
 * therefore correct for cycles.
 */
export function extractImports(path: string, content: string): string[] {
  if (!hasImportExt(path)) return [];
  const specs: string[] = [];
  for (const re of JS_PATTERNS) {
    for (const m of content.matchAll(re)) {
      if (m[1]) specs.push(m[1]);
    }
  }
  return specs;
}

/**
 * One relative specifier → the path it means, or null. Package specifiers
 * (no leading './' or '../') are null by definition, and so is anything the
 * build set does not contain: resolution is "would this land on a card", not
 * "does this exist on disk".
 *
 * '..' past the root clamps (the root is the whole world here), and the empty
 * base — a specifier that walked itself out — cannot be a file.
 */
export function resolveImport(
  fromPath: string,
  spec: string,
  files: ReadonlySet<string>,
): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;

  const stack = fromPath.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      stack.pop();
      continue;
    }
    stack.push(seg);
  }
  const base = stack.join('/');
  if (base === '') return null;

  if (files.has(base)) return base;
  for (const ext of RESOLVE_EXTS) {
    if (files.has(base + ext)) return base + ext;
  }
  for (const ext of RESOLVE_EXTS) {
    if (files.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
  }
  return null;
}

/**
 * Contents → import edges, `[importer, imported]`, in input order. Edges are
 * deduped undirected (a↔b cycles produce one line, like the board's own
 * `edgePair`), self-imports drop, and resolution sees every included path —
 * not just the code files — so './styles.css' resolves too.
 */
export function buildImportEdges(
  codeFiles: Array<{ path: string; content: string }>,
  allFiles: ReadonlySet<string>,
): Array<[string, string]> {
  const seen = new Set<string>();
  const edges: Array<[string, string]> = [];
  const key = (a: string, b: string) => (a < b ? `${a}\0${b}` : `${b}\0${a}`);

  for (const f of codeFiles) {
    if (!hasImportExt(f.path)) continue;
    for (const spec of extractImports(f.path, f.content)) {
      const to = resolveImport(f.path, spec, allFiles);
      if (!to || to === f.path) continue;
      const k = key(f.path, to);
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push([f.path, to]);
    }
  }
  return edges;
}

/* ---------- summary eligibility ---------- */

/** A file as the consent screen and the batcher see it: a path and a size. */
export type SummaryFile = { path: string; size: number };

export type SummaryPlan = {
  /** Files that would ship, in checklist order, already capped at SUMMARY_MAX. */
  eligible: SummaryFile[];
  /** True when eligible-before-cap exceeded SUMMARY_MAX and the pass degraded
   *  to links-only by the caller's rule — kept here so the screen and the run
   *  cannot disagree about which list they mean. */
  overMax: boolean;
  skippedSecret: number;
  skippedBig: number;
  skippedExt: number;
};

/**
 * Included files → what ships and what does not, with every skip counted. The
 * order of the checks is the order the consent screen lists them: secrets
 * first (never ships), then size, then extension.
 */
export function partitionSummaries(files: SummaryFile[]): SummaryPlan {
  const plan: SummaryPlan = {
    eligible: [],
    overMax: false,
    skippedSecret: 0,
    skippedBig: 0,
    skippedExt: 0,
  };
  for (const f of files) {
    if (isSecretFile(f.path)) {
      plan.skippedSecret += 1;
    } else if (f.size > SUMMARY_FILE_MAX) {
      plan.skippedBig += 1;
    } else if (!SUMMARY_EXTS.has(extOf(f.path))) {
      plan.skippedExt += 1;
    } else {
      plan.eligible.push(f);
    }
  }
  if (plan.eligible.length > SUMMARY_MAX) {
    plan.overMax = true;
    plan.eligible = [];
  }
  return plan;
}

/** The plan's token estimate: bytes ÷ 4, the number the consent screen owes. */
export function estTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

/**
 * Eligible files → batches, each within both ceilings (a single file larger
 * than the token ceiling rides alone rather than being refused — the file cap
 * already guaranteed it fits the size rule).
 */
export function chunkSummaries(
  files: SummaryFile[],
  maxFiles = SUMMARY_BATCH_FILES,
  maxTokens = SUMMARY_BATCH_TOKENS,
): SummaryFile[][] {
  const batches: SummaryFile[][] = [];
  let current: SummaryFile[] = [];
  let tokens = 0;
  for (const f of files) {
    const t = estTokens(f.size);
    if (current.length > 0 && (current.length >= maxFiles || tokens + t > maxTokens)) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(f);
    tokens += t;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
