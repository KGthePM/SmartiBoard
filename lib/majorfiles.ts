/**
 * The how-it-works pass, stage one — which files are "major". Pure local
 * ranking: no network, no model, no token. A conceptual explanation board is
 * built from a project's hubs, and a hub is a file other files import —
 * inbound degree is the whole idea. Docs get their own lane (the author's own
 * architecture docs are always major), package.json entry points are pinned
 * to the front (they say where the program starts), and everything else
 * competes on degree alone. Skips are counted so a later consent-style screen
 * can state them as facts, mirroring `partitionSummaries` in importgraph.ts.
 */
import { isSecretFile } from './importgraph';

/** Mirrors SUMMARY_EXTS in importgraph.ts — keep in sync (not exported there). */
const TEXT_EXTS = new Set(['.ts','.tsx','.js','.jsx','.mjs','.cjs','.json','.md','.mdx','.txt','.css','.scss','.html','.htm','.py','.rb','.go','.rs','.java','.kt','.swift','.c','.h','.cpp','.cs','.sh','.yml','.yaml','.toml','.xml','.svg','.sql','.vue','.svelte']);
/** Mirrors SUMMARY_FILE_MAX in importgraph.ts — keep in sync. */
const FILE_MAX = 100 * 1024;

export const MAJOR_MAX = 24;

/** Doc files always major: the author's own architecture docs. */
const DOC_NAMES = ['agents.md', 'claude.md', 'readme.md'];
const DOC_SET = new Set(DOC_NAMES);

export type MajorFile = { path: string; size: number };
export type MajorPlan = {
  files: MajorFile[];
  docFiles: string[];
  skippedSecret: number;
  skippedBig: number;
  skippedExt: number;
  cutByCap: number;
};

function extOf(path: string): string {
  const base = path.split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
}

function basenameOf(path: string): string {
  return (path.split('/').pop() ?? '').toLowerCase();
}

/** Inbound degree per path from undirected import pairs: a file imported by many is a hub. */
function inboundDegree(edges: ReadonlyArray<[string, string]>): Map<string, number> {
  const deg = new Map<string, number>();
  for (const [a, b] of edges) {
    deg.set(a, (deg.get(a) ?? 0) + 1);
    deg.set(b, (deg.get(b) ?? 0) + 1);
  }
  return deg;
}

/** package.json main/module/bin targets + files named in scripts, resolved
 * against the build set exactly the way resolveImport does (paths as written
 * if present, else + ext, else /index+ext). */
function entryPoints(pkgJson: string | null | undefined, files: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  if (!pkgJson) return out;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(pkgJson) as Record<string, unknown>;
  } catch {
    return out;
  }
  const tryPath = (raw: unknown) => {
    if (typeof raw !== 'string' || !raw.startsWith('.')) return;
    const base = raw.replace(/^\.\//, '');
    if (files.has(base)) out.add(base);
  };
  tryPath(pkg.main);
  tryPath(pkg.module);
  if (typeof pkg.bin === 'string') tryPath(pkg.bin);
  if (typeof pkg.scripts === 'object' && pkg.scripts !== null) {
    for (const cmd of Object.values(pkg.scripts as Record<string, unknown>)) {
      if (typeof cmd !== 'string') continue;
      // token starting with ./ or a bare resolvable name in the build set
      for (const tok of cmd.split(/\s+/)) {
        if (files.has(tok)) out.add(tok);
        else if (tok.startsWith('./') && files.has(tok.slice(2))) out.add(tok.slice(2));
      }
    }
  }
  return out;
}

export function pickMajorFiles(
  files: Array<{ path: string; size: number }>,
  edges: ReadonlyArray<[string, string]>,
  packageJson?: string | null,
): MajorPlan {
  const plan: MajorPlan = { files: [], docFiles: [], skippedSecret: 0, skippedBig: 0, skippedExt: 0, cutByCap: 0 };
  const present = new Set(files.map((f) => f.path));
  const deg = inboundDegree(edges);
  const entries = entryPoints(packageJson, present);

  // First of each doc name (code-point path order = the walk order).
  const docPicks: string[] = [];
  const sortedPaths = [...files].map((f) => f.path).sort(cmp);
  for (const name of DOC_NAMES) {
    const hit = sortedPaths.find((p) => basenameOf(p) === name);
    if (hit) docPicks.push(hit);
  }

  const ranked: MajorFile[] = [];
  for (const f of files) {
    if (isSecretFile(f.path)) { plan.skippedSecret += 1; continue; }
    // Doc-named files enter via their own lane — the picked one and the duplicates alike.
    if (DOC_SET.has(basenameOf(f.path))) continue;
    if (f.size > FILE_MAX) { plan.skippedBig += 1; continue; }
    if (!TEXT_EXTS.has(extOf(f.path))) { plan.skippedExt += 1; continue; }
    ranked.push(f);
  }

  // Rank: entry points first, then inbound degree desc, then path code-point asc.
  const score = (p: string): [number, number, string] => [
    entries.has(p) ? 0 : 1,
    -(deg.get(p) ?? 0),
    p,
  ];
  ranked.sort((a, b) => {
    const [ea, da, pa] = score(a.path);
    const [eb, db, pb] = score(b.path);
    return ea !== eb ? ea - eb : da !== db ? da - db : cmp(pa, pb);
  });

  const docs = docPicks
    .map((p) => files.find((f) => f.path === p))
    .filter((f): f is MajorFile => f !== undefined && !isSecretFile(f.path));
  const room = Math.max(0, MAJOR_MAX - docs.length);
  const kept = ranked.slice(0, room);
  plan.cutByCap = ranked.length - kept.length;
  plan.files = [...docs, ...kept];
  plan.docFiles = docs.map((d) => d.path);
  return plan;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
