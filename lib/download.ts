/**
 * Handing the browser a file (v3.3). The DOM half of ./transfer, kept in its own
 * module so that one stays pure and node-free and the API route can import from
 * it. The house split: the filename is tested, the anchor is not.
 *
 * There is no server-side download route and there does not need to be — the
 * board is already JSON the client is holding, so a blob is the whole mechanism.
 * In the desktop shell this lands in Electron's standard save flow; `main.js`
 * installs no `will-download` handler, so it needs no code of its own.
 */

export function downloadJson(name: string, data: unknown): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Freed on the next tick rather than immediately: revoking the URL before the
  // click has been dispatched cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
