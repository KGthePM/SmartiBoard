# Plan: Hand mode (pinch to move nodes)

Webcam hand tracking for the Smarti Board canvas. First capability: **pinch to grab and move nodes**. Air writing is deferred (and if ever built, will be trace-only with no recognition).

## Tooling

`@mediapipe/tasks-vision` (Apache-2.0) — HandLandmarker runs entirely in-browser (WASM/GPU), 21 landmarks per hand, no frames leave the machine, no server changes. Model + WASM loaded from jsdelivr CDN, lazy-imported only when hand mode is first enabled, so page weight is unaffected otherwise.

## 1. Pure logic modules in `lib/hands/` (unit-tested, node-env safe — matches the repo's `lib/**/*.test.ts` pattern)

- **`lib/hands/pinch.ts`** — pinch classifier: thumb-tip (landmark 4) to index-tip (8) distance, normalized by hand size (wrist→middle-MCP) so it works at any distance from the camera. Hysteresis: pinch **on** below ~0.30, **off** above ~0.45 — thresholds tuned later. Pure function: landmarks in, `{ pinch, strength }` out.
- **`lib/hands/map.ts`** — coordinate mapping: mirrored normalized video coords → inner region (0.1–0.9, so edges are reachable) → viewport px → board coords via the same math as `toBoardCoords` (`components/canvas/Board.tsx:41`). Extract that math into a shared helper so mouse and hands can't diverge.
- **`lib/hands/smooth.ts`** — exponential moving average on fingertip position; raw landmarks jitter too much to drive a cursor.
- Tests: `pinch.test.ts`, `map.test.ts`, `smooth.test.ts`.

## 2. Tracker — `lib/hands/tracker.ts`

Framework-free class owning `<video>` + `HandLandmarker`. `start()` requests `getUserMedia`, runs `detectForVideo` on its own rAF loop, calls a subscriber with `{ present, x, y, pinch }` (smoothed, already mapped to screen px). `stop()` kills camera tracks and the loop. Strictly off unless hand mode is on.

## 3. UI — three small pieces

- **`components/canvas/HandModeButton.tsx`** — toggle in `BoardChrome` next to the existing buttons. Opt-in, off by default (camera permission only asked on enable).
- **`components/canvas/CameraPiP.tsx`** — small fixed corner preview, mirrored (`scaleX(-1)`), with minimal landmark dots on an overlay canvas — functional feedback for alignment/debugging, not decoration. Includes a stop control.
- **`components/canvas/HandCursor.tsx`** — a cursor dot positioned imperatively (`el.style.transform` in the tracker callback, **zero React renders per frame**). Open ring when idle, filled when pinching.

## 4. Dispatch — in `Board.tsx`

State machine mirroring the mouse `Drag` union (`components/canvas/Board.tsx:15`):

- **Idle:** fingertip hit-tests nodes via `document.elementFromPoint` — free correctness under the scaled `world` transform. Hovered card gets a subtle outline (distinct from selection styling).
- **Pinch begins over a node:** compute `dx/dy` grab offset exactly like `onDragStart` (`components/canvas/Board.tsx:281`), then call `store.moveNode(id, x - dx, y - dy)` per frame.
- **Pinch ends:** drop, clear.
- **Mouse/hand coexistence:** if a mouse `drag` is active, hand events are ignored (single input-owner guard).

Reusing `store.moveNode` (`lib/store.ts:164`) means every invariant comes free: no undo snapshot per frame, no `lastMutationAt` bump (hand moves can't spend a token — same as mouse), autosave rides along.

## 5. Invariant compliance

- **Latency:** inference runs ~3–8ms/frame on a separate rAF loop only while enabled; per-frame work is one imperative style write plus one `moveNode` — identical cost to a mousemove drag.
- **Function over flourish:** minimal cursor + dots; no skeleton art.
- **Scope:** one gesture (grab/move). No pan/zoom, no connect, no delete, no air writing — follow-ups on the same pinch primitive.

## 6. Verification

`npm run typecheck` + `npm test` (new pinch/map/smooth tests) + manual check at `npm run dev` — toggle hand mode, pinch-drag a node, confirm autosave and ⌘Z behave exactly as with mouse drags.

## Flag for later

- Air writing (trace-only) would reuse this tracker: pinch-held fingertip path → SVG polyline in board coords → node for manual typing. Deferred.
- Deployment note: `getUserMedia` needs HTTPS in production (localhost dev is fine).
