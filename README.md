# Smarti Board

A web idea board where an AI continuously co-authors the board with you — proposing
gap-fills and connections as you work — rather than responding to prompts on demand.
One deliberate exception: **⌘.** opens an ideas panel where one click asks for a handful of
candidate ideas — for the whole board, or branching off the card you have selected. They
stage in the panel until you add the ones that land; nothing reaches the board on its own.

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

Configuring nothing is a supported configuration: the board is fully usable, it just
doesn't co-author.

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

## Boards

`/` is the project library: every board as a card, with a minimap of its actual graph — a
board is usually easier to recognize by shape than by name.

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

Some boards you want a collaborator on. Some you want a wall. **⌘⇧P** turns on **Privacy
Mode** for the board you're looking at, and while it's on nothing in that board is sent to
a model — no suggestions arrive, and the Ideas button is unavailable, because generating
ships the whole board upstream too.

It's per board, not per install. You keep your provider and your key configured, and the
other boards go on co-authoring as before; the alternative — deleting your key in Settings —
was all-or-nothing and is what this replaces. The button says which state you're in at a
glance, filled when it's on, because a privacy switch you have to squint at is not one.

The promise is kept by the server, not the browser. The `/suggest` and `/ideas` routes
each check the board themselves and refuse, so a tab left open in another window, a retry,
or anything that isn't the canvas gets the same answer. And **⌘Z can never turn it off** —
Privacy Mode is deliberately not in the undo stack, because an undo that quietly put a board
back on speaking terms with a model is one you'd never notice.

Turning it back off doesn't immediately produce a suggestion: the flag isn't part of what
the AI reads, so the board looks unchanged to it. The next real edit wakes it.

## How it decides when to speak

"Continuously" cannot mean per-keystroke — that is expensive and, worse, it is the
difference between a collaborator and a paperclip. `lib/ai/trigger.ts` holds the whole
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

## License

AGPL-3.0-only. Self-host it freely; if you run a modified version as a network service,
the source goes back out.
