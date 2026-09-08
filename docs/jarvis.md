# Project Jarvis — webcam hand navigation (experimental branch)

> **Status:** v0.1 working prototype on `jarvis/webcam-hand-nav`. **`main` is
> untouched** — nothing here is merged. This document records what shipped,
> what the first live test showed, and what was learned.

## What it is

A fourth way to move the board — with a hand, through a webcam. Per the Touch
doctrine, it adds **no gesture a pointer device does not already have**: a
pinched hand pans exactly the way a dragged mouse pans, through the same
`store.setViewport` seam the wheel uses.

| Gesture | Effect |
|---|---|
| Hand visible, open | Cursor tracks the hand (filtered, no board motion) |
| Pinch (thumb + index) and move | Pan the canvas, like dragging empty canvas |
| Hand lost / pinch released | Pan ends; nothing drifts |

Not in v0.1: hand-zoom (the math stub `handZoomViewport` exists in
`lib/hand.ts` for when it lands), card selection by dwell, click-to-select.

## Architecture

The repo's standard division, drawn fresh for hand input:

- **`lib/hand.ts`** (pure, tested) — every rule:
  - `OneEuro` — adaptive smoothing filter (Casiez et al., CHI 2012). Hard at
    rest (kills jitter), open at speed (no pan lag). Tuned `minCutoff=1.0,
    beta=0.05, dCutoff=1.0`.
  - `pinchState` / `PinchDetector` — pinch ratio is thumb-index distance in
    units of hand size (wrist→middle MCP), so thresholds survive changing
    camera distance. Hysteresis: ON < 0.35, OFF > 0.55 — no flicker.
  - `panViewport`, `mapToSurface` — camera-space to surface pixels, mirrored
    (hand right = cursor right) with gain 1.6 and 15% margin, clamped.
- **`components/canvas/useHandNav.ts`** (the only glue) — camera + MediaPipe +
  rAF loop + dispatch. Nothing else knows the webcam exists.
- **`Board.tsx`** — the "Hand control" pill in the status row; `jarvis-toggle`
  CSS uses tokens only (all three themes answer it).
- **`public/mediapipe/`** — vendored WASM runtime + `hand_landmarker.task`
  (7.8 MB, float16). Fully offline-capable; no CDN dependency.

## Stack decisions (and why)

- **`@mediapipe/tasks-vision` 1.0.1** (Apache-2.0, AGPL-compatible): Google's
  current in-browser hand-tracking stack; GPU (WebGL) delegate with ~30-60 FPS
  on integrated graphics; runs entirely in the browser — **no video ever
  leaves the machine** (consistent with Privacy Mode being about models).
- **Lazy `import()` at toggle time**: the package (~37 MB unpacked) never
  enters the main bundle; nothing loads until the user asks for the camera.
- **Camera lifecycle = the toggle, exactly**: tracks stop on toggle-off; no
  background camera ever.

## First live test (Kyle, 2026-09-08)

**Result: working.** Pinch-and-pan navigated the board. One launch bug found
and fixed in the same session (`36031ff`):

- **The bug:** the hook took inline arrow callbacks and listed them in the
  effect dependency array. They are new objects on every Board re-render
  (autosave indicator flips, ghost trigger ticks — Board re-renders often), so
  the effect tore down and re-created the camera in a loop. To the user:
  camera light flashing, "Loading…" forever, and the browser re-raising the
  window on every `getUserMedia` re-request.
- **The fix:** callbacks ride latest-value refs; the effect depends on
  `active` alone. The camera lifecycle changes only when the toggle changes.
- **Lesson:** in this codebase a hook that owns hardware must treat
  *everything else* as ref-stable — re-render is not an event.

**Honest assessment:** "a little rough but worked." Pan tracked with visible
hesitation/jitter at speed. Good enough to validate the concept; not yet
something to demo without a caveat.

## Phase 2 — refinement queue (unordered)

1. **Tuning pass on real hands**: beta and gain feel off by default; expose
   them (Settings? query param? dev panel) and find values that feel right.
2. **Zoom by hand** — hold pinch with a second hand or dwell-to-zoom; must go
   through `zoomAround` like every other zoom.
3. **Select/drag cards** — dwell-to-click on a card; needs the same
   click-vs-drag slop thinking as touch (see AGENTS.md "Touch").
4. **On-screen cursor** — show the filtered cursor while the hand is up so
   users get feedback about *why* nothing is panning yet.
5. **Multi-hand policy** — currently `numHands: 1`; decide deliberately if
   that ever becomes 2.
6. **Lost-hand grace** — a 200-300ms hold on pan when detection drops a frame
   or two, instead of immediately ending the drag.
7. **Performance check on the worst machine** (Intel UHD 630) — GPU delegate
   fallback ladder if WebGL misbehaves (CPU delegate, 640×480, frame skip).

## Verification record

Per AGENTS.md (no browser/screenshot testing): 691/691 vitest (15 new in
`lib/hand.test.ts`), `tsc --noEmit` clean, `next build` clean, dev server
booted on repo Node 24 with `/board/demo` 200 and all vendored assets 200 —
plus Kyle's live hand test, which is the one check no test suite replaces.

**Run it:** check out `jarvis/webcam-hand-nav`, `./start.sh` (or
`./start.sh --lan`), open a board, click **Hand control** in the status row,
allow the camera. Camera access requires `localhost` or HTTPS — a plain LAN
IP will not get a permission prompt.
