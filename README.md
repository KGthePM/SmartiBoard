# Smarti Board

A web idea board where an AI continuously co-authors the board with you — proposing
gap-fills and connections as you work — rather than responding to prompts on demand.
One deliberate exception: **⌘.** asks for a read-only summary of the whole board, streamed
into a side panel and never merged into your content.

The board is a **typed graph** (nodes + edges), not a pixel canvas. That's what makes the
AI behavior tractable, and it's what everything else is built on.

## The three layers

The AI edits a workspace you consider your own thinking, so authorship is never ambiguous.
Three visually distinct layers coexist on the board at all times:

| Layer | Looks like | Lives in |
|---|---|---|
| Yours | Solid card | `board.nodes` (`layer: 'user'`) |
| Suggested | Dashed, muted, distinct hue | `store.proposal` — **never** in `board.nodes` |
| Accepted | Solid card with a small authorship dot | `board.nodes` (`layer: 'accepted'`) |

Accepting a proposal constructs a *new* node; the proposal object itself is discarded.
There is no code path that merges a suggestion into your content implicitly.

## Running it

```bash
git clone https://github.com/KGthePM/SmartiBoard.git
cd SmartiBoard
./start.sh                # http://localhost:3000
```

That is the whole install. `start.sh` checks whether your Node is one this app can use
(22-26) and, if not, downloads its own into `./.node` and uses that. No `sudo`, no version
manager to install first, no change to the Node already on your system — everything it
creates lives inside the cloned folder. Debian and Ubuntu still ship Node 18, so on a stock
Linux box this is the difference between working and not.

**Already on Node 22 or 24?** Then the ordinary commands are all you need, and nothing gets
downloaded:

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
step, no migration to apply, nothing to seed. A fresh clone starts with an empty library.

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
./start.sh
```

Or install Node yourself:

```bash
nvm install 24 && nvm use 24
# or, on Debian/Ubuntu without nvm:
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Then `rm -rf node_modules && npm install`.

Windows is not covered by `start.sh` — use WSL, or install Node 22+ and run the npm commands
directly.
</details>

**Bring your own model.** Open the ⚙ in the top-right (or `⌘,`) and pick one:

| Provider | Needs | Notes |
|---|---|---|
| Anthropic (Claude) | API key | Structured output and adaptive thinking — the reference path. |
| z.ai (GLM) | API key | OpenAI-compatible endpoint. |
| Ollama (local) | nothing | `http://localhost:11434/v1`. Nothing leaves your machine. |
| Custom | endpoint + model | Anything speaking OpenAI chat-completions: LM Studio, vLLM, OpenRouter. |

**Test** makes one one-token call and tells you whether the key, the address, and the
model name are right. It is the only place the app reports an AI failure out loud — the
ghost and the summary fail quietly on purpose.

The key is stored in the same local SQLite file as your boards and is **write-only**: it
goes to the server once and never comes back, not even to the panel that saved it, which
sees only the last four characters. `ANTHROPIC_API_KEY` still works as a headless
fallback, used only when nothing has been saved in Settings.

Configuring nothing is a supported configuration: the board is fully usable, it just
doesn't co-author.

Board state is one SQLite file (`SMARTI_DB_PATH`, default `./data/smarti.db`), one row per
board. No external services — self-hosting is one process. That default is relative to the
working directory, so start the app from the repo root or set `SMARTI_DB_PATH` to an
absolute path; otherwise you get a second, empty database instead of an error. The server
prints the path it opened on first use.

```bash
npm test          # placement, trigger policy, rich text, board naming, board switching, summary prompt
npm run typecheck
npm run build
```

## Boards

`/` is the project library: every board as a card, with a minimap of its actual graph — a
board is usually easier to recognize by shape than by name.

**Boards name themselves.** There is no naming step, for the same reason there is no save
button. A board is titled after its first idea, stripped of formatting; rename it from the
top-right corner of the canvas and the override sticks. Clear the field and the name goes
back to the content. Renaming never changes the URL.

**⌘K** switches boards from inside the canvas: type to filter, ↑/↓ and Enter to go, or make
a new one. Switching is clean — the undo stack, the live ghost, and the AI's memory of what
you dismissed all belong to the board you were on, not to the session.

**Deleting is two steps.** Archive moves a board out of the library and is reversible from
the Archived section; permanent deletion is only offered on a board that is already
archived. Nothing on the board is destroyed by a single click — same principle as the ghost
layer.

## Using the board

- **Double-click** empty canvas to add an idea
- **Drag** a card to move it; **drag the dot** on its right edge to another card to connect
- **Scroll** to zoom, drag the background to pan
- **⌘Z / Ctrl+Z** to undo; **Backspace** deletes the selected card
- Suggestions appear on their own. **Accept** or **Dismiss** — both are one click, and
  accepting is undoable
- **⌘. / Ctrl+.** (or the **Summarize** button) reads the board back: one gist line plus a
  few observations, streamed as they're written. It's read-only — never a node, never the
  board's name, and gone when the session is

## How it decides when to speak

"Continuously" cannot mean per-keystroke — that is expensive and, worse, it is the
difference between a collaborator and a paperclip. `lib/ai/trigger.ts` holds the whole
policy as pure functions, and it is the file to tune when the behavior feels wrong:

1. 4s debounce after the last meaningful change
2. A semantic fingerprint of the board — text and topology, deliberately **not** position,
   so dragging a card never spends a token
3. At least 3 non-empty ideas before there's anything to reason about
4. At most one live suggestion on the canvas at a time
5. Session memory of what you dismissed, so it doesn't re-offer a reworded version

Placement (`lib/placement.ts`) spirals outward from the ideas a suggestion references,
taking the first spot that doesn't occlude anything you placed.

**A suggestion appearing is never in your undo stack.** Accepting one is a normal user
action and is. Reversed, the board would feel haunted.

## When you ask, instead

The summary is the one behavior you invoke rather than wait for, and it plays by the
opposite rules because it answers a question rather than proposing content:

- It streams — someone is actively waiting, so tokens appear as they're written
- It's cached per board fingerprint for the session: reopen the panel with nothing changed
  and nothing is re-spent
- It's read-only and session-only: no node, no edge, no title change, no undo entry,
  nothing written to SQLite
- Switching boards under an open panel never auto-summarizes the next board — you get a
  button. Navigating is not asking
- Closing the panel (Esc, ×, ⌘., or a board switch) aborts the stream mid-token
- Same floor as the ghost: fewer than 3 real ideas and there's nothing to read yet

## v1 scope

In: draggable text nodes on an infinite canvas, one relationship type, instant autosave,
many named boards, and exactly one *unsolicited* AI behavior — propose a gap-fill or
connection, one-click accept/dismiss — plus one *user-invoked* behavior, the read-only
board summary (v1.3).

Out: real-time multiplayer, freehand drawing, images, styling, cross-session memory,
model choice, any further AI behaviors. The AI also never moves or edits a node you placed.

Tuned for early-stage **product and strategy ideation**: gap-fills are missing risks,
unaddressed segments, unstated assumptions, absent success metrics, hidden dependencies.

## License

AGPL-3.0-only. Self-host it freely; if you run a modified version as a network service,
the source goes back out.
