# Smarti Board

A local idea board with a built-in Smarti Assistant that points out gap-fills and
connections as you work — rather than responding to prompts on demand.
One deliberate exception: **⌘.** opens an ideas panel where one click asks for a handful of
candidate ideas — for the whole board, or branching off the card you have selected. They
stage in the panel until you add the ones that land; nothing reaches the board on its own.

The board is a **typed graph** (nodes + edges), not a pixel canvas. That's what makes the
AI behavior tractable, and it's what everything else is built on.

## The three layers

Suggestions live in their own layer, so it's never ambiguous what's yours and what's
proposed. Three visually distinct layers coexist on the board at all times:

| Layer | Looks like | Lives in |
|---|---|---|
| Yours | Solid card | `board.nodes` (`layer: 'user'`) |
| Suggested | Dashed, muted, distinct hue | `store.proposal` — **never** in `board.nodes` |
| Accepted | Solid card with a small authorship dot | `board.nodes` (`layer: 'accepted'`) |

Accepting a proposal constructs a *new* node; the proposal object itself is discarded.
There is no code path that merges a suggestion into your content implicitly.

## Windows desktop app

Download the signed Windows x64 installer from
[SmartiBoard-Releases](https://github.com/KGthePM/SmartiBoard-Releases/releases). The
assisted installer lets you choose the installation directory and whether to add a desktop
shortcut; it always adds a Start menu shortcut. Smarti Board runs as one local app with no
service, tray process, login, or listening LAN port.

On first launch, choose **Import existing data** to select a `smarti.db` from a self-hosted
copy, or **Start fresh**. Import makes a consistent SQLite snapshot, including committed WAL
changes, and never modifies the selected file. The desktop copy lives at:

```text
%LOCALAPPDATA%\Smarti Board\data\smarti.db
```

Boards, themes, provider settings, and the saved provider key all live in that file.
Uninstalling the app deliberately keeps it, so reinstalling does not erase your work. Remove
the `Smarti Board` LocalAppData folder yourself only when you intend to delete all local data.

The app checks for an update after launch. It asks before downloading; once downloaded, you
can restart immediately or let the update install when you next quit. **Settings > Desktop
updates** also has a manual check. Release pages include SHA-256 checksums, third-party
notices, and the exact corresponding source archive for each AGPL-3.0-only build.

## Running the web edition

Download the matching `SmartiBoard-Source-<version>.zip` from the
[public release](https://github.com/KGthePM/SmartiBoard-Releases/releases), verify it with
`SHA256SUMS.txt`, and extract it. Maintainers with access to the private source repository can
instead clone it and check out the matching `v<version>` tag.

macOS, Linux, or WSL:

```bash
./start.sh                # http://localhost:3000
```

Windows PowerShell:

```powershell
.\start.ps1               # http://localhost:3000
```

Windows Command Prompt:

```bat
start.cmd                 # http://localhost:3000
```

That is the whole install. The start script checks whether your Node is one this app can use
(22-26) and, if not, downloads its own into `./.node` and uses that. No `sudo`, no version
manager to install first, no change to the Node already on your system — everything it
creates lives inside the cloned folder. Debian and Ubuntu still ship Node 18, so on a stock
Linux box this is the difference between working and not; native Windows gets the same
private Node treatment from `start.ps1`.

**Already on Node 22-26?** Then the ordinary commands are all you need, and nothing gets
downloaded on any OS:

```bash
npm install
npm run dev               # http://localhost:3000
```

For a production run instead of the dev server:

```bash
npm run build
npm start                 # http://localhost:3000
```

The `data/` directory and the SQLite file inside it are created on first run — no setup
step, no migration to apply. A fresh clone opens onto one board, the tutorial (below).

### On your phone, on your own network

```bash
./start.sh --lan          # macOS/Linux/WSL
```

```powershell
.\start.ps1 --lan         # Windows PowerShell
```

```bat
start.cmd --lan           # Windows Command Prompt
```

The flag binds the server to every interface instead of just loopback and prints the address
to type into the other device. Without it the server listens on `127.0.0.1` only — note that
this is *not* the Next.js default, which is every interface; the `dev` and `start` scripts pin
the host so that the safe case is the one you get by doing nothing. `SMARTI_LAN=1 ./start.sh`
or `$env:SMARTI_LAN=1; .\start.ps1` does the same thing, as does `SMARTI_HOST=0.0.0.0 npm run dev`
or `$env:SMARTI_HOST='0.0.0.0'; npm run dev` if you skip the script. It is what you
want when the boards live on your laptop and you would like to read or edit them from a phone
or tablet in the same house. The canvas answers touch: drag to pan, pinch to zoom, drag a card
to move it, drag the dot to connect, and **hold** where you would press Shift — on empty canvas
to sweep a selection, on a card to add it to one. Double-tap the canvas for a new idea, tap a
card to select it, double-tap it to edit.

**It is opt-in every run, and it should be.** Smarti Board has no login, no session, and no
per-user anything — one SQLite file, one settings row, and every `/api` route answers whoever
asks. Anyone who can reach that address can read and edit every board, and can spend whatever
model provider key you configured. That is a fine trade on your own Wi-Fi and a bad one on a
café or conference network, which is exactly why the app will not make the choice for you.

<details>
<summary><strong>Why Node 22+, and what if <code>npm install</code> refuses to run?</strong></summary>

Running `npm install` on an unsupported Node stops immediately with:

```
npm ERR! code EBADENGINE
npm ERR! notsup Required: {"node":">=22 <27"}
```

That is deliberate, and stopping is the *good* outcome — nothing has been installed or
half-built. The app depends on better-sqlite3, a native module, and it publishes prebuilt
binaries only for Node 22, 24, 25 and 26. On anything older there is no prebuilt binary, so
npm falls back to compiling it from source with `node-gyp`, which needs `python3` and a C++
toolchain and fails on plenty of otherwise healthy machines. (Node 20 is excluded for the
same reason: it is supported by the library but has no published prebuild.)

Easiest fix, nothing to install:

```bash
./start.sh                # macOS/Linux/WSL
```

```powershell
.\start.ps1               # Windows
```

Or install Node yourself:

```bash
nvm install 24 && nvm use 24
# or, on Debian/Ubuntu without nvm:
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
```

On Windows, install Node 24 from nodejs.org or use `start.ps1` and let the project download
its private copy.

Then remove `node_modules` and run `npm install` again.
</details>

**Bring your own model.** Open the ⚙ in the top-right (or `⌘,`) and pick one:

| Provider | Needs | Notes |
|---|---|---|
| Anthropic (Claude) | API key | Structured output and adaptive thinking — the reference path. |
| z.ai (GLM) | API key | OpenAI-compatible endpoint. |
| z.ai Coding Plan (GLM) | API key | For Coding Plan subscriptions: Anthropic-compatible coding endpoint. A plan key has no balance on the general z.ai API above. |
| Ollama (local) | nothing | `http://localhost:11434/v1`. Nothing leaves your machine. |
| Custom | endpoint + model | Anything speaking OpenAI chat-completions: LM Studio, vLLM, OpenRouter. |

**Load models** asks the provider which models your key can actually reach and turns the
Model field into a dropdown of them. It only ever runs when you click it, and a model you
already typed or saved is kept even if the provider didn't list it — pick *Type a name…*
to go back to the text box.

**Test** makes one one-token call and tells you whether the key, the address, and the
model name are right. Along with Load models it is the only place the app reports an AI
failure out loud — the ghost and the ideas panel fail quietly on purpose.

The key is stored in the same local SQLite file as your boards and is **write-only**: it
goes to the server once and never comes back, not even to the panel that saved it, which
sees only the last four characters. `ANTHROPIC_API_KEY` still works as a headless
fallback, used only when nothing has been saved in Settings.

Configuring nothing is a supported configuration: the board is fully usable; the
assistant simply stays off.

Board state is one SQLite file (`SMARTI_DB_PATH`, default `./data/smarti.db`), one row per
board. No external services — self-hosting is one process. That default is relative to the
working directory, so start the app from the repo root or set `SMARTI_DB_PATH` to an
absolute path; otherwise you get a second, empty database instead of an error. The server
prints the path it opened on first use.

```bash
npm test          # placement, trigger policy, rich text, board naming, board switching, idea parsing
npm run typecheck
npm run build
```

The Windows desktop packaging commands and signed release procedure are documented in
[`desktop/README.md`](desktop/README.md).

## Boards

`/` is the project library: every board as a card, with a minimap of its actual graph — a
board is usually easier to recognize by shape than by name.

**The first board is a tutorial.** An empty library seeds one — an ordinary board whose
cards each teach one thing and are arranged so that reading them means doing them: the card
explaining resize is too small to show its own text, the card explaining connections sits
next to the one card nothing is linked to. It is a real board, so edit it, wreck it, archive
it, or delete it; *Open the tutorial board* under the header in the library brings a fresh
copy back whenever you want one.

**Boards name themselves.** There is no naming step, for the same reason there is no save
button. A board is titled after its first idea, stripped of formatting; rename it from the
top-right corner of the canvas and the override sticks. Clear the field and the name goes
back to the content. Renaming never changes the URL.

**⌘K** switches boards from inside the canvas: type to filter, ↑/↓ and Enter to go, or make
a new one. Switching is clean — the undo/redo stacks, the live ghost, and the AI's memory of
what you dismissed all belong to the board you were on, not to the session.

**Deleting is two steps.** Archive moves a board out of the library and is reversible from
the Archived section; permanent deletion is only offered on a board that is already
archived. Nothing on the board is destroyed by a single click — same principle as the ghost
layer.

## Using the board

- **Double-click** empty canvas to add an idea
- **Drag** a card to move it; **drag the dot** on its right edge to another card to connect
- **Shift+click** cards, or **Shift+drag** on empty canvas, to select several — drag moves
  them together and **Backspace** deletes them all as one undoable step
- **Scroll** to zoom, drag the background to pan
- **⌘Z / Ctrl+Z** to undo, **⌘⇧Z / Ctrl+Y** to redo; **Backspace** deletes the selection
- Suggestions appear on their own. **Accept** or **Dismiss** — both are one click, and
  accepting is undoable
- **⌘F / Ctrl+F** (or the **Find** button) opens find and replace over this board — every
  card and the objective. Matches are tinted where they sit, **Enter / ⇧Enter** (or ⌘G) walk
  them and bring the canvas along, and **Replace all** is a single undo. It searches what you
  can *read*, so formatting never hides a word from you
- **⌘J / Ctrl+J** (or the **Objective** button) opens the board's objective — a few lines
  on what this board is for. Optional, but it is the one thing that changes *what* the AI
  suggests rather than *when*
- **⌘. / Ctrl+.** (or the **Ideas** button) asks for a few candidate ideas, listed with
  their reasons as they arrive. Each has one **Add**; nothing is on the board until you
  click it, and adding is undoable. Select a card first and it branches off that idea instead
- **⌘⇧P / Ctrl+Shift+P** (or the **Private** button) turns Privacy Mode on for this board:
  no suggestions, no ideas, nothing sent to a model. Per-board, so the rest keep working
- **⌘⇧F / Ctrl+Shift+F** (or the **Present** button) puts the board on a screen for a room:
  fullscreen, read-only, everything fitted to view. Pan and zoom still work; **Esc** exits
  and you come back exactly where you were
- **⌘P / Ctrl+P** (or the **Print** button) prints the board — or saves it as a PDF — as a
  read-only paper copy: the whole board on one page, shrinking as far as ~40% to make it
  fit; only a truly sprawling board tiles across pages. Every card and connection prints
  with its done strikes and formatting; the AI's pending suggestion, selections, and search
  highlights never do

## What the board is for

Every board can carry an **objective**: a few lines, up to 400 characters, saying what you're
trying to do here. Open it with **⌘J**, type, and close — there's no save button, same as
everywhere else.

It's optional, and short on purpose. It leads the prompt for both AI behaviors, so the
suggestions stop being generic "have you considered a success metric?" gap-fills and start
being about your actual stakes; and ⌘. generates *toward* it, which is what makes an empty
board with an objective on it the moment the generator is worth most.

It stays yours. Nothing rewrites, condenses, or restates your objective back at you, and
the AI is told not to propose it back as an idea. The character cap does the work a model
would otherwise be asked to do.

## Keeping a board to yourself

Some boards you want the assistant on. Some you want a wall. **⌘⇧P** turns on **Privacy
Mode** for the board you're looking at, and while it's on nothing in that board is sent to
a model — no suggestions arrive, and the Ideas button is unavailable, because generating
ships the whole board upstream too.

It's per board, not per install. You keep your provider and your key configured, and the
other boards keep their suggestions as before; the alternative — deleting your key in Settings —
was all-or-nothing and is what this replaces. The button says which state you're in at a
glance, filled when it's on, because a privacy switch you have to squint at is not one.

The promise is kept by the server, not the browser. The `/suggest` and `/ideas` routes
each check the board themselves and refuse, so a tab left open in another window, a retry,
or anything that isn't the canvas gets the same answer. And **⌘Z can never turn it off** —
Privacy Mode is deliberately not in the undo stack, because an undo that quietly put a board
back on speaking terms with a model is one you'd never notice.

Turning it back off doesn't immediately produce a suggestion: the flag isn't part of what
the AI reads, so the board looks unchanged to it. The next real edit wakes it.

## How it decides when to run

"Continuously" cannot mean per-keystroke — that is expensive and, worse, it is the
difference between an assistant and a paperclip. `lib/ai/trigger.ts` holds the whole
policy as pure functions, and it is the file to tune when the behavior feels wrong:

1. Privacy Mode, checked before anything else — a private board is not one the AI is quiet
   on, it's one the AI is never told about
2. 4s debounce after the last meaningful change
3. A semantic fingerprint of the board — text, topology, and the objective, deliberately
   **not** position, so dragging a card never spends a token but rewriting the objective
   does (the model reads it; it changes what the board says)
4. At least 3 non-empty ideas before there's anything to reason about
5. At most one live suggestion on the canvas at a time
6. Session memory of what you dismissed, so it doesn't re-offer a reworded version

Placement (`lib/placement.ts`) spirals outward from the ideas a suggestion references,
taking the first spot that doesn't occlude anything you placed.

**A suggestion appearing is never in your undo stack.** Accepting one is a normal user
action and is. Reversed, the board would feel haunted.

## When you ask, instead

The idea generator is the one behavior you invoke rather than wait for, and it plays by
different rules because you asked:

- It streams — someone is actively waiting, so ideas appear one at a time as the model
  writes them, not in a batch at the end
- Ideas stage in the panel and never on the canvas. The one-live-ghost ceiling is untouched,
  and **Add** is the only bridge — it builds a fresh node in the accepted layer, connects it
  to the ideas it came from, and goes in your undo stack like any other edit
- Added items stay in the list, greyed out. A list that reshuffles under the cursor makes
  your next click a gamble
- It's cached per board fingerprint for the session: reopen the panel with nothing changed
  and nothing is re-spent
- Opening the panel never spends a token: you get the last list if it's still fresh,
  otherwise a launch button. The click is the asking
- Switching boards under an open panel never generates for the next board — the panel
  closes. Navigating is not asking
- Closing the panel (Esc, ×, ⌘., or a board switch) aborts the stream and discards the
  partial list — reopening offers the button again
- **A lower floor than the ghost's:** an objective or a single idea is enough. The ghost
  needs three cards because nobody asked it to speak; this was asked, and a blank board
  with a goal written on it is exactly when it's worth most

## v1 scope

In: draggable text nodes on an infinite canvas, one relationship type, instant autosave,
many named boards, and exactly one *unsolicited* AI behavior — propose a gap-fill or
connection, one-click accept/dismiss — plus one *user-invoked* behavior, the idea generator
(v2.0, replacing the read-only summary that held the slot from v1.3). Either can be switched
off per board with Privacy Mode (v1.9).

Out: real-time multiplayer, freehand drawing, images, styling, cross-session memory,
model choice, any further AI behaviors. The AI also never moves or edits a node you placed.

Tuned for early-stage **product and strategy ideation**: gap-fills are missing risks,
unaddressed segments, unstated assumptions, absent success metrics, hidden dependencies.

## Landing page

`landing/` is the separately hosted marketing site — a self-contained static
`index.html`, plus `support.html` (FAQ, troubleshooting, feedback) — deployed to
Netlify, not part of the Next.js app. Each page carries its own inline styles;
changes there ship with the Netlify deploy, not with `npm run build`.

It is **git-ignored and local-only**: the folder is uploaded to Netlify directly, so
a clone of this repo will not contain it and nothing in `landing/` is version
controlled. Nothing in the app reads it, and no build step looks for it.

## License

AGPL-3.0-only. Self-host it freely; if you run a modified version as a network service,
the source goes back out.
