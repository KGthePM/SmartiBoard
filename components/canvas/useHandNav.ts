'use client';

import { useEffect, useRef, useState } from 'react';
import type { HandLandmarker } from '@mediapipe/tasks-vision';
import {
  HandPresence,
  OneEuro,
  PinchDetector,
  TwoHandZoom,
  edgeFactor,
  mapToSurface,
  panViewport,
  pinchState,
  twoHandZoomViewport,
  type DragStart,
  type ZoomStart,
} from '@/lib/hand';
import type { Viewport } from '@/lib/graph';

/**
 * Project Jarvis: the webcam loop.
 *
 * Camera + inference + dispatch, and nothing else — every decision lives in
 * `lib/hand.ts` so the rules stay testable. The loop writes through
 * `store.setViewport`, the same seam the wheel and the touch pinch use; it
 * never touches React state (a 30Hz reconciliation would thrash the canvas)
 * and never the undo stack (a viewport is not content).
 *
 * Two hands are tracked (phase 4): one pinched hand pans; BOTH pinched is
 * zoom, and the `TwoHandZoom` machine in `lib/hand.ts` owns that mode —
 * hand identity, entry baseline, per-frame rate limit, exit cooldown.
 *
 * Nothing here runs until the user asks for the camera, and closing the
 * overlay stops the tracks and the landmarker — the camera is never on
 * in the background.
 */

export type JarvisStatus =
  | 'off'
  | 'loading' // model + wasm loading
  | 'asking' // awaiting camera permission
  | 'running'
  | 'denied' // permission refused or no camera
  | 'error';

/** What the loop tells the cursor overlay, per frame, through a ref. */
export type HandCursorFrame = {
  /** Cursor position in surface pixels (already filtered and mapped). */
  x: number;
  y: number;
  /** Pinch is ON — the pan gesture is armed or dragging. */
  pinching: boolean;
  /** A hand was seen within the lost-hand grace window. */
  present: boolean;
  /**
   * How deep in the camera frame the hand sits, 0 at an edge to 1 in — the
   * RAW landmark's distance from the frame edge, before any mapping, so the
   * cursor can dim as tracking is about to drop (Ultraleap's affordance).
   */
  edge: number;
  /** Two-hand zoom mode is active — the ring and the pill both say so. */
  zoom: boolean;
};

const JARVIS_BTN = 'jarvis-toggle';

export function statusLabel(s: JarvisStatus, tracking: boolean, zooming = false): string {
  if (s !== 'running') {
    return {
      off: 'Hand control',
      loading: 'Loading Jarvis…',
      asking: 'Allow the camera…',
      denied: 'Camera unavailable — check permissions',
      error: 'Jarvis failed to start',
    }[s as Exclude<JarvisStatus, 'running'>];
  }
  if (zooming) return 'Hand control ON — zoom: spread hands to zoom, release to stop';
  // Rare React state, by design: the pill may say "show your hand" for a
  // while, and only the flip is newsworthy — never the hand's position.
  return tracking
    ? 'Hand control ON — pinch & move to pan'
    : 'Hand control ON — show your hand to the camera';
}

export function useHandNav(
  active: boolean,
  surfaceRef: React.RefObject<HTMLElement | null>,
  getViewport: () => Viewport,
  setViewport: (v: Viewport) => void,
  cursorRef?: React.RefObject<HandCursorFrame | null>,
  jarvisGain?: number,
) {
  const [status, setStatus] = useState<JarvisStatus>('off');
  // Rare state, deliberately: the status pill reads it, and it changes only
  // when a hand appears or stays gone past the grace window — not per frame.
  const [tracking, setTracking] = useState(false);
  // Same rarity contract, phase 4: only the zoom-mode FLIP is newsworthy.
  const [zooming, setZooming] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  // Latest-value refs: the loop reads this render's functions without the
  // effect depending on them. Inline arrows from the caller are new objects
  // every render — deps on them would tear the camera down and re-request it
  // on every board re-render (autosave flips, ghost ticks), which reads to
  // the user as the webcam disconnecting in a loop. `jarvisGain` rides the
  // same rail (phase 3): the sensitivity setting lands live, within a tick,
  // without ever re-arming the effect.
  const getViewRef = useRef(getViewport);
  const setViewRef = useRef(setViewport);
  const gainRef = useRef(jarvisGain);
  getViewRef.current = getViewport;
  setViewRef.current = setViewport;
  gainRef.current = jarvisGain;

  useEffect(() => {
    if (!active) return;
    let dead = false;
    let stop: (() => void) | null = null;

    (async () => {
      try {
        setStatus('loading');
        // Lazy-import: ~37MB unpacked stays out of the bundle until asked.
        const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
        const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
        const landmarker = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: '/mediapipe/models/hand_landmarker.task',
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numHands: 2,
        });
        if (dead) {
          landmarker.close();
          return;
        }

        setStatus('asking');
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480 },
          });
        } catch {
          landmarker.close();
          setStatus('denied');
          return;
        }
        if (dead) {
          stream.getTracks().forEach((t) => t.stop());
          landmarker.close();
          return;
        }

        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        await video.play();

        const filter = new OneEuro(1.0, 0.05, 1.0);
        const pinch = new PinchDetector();
        const presence = new HandPresence();
        const zoomer = new TwoHandZoom();
        let drag: DragStart | null = null;
        let zoomDrag: ZoomStart | null = null;
        let lastVideoTime = -1;
        let raf = 0;
        let trackingNow = false;
        let zoomingNow = false;

        const surfaceBox = () => surfaceRef.current?.getBoundingClientRect();

        const tick = () => {
          raf = requestAnimationFrame(tick);
          if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
          lastVideoTime = video.currentTime;

          const t = performance.now();
          const result = landmarker.detectForVideo(video, t);
          const landmarks = result.landmarks ?? [];
          const box = surfaceBox();
          // Aspect correction (phase 4): MediaPipe normalizes x by frame
          // width and y by height — without this a 16:9 horizontal spread
          // reads ~1.8× the same spread done vertically.
          const aspect = video.videoWidth > 0 && video.videoHeight > 0
            ? video.videoWidth / video.videoHeight
            : 4 / 3;

          if (landmarks.length > 0 && box) {
            presence.mark(t);
            // Up to two hands, each observed as a pinch midpoint plus raw
            // ratio. The TwoHandZoom machine matches them across frames (the
            // landmarker's array order is not an identity), runs the pinch
            // hysteresis per slot, and owns the zoom mode/baseline.
            const observations = landmarks.slice(0, 2).map((hand) => {
              const thumb = { x: hand[4].x, y: hand[4].y };
              const index = { x: hand[8].x, y: hand[8].y };
              return {
                mid: { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 },
                ratio: pinchState({
                  thumb,
                  index,
                  wrist: { x: hand[0].x, y: hand[0].y },
                  middleMcp: { x: hand[9].x, y: hand[9].y },
                }),
              };
            });
            const two = zoomer.update(observations, aspect, t);

            // The cursor hand is whichever observation matched slot 0 — the
            // hand the user thinks of as "the" hand, whichever array order
            // it came back in. If slot 0's hand is gone, the visible one
            // serves so the cursor never freezes on a vanished hand.
            let obsIdx = two.map.indexOf(0);
            if (obsIdx === -1) obsIdx = 0;
            const hand = landmarks[obsIdx];
            const cursorSlot = two.map[obsIdx] ?? -1;

            // Index tip (8) drives the cursor; wrist (0) and middle MCP (9)
            // size the hand for the pinch ratio. The RAW point also feeds
            // the edge factor — distance from the frame edge is a camera-
            // frame question, not a surface one, so it is answered before
            // any mapping.
            const raw = { x: hand[8].x, y: hand[8].y };
            const smoothed = filter.filter(raw, t);
            const cursor = mapToSurface(smoothed, { w: box.width, h: box.height }, gainRef.current ?? 1.6);
            const edge = edgeFactor(raw);
            const panPinch =
              cursorSlot >= 0 && two.slots[cursorSlot].seen
                ? two.slots[cursorSlot].pinching
                : pinch.update(observations[obsIdx].ratio);

            if (two.mode === 'zoom' && two.zoom) {
              // Zoom owns the gesture: pan is fully suppressed, and the
              // viewport rides the baseline-relative ratio anchored at the
              // entry midpoint — mirror of the touch pinch's joint
              // zoom-and-pan. The midpoint maps to surface coords exactly
              // like the pan cursor (mirror, margin, gain).
              if (!zoomDrag) {
                zoomDrag = {
                  viewport: getViewRef.current(),
                  mid: mapToSurface(two.zoom.mid, { w: box.width, h: box.height }, gainRef.current ?? 1.6),
                };
              }
              setViewRef.current(
                twoHandZoomViewport(zoomDrag, {
                  ratio: two.zoom.ratio,
                  mid: mapToSurface(two.zoom.mid, { w: box.width, h: box.height }, gainRef.current ?? 1.6),
                }),
              );
              drag = null;
            } else if (panPinch && !two.panBlocked) {
              if (!drag) drag = { at: cursor, viewport: getViewRef.current() };
              setViewRef.current(panViewport(drag, cursor));
              zoomDrag = null;
            } else {
              // Open hands, or the post-zoom cooldown holding pan off.
              drag = null;
              zoomDrag = null;
            }

            if (cursorRef) {
              cursorRef.current = {
                x: cursor.x,
                y: cursor.y,
                pinching: panPinch,
                present: true,
                edge,
                zoom: two.mode === 'zoom',
              };
            }
            if (two.mode === 'zoom' !== zoomingNow) {
              zoomingNow = two.mode === 'zoom';
              setZooming(zoomingNow);
            }
          } else {
            // Lost frame: the drag holds for the grace window instead of
            // ending instantly, and the cursor overlay fades rather than
            // blinking. Past the grace the pan really ends, the filter
            // resets, and the zoom machine is told hands are gone — which
            // ends zoom and forces the next entry to re-baseline.
            if (!presence.present(t)) {
              drag = null;
              zoomDrag = null;
              filter.reset();
              zoomer.update([], aspect, t);
              if (zoomingNow) {
                zoomingNow = false;
                setZooming(false);
              }
            }
            if (cursorRef) {
              const prev = cursorRef.current;
              cursorRef.current = {
                x: prev?.x ?? 0,
                y: prev?.y ?? 0,
                pinching: false,
                present: presence.present(t),
                edge: prev?.edge ?? 0,
                zoom: false,
              };
            }
          }

          const nowTracking = presence.present(t);
          if (nowTracking !== trackingNow) {
            trackingNow = nowTracking;
            setTracking(nowTracking);
          }
        };

        raf = requestAnimationFrame(tick);

        stop = () => {
          cancelAnimationFrame(raf);
          stream.getTracks().forEach((t) => t.stop());
          video.pause();
          video.srcObject = null;
          landmarker.close();
          if (cursorRef) cursorRef.current = null;
        };
        cleanupRef.current = stop;
        setStatus('running');
      } catch (err) {
        if (!dead) {
          console.error('Jarvis init failed:', err);
          setStatus('error');
        }
      }
    })();

    return () => {
      dead = true;
      stop?.();
      cleanupRef.current = null;
      setTracking(false);
      setZooming(false);
      setStatus('off');
    };
  }, [active]);

  return { status, tracking, zooming };
}
