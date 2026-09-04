'use client';

import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import {
  buildFolderBoard,
  countFiles,
  countIncludedFiles,
  defaultIncluded,
  findJunkDirs,
  includedFilePaths,
  isJunkDir,
  MAX_FILES,
  scanPaths,
  WARN_FILES,
  type FolderTree,
} from '@/lib/folderboard';
import {
  buildImportEdges,
  chunkSummaries,
  estTokens,
  hasImportExt,
  partitionSummaries,
  SUMMARY_MAX,
  type SummaryFile,
  type SummaryPlan,
} from '@/lib/importgraph';
import { PRESETS, type ProviderId } from '@/lib/ai/providers';
import type { Board } from '@/lib/graph';

/**
 * The folder import: point Smarti Board at a project folder and get a board of
 * its shape (phase 1, structure only — path strings, no egress), with an
 * optional AI pass on top (phase 2 — import links, read locally and free, plus
 * per-file summaries, which leave the machine on the user's key). See
 * folder-import-plan.md for the full design.
 *
 * Stages: `pick` (no tree yet) → `review` (the checklist; "Build board…"
 * opens the pre-build choice) → `consent` (the egress moment, in plain
 * words, before anything is sent — both of its exits end in a board:
 * "Build with AI pass", or "Build without AI", the zero-AI, keyless path)
 * → `running` (links first, then summaries streamed into a staging list) →
 * Apply (through the same `onCreate` both paths use) or Discard (back to
 * `review`).
 *
 * Same lifecycle as the template library: Escape / backdrop / × to close —
 * closing while a pass is running aborts it, nothing is left behind.
 */
export function FolderImport({
  onClose,
  onCreate,
  busy,
}: {
  onClose: () => void;
  /** The index's create-from-board closure — it owns the POST and the route. */
  onCreate: (board: Board) => void;
  busy: boolean;
}) {
  const [tree, setTree] = useState<FolderTree | null>(null);
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [skippedJunk, setSkippedJunk] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const dirRef = useRef<HTMLInputElement>(null);

  // File handles, keyed by the same relative path scanPaths/includedFilePaths
  // use — the picker gets them for free from the FileList; a drop's entry
  // walk collects them alongside the path strings phase 1 already gathered.
  const filesRef = useRef<Map<string, File>>(new Map());

  type FilePlan = { paths: string[]; plan: SummaryPlan; bytes: number; codeFiles: number };
  const [enrichStage, setEnrichStage] = useState<'consent' | 'running' | null>(null);
  const [filePlan, setFilePlan] = useState<FilePlan | null>(null);
  const [providerInfo, setProviderInfo] = useState<
    { provider: ProviderId; hasKey: boolean } | null | undefined
  >(undefined);
  const [passStatus, setPassStatus] = useState<'running' | 'error' | 'done'>('running');
  const [passError, setPassError] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<Map<string, string>>(new Map());
  const [imports, setImports] = useState<Array<[string, string]>>([]);

  const abortRef = useRef<AbortController | null>(null);
  // What to resume from on Retry — the batch list and the index that failed.
  const batchRef = useRef<{ batches: SummaryFile[][]; index: number } | null>(null);

  // Escape closes it, as it closes every panel — including mid-pass, which
  // aborts it (the cleanup effect below).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handlePaths = (paths: string[]) => {
    if (paths.length === 0) {
      setNote('That folder appears to be empty.');
      return;
    }
    const { root, skippedJunkFiles } = scanPaths(paths);
    setTree(root);
    setIncluded(defaultIncluded(root));
    setSkippedJunk(skippedJunkFiles);
    setNote(null);
  };

  const onPickChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    const map = new Map<string, File>();
    for (const f of files) map.set(f.webkitRelativePath || f.name, f);
    filesRef.current = map;
    handlePaths(files.map((f) => f.webkitRelativePath || f.name));
  };

  /**
   * One folder at a time: the first dropped directory wins, and a dropped file
   * gets a sentence rather than a one-card board. Paths come from
   * `entry.fullPath` — reading a directory's entry list never opens a file.
   * The readEntries loop matters: Chromium returns at most 100 entries a call
   * and an empty batch is the only "done".
   */
  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    if (busy || scanning) return;
    const entries = Array.from(e.dataTransfer.items)
      .map((item) => item.webkitGetAsEntry())
      .filter((entry): entry is FileSystemEntry => entry !== null);
    const dropped = entries.find((entry) => entry.isDirectory);
    if (!dropped) {
      setNote('That is a file — drop a folder.');
      return;
    }
    setScanning(true);
    setNote(null);
    try {
      const paths: string[] = [];
      const map = new Map<string, File>();
      await collect(dropped, paths, map);
      filesRef.current = map;
      handlePaths(paths);
    } finally {
      setScanning(false);
    }
  };

  // Checking/unchecking a folder carries its whole subtree; children of an
  // unchecked folder are unreachable in the UI until it comes back on.
  const toggle = (node: FolderTree, on: boolean) => {
    setIncluded((prev) => {
      const next = new Set(prev);
      const walk = (n: FolderTree) => {
        if (on) next.add(n.path);
        else next.delete(n.path);
        n.folders.forEach(walk);
      };
      walk(node);
      return next;
    });
  };

  // The checklist: every folder, depth-indented, in the order it will build.
  const rows: { node: FolderTree; depth: number; off: boolean }[] = [];
  const flatten = (node: FolderTree, depth: number, parentOff: boolean) => {
    for (const f of node.folders) {
      rows.push({ node: f, depth, off: parentOff });
      flatten(f, depth + 1, parentOff || !included.has(f.path));
    }
  };
  if (tree) flatten(tree, 0, false);

  const files = tree ? countIncludedFiles(tree, included) : 0;
  const folders = included.size + 1; // the root is always in
  const junkNames = tree ? findJunkDirs(tree) : [];
  const none = files === 0;
  const overCap = files > MAX_FILES;
  const warn = !overCap && files > WARN_FILES;

  // Consent screen entry: the numbers come from what's already on hand (the
  // scan and the captured File handles) — no re-read, no round trip.
  const openConsent = () => {
    if (!tree) return;
    const paths = includedFilePaths(tree, included);
    const summaryFiles: SummaryFile[] = paths.map((p) => ({
      path: p,
      size: filesRef.current.get(p)?.size ?? 0,
    }));
    const plan = partitionSummaries(summaryFiles);
    const bytes = plan.eligible.reduce((n, f) => n + f.size, 0);
    setFilePlan({ paths, plan, bytes, codeFiles: paths.filter(hasImportExt).length });
    setEnrichStage('consent');
    setProviderInfo(undefined);
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data: { settings: { provider: ProviderId; hasKey: boolean } | null }) =>
        setProviderInfo(data.settings),
      )
      .catch(() => setProviderInfo(null));
  };

  const summariesWillRun =
    Boolean(providerInfo?.hasKey) && Boolean(filePlan) && filePlan!.plan.eligible.length > 0 && !filePlan!.plan.overMax;
  const nothingToRun = Boolean(filePlan) && filePlan!.codeFiles === 0 && !summariesWillRun;

  /**
   * One batch at a time, streamed the way the ideas panel reads its route:
   * buffer on '\n\n', parse `data: {...}`, dispatch on `type`. `batchRef` is
   * kept current *before* each POST so a failure mid-batch — network or a
   * model refusal — knows exactly where to resume from on Retry, rather than
   * restarting a pass that may already be most of the way through 300 files.
   */
  const runBatches = async (
    batches: SummaryFile[][],
    startIndex: number,
    filesMap: Map<string, File>,
    ac: AbortController,
  ) => {
    for (let i = startIndex; i < batches.length; i++) {
      if (ac.signal.aborted) return;
      batchRef.current = { batches, index: i };
      const batch = batches[i];

      let payload: Array<{ path: string; content: string }>;
      try {
        payload = await Promise.all(
          batch.map(async (f) => ({ path: f.path, content: (await filesMap.get(f.path)?.text()) ?? '' })),
        );
      } catch {
        if (!ac.signal.aborted) {
          setPassStatus('error');
          setPassError('error');
        }
        return;
      }
      if (ac.signal.aborted) return;

      let res: Response;
      try {
        res = await fetch('/api/folder-ai', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ files: payload }),
          signal: ac.signal,
        });
      } catch {
        if (!ac.signal.aborted) {
          setPassStatus('error');
          setPassError('error');
        }
        return;
      }

      // A refusal (no provider, batch too large) answers plain JSON, not SSE.
      const ctype = res.headers.get('content-type') ?? '';
      if (!res.ok || !ctype.includes('text/event-stream')) {
        const data = (await res.json().catch(() => null)) as { reason?: string; error?: string } | null;
        if (!ac.signal.aborted) {
          setPassStatus('error');
          setPassError(data?.reason ?? 'error');
        }
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let gotDone = false;
      let gotError: string | null = null;

      const handleFrame = (raw: string) => {
        const line = raw.split('\n').find((l) => l.startsWith('data: '));
        if (!line) return;
        let msg: { type?: string; path?: string; summary?: string; reason?: string };
        try {
          msg = JSON.parse(line.slice(6));
        } catch {
          return;
        }
        if (msg.type === 'summary' && msg.path && msg.summary) {
          setSummaries((prev) => new Map(prev).set(msg.path!, msg.summary!));
        } else if (msg.type === 'done') {
          gotDone = true;
        } else if (msg.type === 'error') {
          gotError = msg.reason ?? 'error';
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            handleFrame(frame);
          }
        }
      } catch {
        if (!ac.signal.aborted) {
          setPassStatus('error');
          setPassError('error');
        }
        return;
      }

      if (gotError) {
        if (!ac.signal.aborted) {
          setPassStatus('error');
          setPassError(gotError);
        }
        return;
      }
      if (!gotDone) {
        if (!ac.signal.aborted) {
          setPassStatus('error');
          setPassError('error');
        }
        return;
      }
      // Batch succeeded — move to the next one.
    }
    batchRef.current = null;
    if (!ac.signal.aborted) setPassStatus('done');
  };

  const runPass = async () => {
    if (!tree || !filePlan) return;
    const filesMap = filesRef.current;

    setEnrichStage('running');
    setPassStatus('running');
    setPassError(null);
    setSummaries(new Map());
    setImports([]);
    batchRef.current = null;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    // Links first: local, free, and useful even with no provider at all.
    const codePaths = filePlan.paths.filter(hasImportExt);
    let codeFiles: Array<{ path: string; content: string }>;
    try {
      codeFiles = await Promise.all(
        codePaths.map(async (p) => ({ path: p, content: (await filesMap.get(p)?.text()) ?? '' })),
      );
    } catch {
      if (!ac.signal.aborted) {
        setPassStatus('error');
        setPassError('error');
      }
      return;
    }
    if (ac.signal.aborted) return;
    setImports(buildImportEdges(codeFiles, new Set(filePlan.paths)));

    if (!summariesWillRun) {
      setPassStatus('done');
      return;
    }

    const batches = chunkSummaries(filePlan.plan.eligible);
    batchRef.current = { batches, index: 0 };
    await runBatches(batches, 0, filesMap, ac);
  };

  const retryPass = () => {
    const state = batchRef.current;
    if (!state) return;
    setPassStatus('running');
    setPassError(null);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    void runBatches(state.batches, state.index, filesRef.current, ac);
  };

  // Ends the pass with whatever already streamed in — honest, since the
  // staging list shows exactly that.
  const continuePass = () => {
    abortRef.current?.abort();
    batchRef.current = null;
    setPassStatus('done');
  };

  const resetEnrich = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    batchRef.current = null;
    setEnrichStage(null);
    setPassStatus('running');
    setPassError(null);
    setSummaries(new Map());
    setImports([]);
    setFilePlan(null);
    setProviderInfo(undefined);
  };

  const title = !tree
    ? 'Import a folder'
    : enrichStage === 'consent'
      ? 'AI pass — before you start'
      : enrichStage === 'running'
        ? 'AI pass'
        : `${tree.name || 'Dropped folders'} — pick what to include`;

  return (
    <div className="tplib-back" onPointerDown={onClose}>
      <div className="tplib fi" role="dialog" aria-label="Import a folder" onPointerDown={(e) => e.stopPropagation()}>
        <div className="tplib-head">
          <span className="tplib-title">{title}</span>
          <button className="tplib-x" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </div>

        {!tree ? (
          <div className="fi-pick">
            <button className="fi-choose" disabled={busy || scanning} onClick={() => dirRef.current?.click()}>
              {scanning ? 'Reading…' : 'Choose a folder…'}
            </button>
            <div className="fi-drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => void onDrop(e)}>
              {scanning ? 'Reading the folder…' : '…or drop a folder here'}
            </div>
            {note ? <p className="fi-note bad">{note}</p> : null}
            <p className="fi-note">
              Names and structure only for now — file contents are read only if you start an AI
              pass afterward.
            </p>
          </div>
        ) : enrichStage === 'consent' && filePlan ? (
          <div className="fie-consent">
            <div className="fie-facts">
              <p>
                {filePlan.codeFiles} code {filePlan.codeFiles === 1 ? 'file' : 'files'} for import
                links — read locally, nothing sent, $0, always.
              </p>
              {providerInfo === undefined ? (
                <p>Checking configuration…</p>
              ) : providerInfo?.hasKey ? (
                <p>
                  Summaries via {PRESETS[providerInfo.provider].label}: {filePlan.plan.eligible.length}{' '}
                  {filePlan.plan.eligible.length === 1 ? 'file' : 'files'}, ~
                  {Math.round(filePlan.bytes / 1024)} KB, ~
                  {Math.round(estTokens(filePlan.bytes) / 1000)}K tokens, ~$
                  {((estTokens(filePlan.bytes) / 1_000_000) * 3).toFixed(2)}.
                </p>
              ) : (
                <p>No provider configured — summaries need one (Settings); links still work.</p>
              )}
              {filePlan.plan.overMax ? (
                <p className="fie-warn">
                  More than {SUMMARY_MAX} eligible files — summaries are skipped for this pass;
                  links still run.
                </p>
              ) : null}
              {filePlan.plan.skippedSecret || filePlan.plan.skippedBig || filePlan.plan.skippedExt ? (
                <p className="fie-skip">
                  Never sent: {filePlan.plan.skippedSecret} secret,{' '}
                  {filePlan.plan.skippedBig} oversize, {filePlan.plan.skippedExt} binary/non-text.
                </p>
              ) : null}
              <p className="fie-egress">
                File contents leave this machine on your provider key for the files listed above.
                Structure-only import never does this — this step does.
              </p>
            </div>
            <div className="fie-actions">
              <button className="fie-back" onClick={() => setEnrichStage(null)}>
                Back
              </button>
              <button
                className="fie-skip"
                disabled={busy}
                onClick={() => tree && onCreate(buildFolderBoard(tree, included))}
              >
                Build without AI
              </button>
              <button
                className="fie-start"
                disabled={busy || nothingToRun}
                onClick={() => void runPass()}
              >
                Build with AI pass
              </button>
            </div>
          </div>
        ) : enrichStage === 'running' ? (
          <div className="fie-run">
            <ul className="fie-list">
              {[...summaries.entries()].map(([path, summary]) => (
                <li className="fie-item" key={path}>
                  <span className="fie-item-path">{path}</span>
                  <span className="fie-item-summary">{summary}</span>
                </li>
              ))}
            </ul>
            <p className={`fie-status${passStatus === 'error' ? ' bad' : ''}`}>
              {passStatus === 'running'
                ? summariesWillRun
                  ? `Summarizing… ${summaries.size} of ${filePlan?.plan.eligible.length ?? 0} files, ${imports.length} link${imports.length === 1 ? '' : 's'} found.`
                  : `Reading import links… ${imports.length} found.`
                : passStatus === 'error'
                  ? errorText(passError)
                  : `Done — ${summaries.size} summar${summaries.size === 1 ? 'y' : 'ies'}, ${imports.length} link${imports.length === 1 ? '' : 's'}.`}
            </p>
            <div className="fie-actions">
              {passStatus === 'error' ? (
                <>
                  <button className="fie-back" onClick={resetEnrich}>
                    Discard
                  </button>
                  {summaries.size > 0 ? (
                    <button className="fie-retry" onClick={continuePass}>
                      Continue with {summaries.size} so far
                    </button>
                  ) : null}
                  <button className="fie-start" onClick={retryPass}>
                    Retry
                  </button>
                </>
              ) : passStatus === 'done' ? (
                <>
                  <button className="fie-back" onClick={resetEnrich}>
                    Discard
                  </button>
                  <button
                    className="fie-start"
                    disabled={busy}
                    onClick={() => tree && onCreate(buildFolderBoard(tree, included, { summaries, imports }))}
                  >
                    Apply
                  </button>
                </>
              ) : (
                <button className="fie-back" onClick={resetEnrich}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="fi-tree">
              {rows.map(({ node, depth, off }) => (
                <label
                  className={`fi-row${off ? ' off' : ''}`}
                  key={node.path}
                  style={{ paddingLeft: 10 + depth * 18 }}
                >
                  <input
                    type="checkbox"
                    checked={included.has(node.path)}
                    disabled={off || busy || scanning}
                    onChange={(e) => toggle(node, e.target.checked)}
                  />
                  <span className="fi-name">{node.name}</span>
                  {isJunkDir(node.name) ? <span className="fi-badge">skipped</span> : null}
                  <span className="fi-count">
                    {countFiles(node)} {countFiles(node) === 1 ? 'file' : 'files'}
                  </span>
                </label>
              ))}
            </div>

            <p className="fi-note">
              {junkNames.length > 0
                ? `Skipped as clutter: ${junkNames.join(', ')}${skippedJunk > 0 ? ` and ${skippedJunk} ${skippedJunk === 1 ? 'OS file' : 'OS files'}` : ''}. Check anything back in if you want it.`
                : skippedJunk > 0
                  ? `Skipped ${skippedJunk} ${skippedJunk === 1 ? 'OS junk file' : 'OS junk files'}.`
                  : 'Names and structure only for now — file contents are read only if you start an AI pass.'}
            </p>

            <div className="fi-actions">
              <span className={`fi-total${warn || overCap ? ' warn' : ''}`}>
                {files} {files === 1 ? 'file' : 'files'} in {folders}{' '}
                {folders === 1 ? 'folder' : 'folders'}
                {none
                  ? ' — nothing selected'
                  : overCap
                    ? ` — too many (cap ${MAX_FILES}). Uncheck a folder.`
                    : warn
                      ? ' — a dense board, but it works'
                      : ''}
              </span>
              <button
                className="fi-build"
                disabled={busy || scanning || none || overCap}
                onClick={openConsent}
              >
                Build board…
              </button>
            </div>
          </>
        )}
      </div>

      {/* The input is reset on every open so choosing the same folder twice
          fires change twice. webkitdirectory is non-standard everywhere and
          works in Chrome, Firefox, and Safari — and Electron is Chromium. */}
      <input
        ref={dirRef}
        className="index-file"
        type="file"
        multiple
        webkitdirectory=""
        onChange={onPickChange}
      />
    </div>
  );
}

function errorText(reason: string | null): string {
  switch (reason) {
    case 'refusal':
      return 'The model declined this batch.';
    case 'truncated':
      return 'The model ran out of room mid-batch.';
    case 'empty':
      return 'The model returned nothing for this batch.';
    case 'upstream_error':
      return 'The provider failed to respond.';
    case 'no_api_key':
      return 'No provider configured.';
    default:
      return 'Something went wrong reaching the model.';
  }
}

/** Walk a dropped directory entry, collecting `/`-separated relative paths
 *  and (for phase 2) the File handle behind each one. */
async function collect(entry: FileSystemEntry, out: string[], files: Map<string, File>): Promise<void> {
  if (entry.isFile) {
    // fullPath is “/name/…/file” off the dropped root; the leading slash goes.
    const path = entry.fullPath.replace(/^\//, '');
    out.push(path);
    const file = await new Promise<File | null>((resolve) =>
      (entry as FileSystemFileEntry).file(
        (f) => resolve(f),
        () => resolve(null),
      ),
    );
    if (file) files.set(path, file);
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) =>
      reader.readEntries(
        (entries) => resolve(entries),
        // A failed read ends the walk rather than the import.
        () => resolve([]),
      ),
    );
    if (batch.length === 0) return;
    for (const child of batch) await collect(child, out, files);
  }
}
