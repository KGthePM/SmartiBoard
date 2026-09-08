'use client';

import { useEffect, useRef, useState } from 'react';
import type { HandLandmarker } from '@mediapipe/tasks-vision';
import {
  OneEuro,
  PinchDetector,
  mapToSurface,
  panViewport,
  pinchState,
  type DragStart,
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

const JARVIS_BTN = 'jarvis-toggle';

export function statusLabel(s: JarvisStatus): string {
  return {
    off: 'Hand control',
    loading: 'Loading Jarvis…',
    asking: 'Allow the camera…',
    running: 'Hand control ON — pinch & move to pan',
    denied: 'Camera unavailable — check permissions',
    error: 'Jarvis failed to start',
  }[s];
}

export function useHandNav(
  active: boolean,
  surfaceRef: React.RefObject<HTMLElement | null>,
  getViewport: () => Viewport,
  setViewport: (v: Viewport) => void,
) {
  const [status, setStatus] = useState<JarvisStatus>('off');
  const cleanupRef = useRef<(() => void) | null>(null);

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
          numHands: 1,
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
        let drag: DragStart | null = null;
        let lastVideoTime = -1;
        let raf = 0;

        const surfaceBox = () => surfaceRef.current?.getBoundingClientRect();

        const tick = () => {
          raf = requestAnimationFrame(tick);
          if (video.readyState < 2 || video.currentTime === lastVideoTime) return;
          lastVideoTime = video.currentTime;

          const result = landmarker.detectForVideo(video, performance.now());
          const hand = result.landmarks?.[0];
          const box = surfaceBox();
          if (!hand || !box) {
            drag = null;
            return;
          }

          // Index tip (8) drives the cursor; wrist (0) and middle MCP (9)
          // size the hand for the pinch ratio.
          const t = performance.now();
          const raw = { x: hand[8].x, y: hand[8].y };
          const smoothed = filter.filter(raw, t);
          const cursor = mapToSurface(smoothed, { w: box.width, h: box.height });

          const ratio = pinchState({
            thumb: { x: hand[4].x, y: hand[4].y },
            index: { x: hand[8].x, y: hand[8].y },
            wrist: { x: hand[0].x, y: hand[0].y },
            middleMcp: { x: hand[9].x, y: hand[9].y },
          });
          const pinching = pinch.update(ratio);

          if (pinching) {
            if (!drag) drag = { at: cursor, viewport: getViewport() };
            setViewport(panViewport(drag, cursor));
          } else {
            drag = null;
          }
        };

        raf = requestAnimationFrame(tick);

        stop = () => {
          cancelAnimationFrame(raf);
          stream.getTracks().forEach((t) => t.stop());
          video.pause();
          video.srcObject = null;
          landmarker.close();
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
    };
  }, [active, surfaceRef, getViewport, setViewport]);

  return status;
}
