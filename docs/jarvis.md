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

## Phase 4, tuning round 1 (2026-09-08)

Kyle's first two-hand live test: zoom triggered occasionally, but the
gesture was **hard to do** and nobody could say why — tuning was blind.
This round adds the eyes and fixes what they already show:

- **The bug the live test was feeling: a second hand entering the frame
  alone killed the loop.** `matchHands` answers −1 for an observation with
  no previous hand to match, and the update loop indexed straight into the
  slots with it — `tracks[-1]`, undefined, a throw in the rAF tick, every
  frame after that. Raise your second hand while one was already tracked
  (the natural way to start the gesture) and the cursor froze, pan died,
  and zoom could only enter when both hands happened to arrive together.
  That is "occasionally, and hard to do" exactly. Unmatched observations
  now seed a fresh slot — with its own `PinchDetector`, which the hypothesized
  "slot 1 has no detector" bug never actually lacked — and a third hand over
  a full machine is dropped, not thrown on. (**Instrumentation found this
  before the first debug chip was ever rendered — writing the readout forced
  the second hand's data path to be traced.**)
- **The entry climb forgives detection dropouts.** A frame where a hand
  blinks out of the tracker used to reset the stability count to zero; it
  now decays by `ZOOM_ENTER_DECAY` (1) per missed frame, so a hand that
  flickers near the top of the climb loses one frame of progress, not the
  climb. A frame where both hands are SEEN and one is genuinely open still
  resets — the forgiveness is for the tracker, never for a pinch the camera
  watched open. `ZOOM_ENTER_FRAMES` stays 3: with 2, decay can never hold
  partial progress (the count never exceeds 1 while idle), and the live
  test's failure was the crash above, not the count.
- **A second cursor ring for hand 2.** Kyle had no way to see whether his
  second hand was tracked or when its pinch registered, so he could never
  tell when zoom was possible. The loop now writes BOTH hands' frames
  through the one ref (`hands[0]` / `hands[1]`, hand 1 mapped exactly as
  before — pan behavior is unchanged), and Board's paint rAF paints a
  second, smaller, outlined ring that fades in with hand 2's presence and
  fills on ITS pinch. **Two filled rings = zoom entering or active.** Each
  ring follows the same physical hand across the landmarker's array
  shuffling (`cursorObservations` reads the slot machine's proximity map,
  not array order).
- **The debug chip** — `?jarvis-debug=1` renders a small monospace readout
  under the pill, written imperatively from the paint rAF (zero per-frame
  React state; the param is read once in an effect, the hydrate-safety
  rule): `0.41 0.63 | f 1/3 | pan` — each visible hand's raw pinch ratio,
  the entry counter, and the mode (`pan` / `armed` / `zoom` / `cooldown`).
  Absent the param, the board is pixel-identical to before. The next live
  test is diagnostic instead of blind.
- **The tuning constants are now named and central** in `lib/hand.ts`:
  `ZOOM_ENTER_FRAMES`, `ZOOM_ENTER_DECAY`, `ZOOM_PAN_COOLDOWN_MS`,
  `ZOOM_LOG_STEP_MAX` — the next tuning round is a one-line diff each.

## Tuning round 1 live test (Kyle, 2026-09-08): PASSED

Kyle's second two-hand test, after the solo-entry fix and with the second
ring visible: **"much easier to zoom now with the second hand cursor
visible plus bug fix."** The gesture that read as broken-by-design in the
first test was, in fact, one unguarded index away from working.

**Phase 4 is functionally complete.** What remains in the queue is
dwell-to-select (the last v0.1 stub concept), not zoom.

## Tuning round 1 lessons

- **Instrument before tuning — and notice that the instrument IS a trace.**
  The bug was found while *building* the debug chip, before the chip ever
  rendered: making the second hand's data path explicit enough to display
  forced the `tracks[-1]` hole into the open. A blind tuning pass (lower
  the frame gate, soften the thresholds) would have shipped constants
  apologizing for a crash.
- **A silent per-frame throw reads as "the gesture doesn't work."** An
  exception in the rAF loop never shows the user an error — it shows a
  frozen cursor and a feature that fires "occasionally, and hard to do."
  In a hot loop, fail loudly or structure the code so it cannot throw;
  every index into a machine's internal slots gets a guard, because the
  input (how many hands are visible) is the physical world's, not ours.
- **Every tracked entity needs its own feedback channel.** Phase 2's
  lesson was "the user must see the cursor"; phase 4's addendum is "the
  user must see EACH actor." One ring was the pan story; zoom is a
  two-hand story, and half its state (hand 2) was invisible, so the
  gesture was unknowable even when it worked. Visibility scales with the
  number of participants, not the number of features.
- **Bugs found in live tests should be explained, not just fixed.** "Zoom
  is hard to do" and "`matchHands` returns −1 unguarded" are the same
  fact at two altitudes; the fix was one line, but only connecting them
  confirmed it was THE fix and not A fix. The re-test passing cleanly —
  no constant changes needed — is what proves the diagnosis.

## Verification record

Per AGENTS.md (no browser/screenshot testing), phase 4 as shipped:
729/729 vitest (35 files; +22 in `lib/hand.test.ts`), `tsc --noEmit` clean,
working tree clean. Earlier phases: phase 3 verified 707 tests (+9), phase
2 added 7 presence tests, phase 1 originally 691 + dev-server 200s on
vendored assets.

Tuning round 1: **737/737 vitest** (+8 in `lib/hand.test.ts`: dropout
decay ×2, honest-reset, second-hand slot seeding, over-slot tolerance,
`cursorObservations` attribution ×4, and the entry-frame test re-anchored),
`tsc --noEmit` clean.

## Phase 5 — edge auto-scroll for drags (shipped, 2026-09-08)

A drag that reaches the edge of the screen now takes the board with it: hold a
card, a marquee, a connect line, or a resize within `EDGE_ZONE_PX` (56) of the
surface's edge and the viewport pans — up to `EDGE_MAX_SPEED` (900 surface px/s)
at the edge itself, ramping linearly from the zone's inner boundary. The feature
the canvas never had; without it a board bigger than the screen could not be
dragged across itself in one gesture.

| Gesture | Effect |
|---|---|
| Any editing drag held near an edge | Viewport pans toward the off-screen content |
| Pan (empty-canvas drag) / two-finger pinch | Never auto-scroll — those gestures ARE the camera |
| Pointer carried past the edge | Scroll holds full speed (capture keeps the pointer driving) |

**Design decisions:**

- **The arithmetic is `lib/gesture.ts`** (`edgeScrollVelocity`,
  `scrollViewport`, the two constants), pure and tested — velocity is one
  question per axis, answered independently so a corner asks both at once;
  `scrollViewport` is one integration step of the drag-pan's own arithmetic
  (panning rightward moves the viewport's translate left).
- **The drag is RE-APPLIED after each scroll step.** The board moved under a
  pointer that did not; without the reapply the card would slide out from
  under a stationary pointer — the exact failure auto-scroll exists to
  prevent. The reapply uses the same arithmetic the pointermove handlers use,
  computed against the viewport as it now stands (nodes batch, resize deltas
  rescaled, marquee and connect endpoints recomputed).
- **Zero React state**, the Jarvis-cursor doctrine: the pointer's client and
  surface positions ride refs written at `pointerdown` (a press HELD at the
  edge is as much an ask to scroll as a move there — and writing at down,
  not at effect start, means a marquee that calls `setDrag` per move can
  never wipe its own anchor) and updated by `onPointerMove`; an rAF loop,
  alive only while a scrollable drag is in flight, reads the store via
  `getState()` and writes through `setViewport` — the same seam the pan,
  wheel, pinch, and hand pan use. `dt` is capped at 100ms so a stalled frame
  cannot jump the board.
- **Pan and pinch are excluded** — the auto-scroll answers drags that need
  more screen than they have, never the gestures that are themselves the
  camera. Presenting needs no gate: its CSS already makes cards
  pointer-events-none and gates the marquee, so no scrollable drag can start.
- **Not a hand feature, and that is the point.** It ships on the Jarvis
  branch only because the hand nav made long drags common, but it serves the
  mouse and the finger identically — per the Touch doctrine, nothing here is
  a gesture a pointer device does not already get.

**Files:** `lib/gesture.ts` (+ `edgeScrollVelocity`, `scrollViewport`,
`EDGE_ZONE_PX`, `EDGE_MAX_SPEED`), `lib/gesture.test.ts` (+6 tests), the refs /
rAF loop / pointer-anchor writes in `components/canvas/Board.tsx`.

**Phase 5 verification:** 737 → **743 tests** (+6 in `lib/gesture.test.ts`:
dead zone, linear ramp both edges, past-the-edge hold, corner, degenerate
geometry, integration-step identity), `tsc --noEmit` clean, `next build`
clean. Kyle's live drag test is owed: whether 56px feels like an edge and
900 px/s a brisk but controllable pace is a hand question no test suite
answers — both are one-line constant changes if the body disagrees.

**Run it:** check out `jarvis/webcam-hand-nav`, `./start.sh` (or
`./start.sh --lan`), open a board, click **Hand control** in the status row,
allow the camera. Camera access requires `localhost` or HTTPS — a plain LAN
IP will not get a permission prompt.
