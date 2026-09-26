# "How it works" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "How it works" option to the folder import: a small conceptual board (~5–15 cards) explaining how the project works, edges derived from the real import graph — the fourth user-invoked AI behavior.

**Architecture:** Three new pure modules (`lib/majorfiles.ts`, `lib/ai/how-prompt.ts`, `lib/howboard.ts`), a `mode: 'how'` flag on the existing `/api/folder-ai` route (omitted `mode` is byte-identical to today), and a third choice in `FolderImport.tsx`. The model writes only cards; edges are computed locally from import pairs. Board born fully formed like a template — no ghost, no schema change, no migration.

**Tech Stack:** Next.js App Router + TypeScript, vitest (node env, `lib/**/*.test.ts` only), zustand store untouched, better-sqlite3 untouched.

**Spec:** `docs/superpowers/specs/2026-09-26-how-it-works-design.md`

## Global Constraints

- Node 22–26 only; use the repo's own Node: `export PATH="$PWD/.node/bin:$PATH"` before any npm command. System Node is 18 and breaks installs.
- No lint config exists. Verify with `npm test`, `npm run typecheck`, `npm run build` only.
- **Never launch a browser or take screenshots to test.** Route verification is curl against `npm run dev`.
- Pure modules (`lib/*.ts`, `lib/ai/*-prompt.ts`) are node-free and tested by vitest; components are glue only.
- Determinism: any sort is code-point comparison, never `localeCompare`.
- Board born via the existing prebuilt-board path (`onCreate` → `POST /api/boards`); no second write path, no db/schema/store/sync/undo/fingerprint change.
- Secrets never ship: reuse `isSecretFile`; docs never get `_secret` variants. Secrets skip is counted on the consent screen.
- Fourth user-invoked AI behavior; unsolicited count stays exactly one. No ghost layer, no proposal, no undo moment — Apply/Discard is the accept/reject.
- SSE frames for `mode: 'how'`: `{"type":"card","title":…,"body":…,"files":[…]}`, `done`, `error`; refusals answer plain JSON.
- Commit after every green task. Branch: `how-it-works`. Never merge or push without Kyle's explicit go.

## Review Focus

The five input classes the spec implies but task tests don't cover — most likely to bite a person, first:
1. **A model line claiming a file that was never sent** (`cardFromLine` with unknown path): the path must drop in silence, not the card and never an error → Task 2 `drops unknown files from the files list`.
2. **A secret file in the tree** (`.env` sitting beside the docs): it must never enter `major.files` and never be counted as "picked" → Task 1 `skips and counts secret files`.
3. **Two import pairs between the same pair of cards** (A and B share two file-level imports): one board edge, not two → Task 3 `dedupes card edges`.
4. **The route receiving `mode: 'how'` with no provider configured**: a plain-JSON `no_api_key` refusal, never an SSE stream or a 500 → Task 4 curl step.
5. **The person closing the modal mid-"how" stream**: abort lands, nothing persisted, re-open is a clean checklist → Task 5's abort wiring reuses the existing cleanup effect, verified by the `Cancel` button path existing and calling `abortRef.current?.abort()` (same as summaries) — pinned by code presence, not a new test.

---

### Task 1: `lib/majorfiles.ts` — picking the major files

**Files:**
- Create: `lib/majorfiles.ts`
- Test: `lib/majorfiles.test.ts`

**Interfaces:**
- Consumes: `isSecretFile`, `extOf` from `@/lib/importgraph` (`lib/importgraph.ts`); `SUMMARY_FILE_MAX`, `SUMMARY_EXTS` are NOT exported (module-private) — re-declare the same values locally as named constants with a comment pointing at `importgraph.ts` as the owner.
- Consumes: `summaryExtOf` — WAIT. Correction: `SUMMARY_EXTS` is not exported. This task defines its own `TEXT_EXTS` set (copy the list from `importgraph.ts` lines 32–62) with a comment: "mirrors SUMMARY_EXTS in importgraph.ts; keep in sync".
- Produces: `MAJOR_MAX = 24`; `type MajorFile = { path: string; size: number }`; `type MajorPlan = { files: MajorFile[]; skippedSecret: number; skippedBig: number; skippedExt: number; cutByCap: number; docFiles: string[] }`; `pickMajorFiles(files: Array<{path: string; size: number}>, edges: ReadonlyArray<[string, string]>, opts?: { packageJson?: string | null }) => MajorPlan`.

- [ ] **Step 1: Write the failing tests**

```ts
// lib/majorfiles.test.ts
import { describe, expect, it } from 'vitest';
import { MAJOR_MAX, pickMajorFiles } from './majorfiles';

const f = (path: string, size = 100) => ({ path, size });

describe('pickMajorFiles', () => {
  it('always includes docs when present, first of each kind', () => {
    const plan = pickMajorFiles(
      [f('AGENTS.md'), f('docs/AGENTS.md'), f('CLAUDE.md'), f('README.md'), f('src/a.ts')],
      [],
    );
    expect(plan.docFiles).toEqual(['AGENTS.md', 'CLAUDE.md', 'README.md']);
    expect(plan.files.map((x) => x.path)).toContain('AGENTS.md');
    expect(plan.files.map((x) => x.path)).not.toContain('docs/AGENTS.md');
  });

  it('ranks by inbound import degree, code-point ties', () => {
    const files = [f('a.ts'), f('b.ts'), f('c.ts'), f('d.ts')];
    // c is imported by a, b, d → degree 3; a by nobody
    const edges: Array<[string, string]> = [
      ['a.ts', 'c.ts'],
      ['b.ts', 'c.ts'],
      ['d.ts', 'c.ts'],
      ['a.ts', 'b.ts'],
    ];
    const plan = pickMajorFiles(files, edges);
    const paths = plan.files.map((x) => x.path);
    expect(paths.indexOf('c.ts')).toBeLessThan(paths.indexOf('a.ts'));
  });

  it('skips and counts secret files', () => {
    const plan = pickMajorFiles([f('.env'), f('README.md'), f('a.ts')], []);
    expect(plan.skippedSecret).toBe(1);
    expect(plan.files.map((x) => x.path)).not.toContain('.env');
  });

  it('skips and counts oversize and non-text files', () => {
    const plan = pickMajorFiles(
      [f('big.ts', 200 * 1024), f('img.png'), f('README.md')],
      [],
    );
    expect(plan.skippedBig).toBe(1);
    expect(plan.skippedExt).toBe(1);
    expect(plan.files.map((x) => x.path)).toEqual(['README.md']);
  });

  it('caps at MAJOR_MAX, lowest-ranked cut counted', () => {
    const files = Array.from({ length: 40 }, (_, i) => f(`f${String(i).padStart(2, '0')}.ts`));
    const plan = pickMajorFiles(files, []);
    expect(plan.files.length).toBe(MAJOR_MAX);
    expect(plan.cutByCap).toBe(40 - MAJOR_MAX);
  });

  it('resolves package.json entry points against the build set', () => {
    const pkg = JSON.stringify({ main: './dist/index.js', scripts: { dev: 'tsx src/start.ts' } });
    const plan = pickMajorFiles(
      [f('package.json'), f('dist/index.js'), f('src/start.ts'), f('README.md')],
      [],
      pkg,
    );
    const paths = plan.files.map((x) => x.path);
    expect(paths).toContain('src/start.ts');
    expect(paths).toContain('dist/index.js');
  });

  it('is deterministic: same input, same output', () => {
    const files = [f('b.ts'), f('a.ts'), f('README.md')];
    const edges: Array<[string, string]> = [['b.ts', 'a.ts']];
    expect(pickMajorFiles(files, edges)).toEqual(pickMajorFiles(files, edges));
  });
});
```

- [ ] **Step 2: Run to verify failure**

`export PATH="$PWD/.node/bin:$PATH" && npx vitest run lib/majorfiles.test.ts`
Expected: FAIL — module not found / cannot resolve `./majorfiles`.

- [ ] **Step 3: Implement `lib/majorfiles.ts`**

```ts
// lib/majorfiles.ts
import { isSecretFile } from './importgraph';

/** Mirrors SUMMARY_EXTS in importgraph.ts — keep in sync (not exported there). */
const TEXT_EXTS = new Set(['.ts','.tsx','.js','.jsx','.mjs','.cjs','.json','.md','.mdx','.txt','.css','.scss','.html','.htm','.py','.rb','.go','.rs','.java','.kt','.swift','.c','.h','.cpp','.cs','.sh','.yml','.yaml','.toml','.xml','.svg','.sql','.vue','.svelte']);
/** Mirrors SUMMARY_FILE_MAX in importgraph.ts — keep in sync. */
const FILE_MAX = 100 * 1024;

export const MAJOR_MAX = 24;

/** Doc files always major: the author's own architecture docs. */
const DOC_NAMES = ['agents.md', 'claude.md', 'readme.md'];

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
    const hit = sortedPaths.find((p) => p.split('/').pop()?.toLowerCase() === name);
    if (hit) docPicks.push(hit);
  }

  const ranked: MajorFile[] = [];
  for (const f of files) {
    if (isSecretFile(f.path)) { plan.skippedSecret += 1; continue; }
    if (docPicks.includes(f.path)) continue; // docs enter via their own lane
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
    .filter((f): f is MajorFile => Boolean(f) && !isSecretFile(f.path));
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
```

- [ ] **Step 4: Run tests, verify pass**

`npx vitest run lib/majorfiles.test.ts` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/majorfiles.ts lib/majorfiles.test.ts
git commit -m "feat(how): pick major files for the how-it-works pass"
```

---

### Task 2: `lib/ai/how-prompt.ts` — prompt and wire contract

**Files:**
- Create: `lib/ai/how-prompt.ts`
- Test: `lib/ai/how-prompt.test.ts`

**Interfaces:**
- Consumes: `parseJsonObject` from `@/lib/parse` (same as folder-prompt.ts).
- Produces: `HOW_SYSTEM_PROMPT: string`; `HOW_LINE_CONTRACT: string`; `howInstruction(files: Array<{path: string; content: string}>, opts?: { tree?: string[]; imports?: Array<[string,string]>; docPaths?: ReadonlySet<string> }) => string`; `CARD_TITLE_MAX = 80`; `CARD_BODY_MAX = 600`; `HOW_CARDS_MIN = 3`; `HOW_CARDS_MAX = 16`; `type HowCard = { title: string; body: string; files: string[] }`; `cardFromLine(line: string, validPaths: ReadonlySet<string>): HowCard | null`; `howMaxTokens(cardTarget: number): number`.

- [ ] **Step 1: Write failing tests** covering: good line accepted; fenced line dropped silently; preamble prose dropped; empty title → null; over-cap title/body sliced, not dropped; `files` array filtered to `validPaths` (unknown path drops, not the card); `files` non-array → `[]`; body whitespace-normalized; `howMaxTokens` math (e.g. `howMaxTokens(12)` between 3000 and 4000); instruction places doc lines first with the note field; tree/imports sections render when provided.

Write the tests fresh in the folder-prompt.test.ts style (describe/it, no shared harness). Include at minimum:

```ts
it('drops unknown files from the files list, keeps the card', () => {
  const card = cardFromLine(
    '{"title":"Autosave loop","body":"Diffs against the acked board and POSTs ops.","files":["lib/sync.ts","not/sent.ts"]}',
    new Set(['lib/sync.ts']),
  );
  expect(card).not.toBeNull();
  expect(card!.files).toEqual(['lib/sync.ts']);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run lib/ai/how-prompt.test.ts` → module not found.

(Keep the RED step honest: write the full test file for `cardFromLine` and `howInstruction` before the implementation exists.)

- [ ] **Step 3: Implement** — model `folder-prompt.ts` exactly: module doc-comment; `HOW_SYSTEM_PROMPT` (explain the project as 5–12 conceptual cards; each line `{"title","body","files"}`; edges are drawn by the app from real imports, so cards should claim files accurately; doc files are the author's own guide — trust them as framing); `HOW_LINE_CONTRACT` appended after the input; `howInstruction` = tree listing lines, import pair lines, then one JSON line per file (doc files first, with `"note":"the author's own guide to this project"`), then the contract; `cardFromLine` mirrors `summaryFromLine` (parse → title/body flatten+cap → files filtered to validPaths → null on empty title/body); `howMaxTokens(n) = Math.min(4000, 250 + n * 250)`.

- [ ] **Step 4: Run tests → PASS.**

- [ ] **Step 5: Commit**

```bash
git add lib/ai/how-prompt.ts lib/ai/how-prompt.test.ts
git commit -m "feat(how): prompt and JSONL wire contract for the how-it-works pass"
```

---

### Task 3: `lib/howboard.ts` — the pure board builder

**Files:**
- Create: `lib/howboard.ts`
- Test: `lib/howboard.test.ts`

**Interfaces:**
- Consumes: `createNode`, `newId`, `edgePair`, `OBJECTIVE_MAX`, types `Board, Edge, IdeaNode` from `@/lib/graph`; `HowCard` from `@/lib/ai/how-prompt`.
- Produces: `buildHowBoard(cards: HowCard[], imports: ReadonlyArray<[string, string]>, projectName: string): Board`.

- [ ] **Step 1: Write failing tests** covering: edge derived when file on card A imports file on card B (A→B direction: importer card → imported card); same-pair dedupe; A=B self pairs skipped; pairs whose files share a card produce no edge; multi-file overlap one edge; layout determinism (same input twice → identical positions); total input (empty cards → valid empty board, never throws); objective non-empty and ≤ OBJECTIVE_MAX; every node `layer: 'user'`, fresh ids (two calls' ids differ); file claimed by no card / two cards handled (first card wins, later cards don't duplicate the file).

- [ ] **Step 2: RED run** — module not found.

- [ ] **Step 3: Implement**

```ts
// lib/howboard.ts
import { createNode, newId, edgePair, OBJECTIVE_MAX, type Board, type Edge, type IdeaNode } from './graph';
import type { HowCard } from './ai/how-prompt';

const CARD_W = 300;
const CARD_H = 120;
const LAYER_DX = 360;
const GAP_Y = 24;
const FONT = 17;

/** The conceptual board: cards in layered columns by import direction.
 * Edges are REAL import pairs — file on importer card → file on imported card. */
export function buildHowBoard(cards: HowCard[], imports: ReadonlyArray<[string, string]>, projectName: string): Board {
  const t = Date.now();
  let seq = 0;

  // file → card index; first card claiming a file wins.
  const fileCard = new Map<string, number>();
  cards.forEach((c, i) => { for (const p of c.files) if (!fileCard.has(p)) fileCard.set(p, i); });

  // Card-level adjacency from real import pairs.
  const adj = new Map<number, Set<number>>();
  for (const [from, to] of imports) {
    const a = fileCard.get(from);
    const b = fileCard.get(to);
    if (a === undefined || b === undefined || a === b) continue;
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  }

  // Layered layout: longest-path layering (importer left of imported).
  const layer = new Map<number, number>();
  const depth = (i: number, seen: Set<number>): number => {
    if (layer.has(i)) return layer.get(i)!;
    if (seen.has(i)) return 0; // cycle: join its earliest layer
    seen.add(i);
    let d = 0;
    for (const j of adj.get(i) ?? []) d = Math.max(d, depth(j, seen) + 1);
    layer.set(i, d);
    return d;
  };
  cards.forEach((_, i) => depth(i, new Set()));

  const byLayer = new Map<number, number[]>();
  cards.forEach((_, i) => {
    const l = layer.get(i) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(i);
  });

  const nodes: IdeaNode[] = [];
  const ids: string[] = [];
  for (const l of [...byLayer.keys()].sort((a, b) => a - b)) {
    const col = byLayer.get(l)!;
    col.sort((a, b) => cmpCard(cards[a], cards[b]));
    let y = 0;
    for (const i of col) {
      const node = createNode({
        x: l * LAYER_DX,
        y,
        w: CARD_W,
        h: CARD_H,
        fontSize: FONT,
        text: `${cards[i].title}\n${cards[i].body}`,
        createdAt: t + seq++,
      });
      nodes.push(node);
      ids.push(node.id); // ids[i] aligns with cards[i] only if columns are the only order — see fix below
      y += CARD_H + GAP_Y;
    }
  }
  // NOTE: ids must be re-aligned by card index, not push order. Implement as:
  // const ids = new Array<string>(cards.length).fill('');
  // inside the loop: ids[i] = node.id;  (i is the card index — it is, in this loop)

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const [a, bset] of adj) {
    for (const b of bset) {
      const key = edgePair(ids[a], ids[b]).join('\0');
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ id: newId('e'), from: ids[a], to: ids[b], layer: 'user' });
    }
  }

  const name = projectName.trim();
  const objective = `How ${name || 'this project'} works — the systems and info flows from its major files. Ordinary board content.`;
  return {
    id: newId('b'),
    title: name ? `${name} — how it works` : 'How it works',
    objective: objective.slice(0, OBJECTIVE_MAX),
    privacy: false,
    nodes,
    edges,
    updatedAt: t,
  };
}

function cmpCard(a: HowCard, b: HowCard): number {
  const t = a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
  return t || (a.body < b.body ? -1 : a.body > b.body ? 1 : 0);
}
```

(The `ids.push` / re-align NOTE above is a real plan correction: implement with `ids[i] = node.id` inside the column loop — `i` there is the card index, so alignment holds.)

- [ ] **Step 4: GREEN run.**

- [ ] **Step 5: Commit**

```bash
git add lib/howboard.ts lib/howboard.test.ts
git commit -m "feat(how): pure builder for the conceptual how-it-works board"
```

- [ ] **Step 6 (folded into Task 3's commit):** layout sanity — with no edges at all, all cards land in layer 0 in one column, sorted by title; assert in tests.

---

### Task 4: Route `mode: 'how'` on `/api/folder-ai`

**Files:**
- Modify: `app/api/folder-ai/route.ts`

**Interfaces:**
- Consumes: Task 2's `HOW_SYSTEM_PROMPT`, `howInstruction`, `cardFromLine`, `howMaxTokens` from `@/lib/ai/how-prompt`.
- Produces: `POST /api/folder-ai` accepts `{ mode?: 'how' }`. Omitted/any-other `mode` behaves exactly as today. `mode: 'how'` → SSE `card`/`done`/`error` frames.

- [ ] **Step 1: Write the route diff (no unit test — route verified by curl per repo rule)**

Inside `POST`, after the `files` array validation and before `validPaths`:

```ts
const mode = body.mode === 'how' ? 'how' : 'summary';
```

Then thread `mode` through the three seams: (1) instruction/system/line-validator — an early branch selecting the prompt module's functions; (2) the `consume` closure — `mode === 'how'` parses with `cardFromLine(line, validPaths)`, dedupes by title, and sends `{ type: 'card', title, body, files }`; (3) `finish` — counts cards, not summaries. All else (guardManage, no-key plain-JSON refusal, abort ladder, SSE plumbing, provider branching, caching) is unchanged and shared.

- [ ] **Step 2: Typecheck** — `export PATH="$PWD/.node/bin:$PATH" && npm run typecheck`.

- [ ] **Step 3: Curl verification** (each with the dev server running via `npm run dev` in another shell):
  - `curl -N -X POST localhost:3000/api/folder-ai -H 'content-type: application/json' -d '{"mode":"how","files":[{"path":"README.md","content":"A tiny demo project."},{"path":"a.ts","content":"import {x} from \"./b.ts\";"}]}'` → SSE frames; `data: {"type":"card",...}` then `data: {"type":"done"}` (needs a configured provider; if none, expect the plain-JSON `{"summaries":null,"reason":"no_api_key"}`-shaped refusal with mode-appropriate copy — keep `{"summaries":null,...}` unchanged for the summary mode and return `{"cards":null,"reason":"no_api_key"}` for how mode).
  - `curl -N -X POST localhost:3000/api/folder-ai -d '{"files":[{"path":"a.ts","content":"x"}]}'` (no mode) → unchanged behavior (no_api_key shape as today).
  - Abort: start the how curl, kill it mid-stream, confirm the dev log shows no crash.

- [ ] **Step 4: Commit**

```bash
git add app/api/folder-ai/route.ts
git commit -m "feat(how): mode:'how' on the folder-ai route streams conceptual cards"
```

- [ ] **Step 5: One-turn provider branch note:** in the anthropic branch the `system` and `instruction` swap to the how variants; `maxTokens` becomes `howMaxTokens(10)` (card target default). Keep `cache_control` on the system block — byte-identical across calls, same rationale.

---

### Task 5: `FolderImport.tsx` — the third choice

**Files:**
  - Modify: `components/index/FolderImport.tsx`

**Interfaces:**
- Consumes: Task 1 `pickMajorFiles`, `MajorPlan` from `@/lib/majorfiles`; Task 2 `HowCard` type; Task 3 `buildHowBoard`.
- Produces: the modal's how-it-works flow: a `passKind: 'summary' | 'how' | null` choice at consent, `mode: 'how'` request, card staging list, Apply → `buildHowBoard(...)` → existing `onCreate`.

- [ ] **Step 1: Add state + consent choice.** New states: `passKind` (which AI option chosen at consent), `howPlan` (MajorPlan + package.json content), `cards` (`HowCard[]`), `howStatus` mirroring passStatus. At the consent screen, add a second start button "How it works" beside "Build with AI pass" — both disabled until providerInfo has a key. "Build without AI" stays the keyless exit. Choosing a kind stores it and renders kind-specific facts (summary: today's copy; how: "N major files shipping, ~X tokens; doc files lead the pass"; both list never-sent counts).

- [ ] **Step 2: Wire the how run.** `runHowPass()`: build the major plan (reads package.json content from filesRef if present), compute `pickMajorFiles`, build import edges over the included code files (reuse `buildImportEdges` exactly as `runPass` does — the same codeFiles read), then one POST `/api/folder-ai` with `{ mode: 'how', files: majorFileContents }` — files include the tree + import-pairs context via `howInstruction`'s opts computed client-side and... **correction:** the route builds the instruction server-side from `{path, content}` lines; tree/imports context must therefore be shipped in the body. Final wire shape:

```ts
body: JSON.stringify({
  mode: 'how',
  files: payload, // major files' {path, content}, docs first
  context: {
    tree: paths, // all included paths, checklist order
    imports: importPairs, // buildImportEdges output over included code files
    docPaths: plan.docFiles,
  },
})
```

The route passes `context` to `howInstruction(files, context)`.

- [ ] **Step 2.5: Route amendment (folds into Task 4's file, executed here because the wire shape is only final once the client is written):** validate `body.context` loosely (tree: string[], imports: [string,string][], docPaths: string[], each length-capped), pass to `howInstruction`. This is the one place the two tasks meet; the plan's Task 4 branch already anticipates the context argument in `howInstruction`'s signature.

- [ ] **Step 3: Staging + Apply.** The `running` view renders the staged card list (title + body + files chips), streaming one row per `card` frame. `done` → Apply builds `buildHowBoard(cards, importPairs, tree.name)` and calls `onCreate`; Discard → `resetEnrich()`. Errors reuse `errorText` + Retry (single batch — Retry re-runs the whole pass).

- [ ] **Step 4: Typecheck + full suite** — `npm run typecheck && npm test`.

- [ ] **Step 5: Commit**

```bash
git add components/index/FolderImport.tsx app/api/folder-ai/route.ts
git commit -m "feat(how): third import choice — how-it-works board, consent, staging, apply"
```

---

### Task 6: Full gate + docs

**Files:**
- Modify: `AGENTS.md` (invariant entry), `CLAUDE.md` (file map lines)

- [ ] **Step 1: Full gate** — `export PATH="$PWD/.node/bin:$PATH" && npm test && npm run typecheck && npm run build`, all green.

- [ ] **Step 2: Docs** — add the how-it-works invariant paragraph to AGENTS.md (fourth user-invoked AI behavior; model writes cards only, edges from real imports locally; born like a template; no schema/store change) and file-map lines for the three new modules in CLAUDE.md, matching the existing style.

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md CLAUDE.md
git commit -m "docs: how-it-works feature in AGENTS.md and the CLAUDE.md file map"
```

- [ ] **Step 4: Report to Kyle** — branch `how-it-works`, commits list, gate results, and note his live look at a real board is the final gate.
