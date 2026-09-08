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

## Phase 2 — feedback (shipped, `1cfbfa7`, 2026-09-08)

Kyle's first live test was blind: he could not tell whether his hand was
detected, where the cursor was, or when the pinch had registered. Phase 2
answers all three, still with zero per-frame React state:

- **On-screen cursor** (queue #4) — a small ring at the filtered cursor
  position, rendered by `Board.tsx` inside `.viewport` but **outside
  `.world`** (surface pixels must not inherit the viewport transform). The
  camera loop writes `{x, y, pinching, present}` frames into a ref;
  `Board` paints them with its own rAF via imperative style writes only.
  Fades out (150ms, the only animation) when the hand drops.
- **Pinch state** — the ring fills solid on the same frame the pinch fires.
  With no haptic channel (Ultraleap / Meta guidance) that visual is the only
  confirmation the pan started.
- **Lost-hand grace** (queue #6) — `HAND_LOST_GRACE_MS = 250` and
  `HandPresence`/`handPresent` in `lib/hand.ts` (pure, tested): a dropped
  frame or two no longer blinks the cursor or ends a pan; the One Euro
  filter resets once the grace expires so a returning hand starts fresh.
- **Pill text** — running-but-untracked says *"show your hand to the
  camera"*; tracking flips it to the pinch hint.

Squad-built (Scout research + Forge implementation), verified independently:
698/698 tests (+7 presence tests), typecheck clean, build clean, dev server
200 on `/board/demo`, and Kyle's live hand test — passed.

## Phase 3 — shipped (2026-09-08)

All three queue items done, verified: 707/707 tests (+9 new in
`lib/hand.test.ts`), `tsc --noEmit` clean.

1. ✅ **Direction inversion fix** — Kyle's phase-1 live test showed hand
   left → cursor right. The lesson: the camera sees the room as an
   *onlooker* does, but the user reads their own hand as in a *mirror* —
   that expectation is what the mapping must answer, and the v0.1 "mirror"
   comment had it backwards. `mapToSurface` now flips x (`1 - nx`) before
   gain; y untouched. The direction test was rewritten for the new intent
   (`mirrors camera x so left is left (inverted)`), and the old
   "gain increases x" test was inverted with it, since gain now amplifies
   the flipped direction.
2. ✅ **Sensitivity setting** — gain is a five-rung select in the Settings
   panel: Precise 1:1 (1.0) / Gentle (1.3) / Default (1.6) / Quick (2.0) /
   Very quick (2.5). `JARVIS_GAIN_STEPS` and `normalizeJarvisGain`
   (nearest-rung snapping, `normalizeGhostDelay` doctrine) live in
   `lib/hand.ts`. The loop reads gain through a latest-value ref — the same
   rail as `getViewport` — so a save applies within a tick and the camera's
   effect still depends on `[active]` alone. **Persistence is
   localStorage (`jarvis-gain`), not the settings row**: that table is
   column-per-field, so a new column + migration was more than this knob
   earns. Delivery through the store (`store.jarvisGain` +
   `setJarvisGain`, install-level like `ghostDelayMs`); Board *subscribes*
   to it and seeds it from localStorage at mount. An absent key means
   untouched — the guard matters, because `Number(null)` is 0 and
   `normalizeJarvisGain` would legally snap that to the 1.0 rung (see
   Lessons below).
3. ✅ **Edge fading** — `edgeFactor(p, band = 0.15)` in `lib/hand.ts`: the
   RAW landmark's distance from the camera frame's edge, fading linearly
   over the outer 15% (the same figure as the mapping margin). The loop
   ships it as `edge` on every cursor frame; the Board's paint rAF writes
   it to `el.style.opacity` (only on >0.02 changes, to spare the style
   system churn at 30Hz). The `.hand-cursor[data-present] { opacity: 1 }`
   CSS rule is gone — the base rule stays at opacity 0 and the existing
   150ms transition now smooths both the presence fade and the per-frame
   edge changes. Ultraleap's affordance, as Scout's research flagged.

**Live test (Kyle, 2026-09-08): passed.** Direction reads as a mirror,
sensitivity changes land live without restarting the camera and survive a
reload, the ring fades before tracking drops at any frame edge, and
pinch-pan with pinch-fill feedback is intact.

## Phase 3 lessons

- **The user's hand reads as a mirror, not as the camera sees it.** A
  camera points at the room like an onlooker; the person on the far side
  of it expects their own left to move things left. When a mapping is
  "backwards in practice", fix the *expectation model* first — the
  one-line flip is trivial once you know whose point of view the cursor
  answers to.
- **A subagent's "applies live" claim must be traced, not trusted.** The
  panel wrote the store while Board read a frozen `useState` snapshot —
  plausible-looking code on both sides, and nothing failed loudly; the
  setting just silently applied on next reload. Verification = follow the
  actual data path from writer to reader.
- **`Number(localStorage.getItem(k))` is 0, not undefined, for an absent
  key** — and a nearest-rung `normalize*` happily snaps 0 onto a legal
  rung (here: 1.0 instead of the 1.6 default). Any read of optional
  storage must distinguish *absent* (`null`) from *present junk* before
  normalizing.
- **Client-only settings still want the store as the live channel.** Even
  when persistence is localStorage, the *runtime* delivery should ride
  the store (the `ghostDelayMs` doctrine): one subscription makes
  writer and reader agree, and a prop/state snapshot version of the same
  value is a divergence waiting to ship.

## Phase 4 — two-hand zoom (shipped, 2026-09-08)

The gesture the touch layer already taught the board — pinch to spread —
done in air. **One pinched hand pans exactly as before; BOTH hands pinched
for three consecutive frames is zoom**, and zoom fully owns the gesture
while it lasts: pan is suppressed, the pill reads *"zoom: spread hands to
zoom, release to stop"*, and the cursor ring turns dashed (the one state a
solid fill and a plain ring cannot be mistaken for — accent token, all
three themes answer it).

| Gesture | Effect |
|---|---|
| One hand pinch + move | Pan (unchanged from v0.1) |
| Both hands pinch, hold 3 frames | Zoom mode: spread apart to zoom in, together to zoom out |
| Either pinch releases | Zoom ends; ~200ms cooldown, then pan is eligible again |

**Design decisions:**

- **Hand identity is proximity, never array order.** MediaPipe's
  `landmarks[]` swaps order between frames — trusting the index would read
  hand A's landmarks as hand B's mid-spread and spike the distance.
  `matchHands` assigns each frame's hands to the previous frame's by
  nearest midpoint (greedy closest pair), and pinch hysteresis runs per
  matched SLOT, so a mid-zoom swap reads as hands holding still, because
  they are.
- **The zoom signal is aspect-corrected.** MediaPipe normalizes x by frame
  width and y by height, so on 16:9 an uncorrected spread is stretched
  ~1.8× horizontally. `zoomDistance` multiplies x by width/height (read
  off the video element) before the hypot.
- **One Euro on ln(dist)** — a scalar variant (`OneEuroScalar`) of the same
  filter, because the zoom signal is one number. Log space is the natural
  home: ratios become differences, so the filter treats a 2× spread the
  same whether the hands sit near or far apart.
- **Ratio from the entry baseline, never accumulated.** `TwoHandZoom`
  baselines on the entry frame (the entry frame carries ratio exactly 1),
  and each frame's ratio is `exp(s_now − s_entry)` — the same anti-ratchet
  doctrine as the touch pinch (`pinchViewport` scales from the START
  distance). Unspread to where you began and the scale comes home.
- **Per-frame clamp ±2% (log space).** Not a dead zone — a rate limit. A
  trembling hold hovers at the baseline and zooms nothing; a hard yank
  travels at the tracker's top speed, not the arm's.
- **Zoom-and-pan jointly**, mirroring the touch pinch: anchored at the
  ENTRY midpoint (mapped to surface coords like pan's cursor), with the
  midpoint's travel since entry added on top (`twoHandZoomViewport`).
  The board point between your hands stays between them.
- **Every entry re-baselines, by construction.** Zoom exits on either
  pinch release OR any hand dropout, and baseline is taken only at entry —
  there is no code path that can carry a stale baseline across a gap. A
  200ms pan cooldown after exit stops the surviving pinched hand from
  yanking the board the instant zoom hands the gesture back.

**The frame-edge caveat:** hands spreading wide leave the camera frame —
zoom-out is bounded by how far apart two hands can be while still seen.
The noted fallback is a one-hand vertical zoom (pinch held, hand raised or
lowered); deliberately **not built** — two gestures were enough for this
phase, and a one-hand vertical drag is uncomfortably close to the pan
gesture it would have to coexist with.

**Files:** `lib/hand.ts` (TwoHandZoom, matchHands, zoomDistance,
OneEuroScalar, twoHandZoomViewport — all pure, all tested), the
`numHands: 2` landmarker option and its dispatch in
`components/canvas/useHandNav.ts`, the `zoom` flag on `HandCursorFrame` +
`statusLabel` line + `data-zoom` paint in `Board.tsx`, and the dashed-ring
rule in `app/globals.css`. Zero per-frame React state held: the only new
React state is the zoom-mode flip (`zooming`), which changes about as
often as `tracking` does.

## Phase 4 verification record

707 → **729 tests** (+22 in `lib/hand.test.ts`: mode machine, aspect-
corrected distance, scalar filter, ratio-from-baseline, per-frame clamp,
re-baseline after dropout, no-ratchet round trip, viewport anchor and
clamp bounds), `tsc --noEmit` clean. Kyle's live two-hand test is still
owed — the mode machine is tested as arithmetic, but whether three frames
feels like "a beat" and whether the 2%/frame rate limit feels right at
arm's length is a body question no test suite answers.

## Phase 4 lessons

- **A "3 consecutive frames" gate that counts the seeding frame is 3
  frames total, not 3 after the first.** The first frame a hand pair is
  seen both-pinched IS stability frame one — the test that assumed
  otherwise was wrong, not the machine. Say what counts as frame one.
- **A One Euro filter has a fixed TIME lag, not a fixed percentage lag.**
  On a steady ramp the output sits ~150ms behind the target forever, so
  "90% of travel" is not a property of the filter — it is a property of
  how long the test's ramp runs. The 2D filter's test passes at 30 frames
  and its scalar sibling needed 60 for the same contract.
- **Write the no-ratchet test as a round trip with a HOLD.** Returning to
  the baseline for a single frame cannot undo the accumulated walk (the
  ±2% cap is doing its job); holding at the baseline until the applied
  value converges is what proves the walk comes home at all.

## Verification record

Per AGENTS.md (no browser/screenshot testing), phase 4 as shipped:
729/729 vitest (35 files; +22 in `lib/hand.test.ts`), `tsc --noEmit` clean,
working tree clean — plus the live two-hand test Kyle still owes the
feature. Earlier phases: phase 3 verified 707 tests (+9), phase 2 added 7
presence tests, phase 1 originally 691 + dev-server 200s on vendored
assets.

**Run it:** check out `jarvis/webcam-hand-nav`, `./start.sh` (or
`./start.sh --lan`), open a board, click **Hand control** in the status row,
allow the camera. Camera access requires `localhost` or HTTPS — a plain LAN
IP will not get a permission prompt.
