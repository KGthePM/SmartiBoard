# Smarti Board desktop

The desktop edition is a thin Electron owner around the existing Next.js application. It does
not fork the product or persistence model: the same routes, components, graph, SQLite schema,
and provider settings run in a utility-process backend visible only to its Electron window.

## Runtime model

- `main.cjs` owns the sole window, backend utility process, first-run import, shutdown, and
  updater. Closing the window flushes the renderer save queue before stopping the backend.
- The backend binds a random `127.0.0.1` port for that run. Requests require a random token and
  exact host checked by `middleware.ts`; there is no desktop LAN mode.
- `preload.cjs` exposes only lifecycle and updater methods. Node integration is disabled,
  context isolation and sandboxing are enabled, permissions are denied, and navigation is
  restricted.
- Writable state is under `%LOCALAPPDATA%\Smarti Board`; the installation directory is
  replaceable program data only. Uninstall retains writable state.
- Updates come from public releases in `KGthePM/SmartiBoard-Releases`. The app asks before a
  download and before an immediate restart. A downloaded update also installs on normal exit.

## Local Windows build

Use Node 24 on Windows:

```powershell
npm ci
npm ci --prefix desktop
npm test
npm run typecheck
npm run desktop:dist
```

Artifacts land in `dist-desktop/`. Local development builds may be unsigned and must not be
published as production releases.

`scripts/prepare-desktop.js` builds Next standalone output into `.desktop-build/backend`. Next
traces only the runtime files from better-sqlite3, so the script copies the full installed
package to a temporary isolated project, rebuilds that copy for Electron's ABI, copies only the
resulting `.node` binding into the backend, and deletes the temporary build. Do not point
electron-rebuild at the repository root: that replaces the normal Node binding and breaks web
tests and builds.

The same preparation generates `THIRD_PARTY_NOTICES.txt` from locked production dependencies.
Electron's own `LICENSE.electron.txt` and Chromium's `LICENSES.chromium.html` are also present
beside the installed executable.

## Production release

Public releases are tag-driven by `.github/workflows/release-desktop.yml`. Before the first
release:

1. Initialize the public `KGthePM/SmartiBoard-Releases` repository with a default branch.
2. Add a `RELEASES_TOKEN` source-repository secret. It must be able to create releases and
   upload assets in the public releases repository.
3. Add `WINDOWS_CERTIFICATE`, containing a base64-encoded PFX code-signing certificate, and
   `WINDOWS_CERTIFICATE_PASSWORD` as source-repository secrets.
4. Confirm the certificate chains to a root trusted by supported Windows versions.

For each release, update the version in `package.json`, `package-lock.json`,
`desktop/package.json`, and `desktop/package-lock.json`. Then verify and push the matching tag:

```powershell
npm run version:check
git tag v0.1.0
git push origin v0.1.0
```

The workflow fails closed if the release token or signing credentials are absent. It installs
from both lockfiles, runs tests and typechecking, builds the NSIS installer, and requires valid
Authenticode signatures on both the installed application executable and installer. It then
publishes these assets to the public release repository:

- `SmartiBoard-Setup-<version>-x64.exe` and its blockmap
- `latest.yml`, consumed by electron-updater
- `SHA256SUMS.txt`
- `SmartiBoard-Source-<version>.zip`, made by `git archive` from the exact tagged commit
- Smarti Board, npm, Electron, and Chromium license/notices files

Releases are immutable. The workflow refuses an existing version, refuses a version that is
not newer than the current public stable release, uploads every asset to a draft, verifies the
asset set, and only then publishes it as latest. Delete a failed draft before rerunning its tag;
never replace assets on an already-public release. Enable GitHub immutable releases and protect
release tags in the public repository as a second administrative guard.

The public release repository is an artifact host, not the application source repository.
GitHub will display automatic source links for that repository; release notes explicitly point
to the attached `SmartiBoard-Source-<version>.zip` as the corresponding AGPL source.

## Manual release checks

The automated build does not replace a clean Windows installation check. Before announcing a
release, verify the following on a Windows x64 machine:

1. Installer directory selection, optional desktop shortcut, Start menu shortcut, and
   Authenticode publisher display.
2. Fresh launch and import of an existing active WAL database.
3. Editing followed immediately by Alt+F4 retains the last change after reopening.
4. Printing and presentation mode behave as in the web edition.
5. A test release is discovered, downloaded only after consent, and installed after restart.
6. Uninstall removes program files and shortcuts but preserves `%LOCALAPPDATA%\Smarti Board`.
