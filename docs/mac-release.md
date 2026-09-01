# Releasing the macOS build

Everything macOS-specific, in the order you do it. The Windows and Linux installers come out
of CI on a `v*` tag and need nothing from you; **the `.dmg` is built on your Mac and attached
to the same draft release by hand.**

---

## Where this already stands

These are verified facts about the build that is already sitting in `desktop/dist/`, not
things to check:

| | |
|---|---|
| Signed | ✅ `Developer ID Application: Kyle Gomez (4CC8W8RW2F)` |
| Hardened runtime | ✅ on (`flags=0x10000(runtime)`) — required for notarization |
| Team ID | `4CC8W8RW2F` |
| Bundle ID | `app.smartiboard.desktop` |
| Notarized | ❌ **not yet — this document is that step** |
| Gatekeeper verdict | `rejected — source=Unnotarized Developer ID` |

Signing and notarization are two separate things, and you have done the harder one. Signing
proves the app came from you. Notarization is Apple scanning it and issuing a ticket that says
so. **Without the ticket, a first launch still shows a scary dialog** — "Apple could not verify
… it may contain malware" — and the user has to right-click → Open to get past it. With it,
the app just opens.

---

## Step 1 — Get an app-specific password (one time, ~2 minutes)

This is *not* your Apple ID password. Apple requires a separate generated one for tools.

1. Go to **<https://account.apple.com>** → sign in → **Sign-In and Security**
2. → **App-Specific Passwords** → **+**
3. Name it something you'll recognize later, e.g. `smarti-notary`
4. Copy the password it shows you — format `abcd-efgh-ijkl-mnop`. **You cannot view it again**,
   only revoke it and make a new one.

> Use the Apple ID that owns the Developer Program membership for team `4CC8W8RW2F`. Your
> Apple Development certificate on this machine is issued to `kgomezcchs@gmail.com`, so that is
> almost certainly the one — but confirm at <https://developer.apple.com/account> if the
> credential check in Step 2 fails.

---

## Step 2 — Store the credentials in your keychain (one time)

```bash
xcrun notarytool store-credentials smarti \
  --apple-id "<your-apple-id-email>" \
  --team-id 4CC8W8RW2F \
  --password "<the-app-specific-password>"
```

`smarti` is the profile name — it is referenced by name from here on. The password goes into
your login keychain, not into the repo, not into an env file, and not into CI.

Confirm it works before going further:

```bash
xcrun notarytool history --keychain-profile smarti
```

An empty history is a **success** — it means Apple accepted the credentials and you simply have
no submissions yet. An authentication error means the Apple ID, team ID, or password is wrong.

---

## Step 3 — Build the notarized `.dmg`

```bash
cd "/Users/kylegomez/ClaudeProjects/Smarti Boards/desktop"
APPLE_KEYCHAIN_PROFILE=smarti npm run dist:mac:notarized
```

**The env var is required and is the part that is easy to miss.** electron-builder does not
know your profile is called `smarti`; it looks for `APPLE_KEYCHAIN_PROFILE` in the environment.
`dist:mac:notarized` differs from `dist:mac` only in passing `--config.mac.notarize=true`,
which overrides the `"notarize": false` that is the default in `desktop/package.json`.

Expect roughly **2–10 minutes** — the build itself is fast, then it uploads to Apple and waits
for the scan. You are looking for these two lines:

```
  • signing         file=dist/mac-arm64/Smarti Board.app  identityName=Developer ID Application: Kyle Gomez (4CC8W8RW2F)
  • notarization successful
```

### ⚠️ The failure mode that matters

If the credentials cannot be found, electron-builder does **not** fail. It prints:

```
  • skipped macOS notarization  reason=`notarize` options were unable to be generated
```

…and hands you a perfectly good-looking, **un-notarized** `.dmg`. This is why Step 4 is not
optional. Never trust the build log alone.

---

## Step 4 — Verify (do not skip)

```bash
spctl -a -vvv -t install "dist/mac-arm64/Smarti Board.app"
```

| Output | Meaning |
|---|---|
| `accepted` … `source=Notarized Developer ID` | ✅ Done. Ship it. |
| `rejected` … `source=Unnotarized Developer ID` | ❌ Notarization silently skipped — go back to Step 3 and check `APPLE_KEYCHAIN_PROFILE` was actually set |
| `rejected` … `source=no usable signature` | ❌ Signing failed, not notarization — a different problem |

If it says `Unnotarized`, ask Apple what happened:

```bash
xcrun notarytool history --keychain-profile smarti
xcrun notarytool log <submission-id> --keychain-profile smarti
```

The log is JSON and names the exact file and reason if Apple rejected something.

---

## Step 5 — Staple the `.dmg` itself

`@electron/notarize` staples the ticket to the `.app` inside the disk image, which is what
actually matters. Stapling the `.dmg` too means the *download* verifies without a network
round-trip on the user's machine:

```bash
xcrun stapler staple "dist/SmartiBoard-3.0.0-mac-arm64.dmg"
xcrun stapler validate "dist/SmartiBoard-3.0.0-mac-arm64.dmg"
```

`The staple and validate action worked!` is the line you want. If it says the ticket is
unavailable, notarization did not actually succeed — return to Step 4.

---

## Step 6 — Attach it to the release

1. Go to <https://github.com/KGthePM/SmartiBoard/releases> and open the **draft** that the
   `v3.0.0` workflow run created. It should already carry four files:
   `…-win-x64-setup.exe`, `…-win-x64-portable.exe`, `…-linux-x86_64.AppImage`,
   `…-linux-amd64.deb`.
2. Drag `desktop/dist/SmartiBoard-3.0.0-mac-arm64.dmg` onto it.
3. Edit the notes, then **Publish release**.

Once it is notarized, update the README's download warning — the current wording still says a
first launch may need a right-click → Open on macOS, and that stops being true:

```
- **macOS** is signed and notarized. It opens normally.
```

---

## Optional — an Intel (`x64`) build

The release ships Apple Silicon only. If someone asks for Intel:

```bash
APPLE_KEYCHAIN_PROFILE=smarti npm run dist:mac:intel -- --config.mac.notarize=true
```

**Do not run this back-to-back with the arm64 build and expect both to survive.** Each
`dist:*` re-stages the native `better-sqlite3` binary for one platform *and* architecture, and
the second build overwrites the first's staging. Build one, **move the `.dmg` out of
`desktop/dist/` before starting the other.** If you get the order wrong,
`desktop/verify-arch.js` stops the pack with the exact re-run command rather than letting you
ship an app that opens a window and then dies on its first database call.

---

## Why this is not in CI

Deliberate, on two counts:

- **Cost.** GitHub's macOS runners bill at **10×** the rate of Linux ones. The repo is public
  now so minutes are free, but the ratio is still the reason not to reach for them by reflex.
- **The certificate.** It lives in a keychain on this machine and works. Putting it in CI means
  exporting a `.p12`, base64-ing it into a secret, adding the app-specific password as a second
  secret, and maintaining an expiry in a place you will not be looking when it lapses. That
  buys a second way for the same build to break.

If you ever *do* want it in CI: the same `getNotarizeOptions` also accepts
`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or an App Store Connect API key
via `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`. The API key is the better choice
for automation — it does not expire on a password reset.

---

## Quick reference

```bash
# one time
xcrun notarytool store-credentials smarti --apple-id "<email>" --team-id 4CC8W8RW2F --password "<app-specific>"

# every release
cd "/Users/kylegomez/ClaudeProjects/Smarti Boards/desktop"
APPLE_KEYCHAIN_PROFILE=smarti npm run dist:mac:notarized
spctl -a -vvv -t install "dist/mac-arm64/Smarti Board.app"          # must say: Notarized Developer ID
xcrun stapler staple "dist/SmartiBoard-<version>-mac-arm64.dmg"
# then drag the .dmg onto the draft release
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `skipped macOS notarization … unable to be generated` | `APPLE_KEYCHAIN_PROFILE` not in the environment | Prefix the command with it — a plain `npm run dist:mac:notarized` will not find the profile |
| `skipped macOS notarization … set explicitly false` | You ran `dist:mac`, not `dist:mac:notarized` | Use the notarized script, or add `--config.mac.notarize=true` |
| `Error: HTTP status code: 403` | Wrong Apple ID, or the password was revoked | Regenerate the app-specific password and re-run Step 2 |
| `The timestamp service is not available` | Transient Apple outage during signing | Re-run. It is not your setup |
| `Staged for darwin-arm64 but packaging darwin-x64` | Stage and pack architectures disagree | Run the exact `node stage.js …` command the error prints |
| Notarization rejected, log mentions a `.node` file | The native module lost its signature | Should not happen — `better_sqlite3.node` is unpacked from the asar and signed with the app. Send me the `notarytool log` output |
