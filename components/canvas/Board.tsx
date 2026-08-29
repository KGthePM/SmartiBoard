'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { shouldRequest, type TriggerState } from '@/lib/ai/trigger';
import {
  emptyBoard,
  NODE_H,
  NODE_W,
  nodesInRect,
  parseBoard,
  type Board,
  type NodeId,
  type Rect,
} from '@/lib/graph';
import { rejectedFor, useBoard } from '@/lib/store';
import { BoardChrome } from '../BoardChrome';
import { EdgeLayer } from './EdgeLayer';
import { GhostCard } from './GhostCard';
import { NodeCard } from './NodeCard';

const AUTOSAVE_MS = 700;
/** How often a failed save retries itself while the indicator shows error. */
const SAVE_RETRY_MS = 5000;
const TRIGGER_TICK_MS = 1000;

type Drag =
  | { kind: 'pan'; startX: number; startY: number; originX: number; originY: number }
  | {
      kind: 'nodes';
      /** The carried set, each with its origin at grab time. */
      items: { id: NodeId; ox: number; oy: number }[];
      /** Pointer offset from the grabbed card, in board coords. */
      dx: number;
      dy: number;
      /** The grabbed card's origin — the set keeps its shape around it. */
      gx: number;
      gy: number;
      /** Client-pixel anchor for the click-vs-drag rule. */
      startX: number;
      startY: number;
      /** Crossed once the pointer carried beyond a click's worth of jitter. */
      moved: boolean;
      /** A click that never moved collapses a multi-selection to this card. */
      collapseTo: NodeId | null;
    }
  | { kind: 'resize'; id: NodeId; startW: number; startH: number; startX: number; startY: number }
  | { kind: 'connect'; from: NodeId; to: { x: number; y: number } }
  /** Shift+drag on empty canvas: the marquee sweep. */
  | { kind: 'marquee'; ax: number; ay: number; cx: number; cy: number }
  | null;

export function Board({ boardId }: { boardId: string }) {
  const store = useBoard();
  const {
    board,
    proposal,
    suggesting,
    viewport,
    selectedIds,
    selectedEdgeId,
    loaded,
    lastMutationAt,
    lastRequestedFingerprint,
  } = store;

  const surfaceRef = useRef<HTMLDivElement>(null);
  const savedRef = useRef<string>('');
  // Monotonic id for each PUT we send. A response landing after a newer save
  // has gone out must not mark the board saved — or failed — on its own behalf.
  const saveSeqRef = useRef(0);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  // Exists only to re-arm the autosave effect while a save is failing; a
  // board whose author stopped typing still deserves to recover on its own.
  const [retryNonce, setRetryNonce] = useState(0);
  const [drag, setDrag] = useState<Drag>(null);
  // Deleting via the × unmounts the card mid-double-click, which can land the
  // second click on the canvas; suppress node creation briefly after a delete.
  const lastDeleteAt = useRef(0);

  const toBoardCoords = useCallback(
    (clientX: number, clientY: number) => {
      const rect = surfaceRef.current?.getBoundingClientRect();
      const left = rect?.left ?? 0;
      const top = rect?.top ?? 0;
      return {
        x: (clientX - left - viewport.x) / viewport.scale,
        y: (clientY - top - viewport.y) / viewport.scale,
      };
    },
    [viewport],
  );

  /* ---------- surface size: placement needs to know what's on screen ---------- */

  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const sync = () => {
      const r = el.getBoundingClientRect();
      useBoard.getState().setSurface({ w: r.width, h: r.height });
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ---------- leaving a board: its pending edits leave as a write ---------- */

  // Both exits from the canvas — switching boards (the load effect below) and
  // unmounting it (navigating to the index) — destroy the debounce timer with
  // the effect cleanup, and an edit from the last AUTOSAVE_MS would die with
  // it. This is the same PUT the autosave would have made, fired unsupervised:
  // by the time it settles there is no board on screen to report its fate to.
  const flushUnsaved = () => {
    const s = useBoard.getState();
    if (!s.loaded) return;
    const payload = savePayload(s.board);
    if (payload === savedRef.current) return;
    savedRef.current = payload;
    // Supersedes anything in flight, so its late response touches nothing.
    saveSeqRef.current++;
    void fetch(`/api/boards/${s.board.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: payload,
    }).catch(() => {
      /* Unsupervised by design — see above. */
    });
  };

  /* ---------- load ---------- */

  useEffect(() => {
    let cancelled = false;
    flushUnsaved();
    // Point the store at the new board before anything can fire against it,
    // and forget what the last board had saved — savedRef is a component ref
    // and a board switch does not remount this component.
    useBoard.getState().beginLoad(boardId);
    savedRef.current = '';

    const arrive = (b: Board) => {
      if (cancelled) return;
      useBoard.getState().hydrate(b);
      // Seed the autosave with what we just read, so opening a board is not
      // itself a write. Without this, every visit rewrites the row (churning
      // updated_at), and a failed load would write its empty fallback over
      // real content.
      savedRef.current = savePayload(b);
      // The indicator starts each board honest, whatever the last one showed.
      saveSeqRef.current++;
      setSaveState('saved');
    };

    fetch(`/api/boards/${boardId}`)
      .then((r) => r.json())
      .then((b) => arrive(parseBoard(boardId, b)))
      .catch(() => arrive(emptyBoard(boardId)));
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  /* ---------- autosave: no save button, ever ---------- */

  useEffect(() => {
    // board.id lags boardId for one render on a switch; writing then would put
    // the outgoing board's content under the incoming board's id.
    if (!loaded || board.id !== boardId) return;
    const payload = savePayload(board);
    if (payload === savedRef.current) return;

    // Dirty: the change exists only in this tab until a PUT lands, and the
    // indicator says so for the debounce and the flight alike.
    setSaveState('saving');
    const t = setTimeout(() => {
      const mine = ++saveSeqRef.current;
      savedRef.current = payload;
      void fetch(`/api/boards/${boardId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: payload,
      })
        .then((r) => {
          if (mine !== saveSeqRef.current) return;
          // A non-2xx wrote nothing — the row never changed — so it takes
          // the failure path rather than counting as a save.
          if (!r.ok) throw new Error(`save failed: ${r.status}`);
          setSaveState('saved');
        })
        .catch(() => {
          if (mine !== saveSeqRef.current) return;
          // The local board stays authoritative; savedRef reset makes the
          // next mutation (or the retry tick below) resend the whole board.
          savedRef.current = '';
          setSaveState('error');
        });
    }, AUTOSAVE_MS);
    return () => clearTimeout(t);
    // retryNonce re-arms this effect after a failure, without any edit.
  }, [board, boardId, loaded, retryNonce]);

  // A failed save recovers on its own: waiting for the next edit would strand
  // every board whose author stopped typing the moment it failed. While in
  // error, wake the autosave effect every SAVE_RETRY_MS — savedRef is '' in
  // that state, so it always finds the board dirty and resends.
  useEffect(() => {
    if (saveState !== 'error') return;
    const t = setTimeout(() => setRetryNonce((n) => n + 1), SAVE_RETRY_MS);
    return () => clearTimeout(t);
  }, [saveState, retryNonce]);

  // The other exit flushUnsaved covers: leaving the app unmounts the canvas
  // without ever switching boards. StrictMode's simulated unmount is a no-op —
  // a freshly mounted board has nothing unsaved to flush.
  useEffect(() => () => flushUnsaved(), []);

  // The guard rail the indicator implies: closing the tab while a save is
  // pending or failing would drop exactly the changes it says are not yet
  // durable. The browser's native prompt is the whole interaction.
  useEffect(() => {
    if (saveState === 'saved') return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [saveState]);

  /* ---------- the suggest loop ----------
   * Runs on its own timer, entirely off the interaction path. Nothing here is
   * awaited by drag, typing, or panning — the only thing the canvas reads back
   * is `suggesting`, and that drives one small status line.
   */

  useEffect(() => {
    if (!loaded) return;

    const tick = () => {
      const s = useBoard.getState();
      const state: TriggerState = {
        lastMutationAt: s.lastMutationAt,
        lastRequestedFingerprint: s.lastRequestedFingerprint,
        liveProposals: s.proposal ? 1 : 0,
        inFlight: s.suggesting,
        failedAt: s.suggestFailedAt,
      };

      const decision = shouldRequest(s.board, state, Date.now());
      if (!decision.fire) return;

      s.markRequested(decision.fingerprint);
      s.setSuggesting(true);

      void fetch(`/api/boards/${s.board.id}/suggest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ board: s.board, rejected: rejectedFor(s) }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data?.proposal) {
            useBoard.getState().receiveProposal(data.proposal);
          } else if (data?.reason === 'upstream_error') {
            // Nothing was asked and nothing was answered, so this board is still
            // unasked. A plain null proposal is different: the model looked and
            // had nothing to add, and that answer holds until the board changes.
            useBoard.getState().failRequest();
          }
        })
        .catch(() => {
          /* Silence is the correct failure mode for an unsolicited suggestion. */
          useBoard.getState().failRequest();
        })
        .finally(() => useBoard.getState().setSuggesting(false));
    };

    const id = setInterval(tick, TRIGGER_TICK_MS);
    return () => clearInterval(id);
    // boardId is a dependency so the timer is torn down across a switch.
  }, [loaded, boardId]);

  /* ---------- pointer handling ---------- */

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    if (drag.kind === 'pan') {
      store.setViewport({
        ...viewport,
        x: drag.originX + (e.clientX - drag.startX),
        y: drag.originY + (e.clientY - drag.startY),
      });
    } else if (drag.kind === 'nodes') {
      const p = toBoardCoords(e.clientX, e.clientY);
      // The grabbed card tracks the pointer; the rest of the set keeps its
      // shape around it — one set() for the whole drag, every pointer event.
      const bx = p.x - drag.dx;
      const by = p.y - drag.dy;
      store.moveNodes(
        drag.items.map((it) => ({ id: it.id, x: bx + it.ox - drag.gx, y: by + it.oy - drag.gy })),
      );
      // The click-vs-drag rule: a few pixels of jitter is still a click.
      if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 3) {
        setDrag({ ...drag, moved: true });
      }
    } else if (drag.kind === 'marquee') {
      const p = toBoardCoords(e.clientX, e.clientY);
      setDrag({ ...drag, cx: p.x, cy: p.y });
    } else if (drag.kind === 'resize') {
      // Deltas are measured in client pixels, then divided by the live scale so
      // the corner tracks the pointer exactly at any zoom.
      const dx = (e.clientX - drag.startX) / viewport.scale;
      const dy = (e.clientY - drag.startY) / viewport.scale;
      store.resizeNode(drag.id, drag.startW + dx, drag.startH + dy);
    } else if (drag.kind === 'connect') {
      setDrag({ ...drag, to: toBoardCoords(e.clientX, e.clientY) });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (drag?.kind === 'connect') {
      const target = (e.target as HTMLElement).closest('[data-node-id]');
      const id = target?.getAttribute('data-node-id');
      if (id && id !== drag.from) store.connect(drag.from, id);
    } else if (drag?.kind === 'marquee') {
      // What the sweep touched is the selection; an empty sweep clears it —
      // the same thing a plain click on empty canvas has always done.
      store.selectMany(nodesInRect(board, marqueeRect(drag)));
    } else if (drag?.kind === 'nodes' && !drag.moved && drag.collapseTo) {
      // A click on a card inside a multi-selection collapses to it; a drag
      // carried the set, and the selection stands.
      store.select(drag.collapseTo);
    }
    setDrag(null);
  };

  const onWheel = (e: React.WheelEvent) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    const cx = e.clientX - (rect?.left ?? 0);
    const cy = e.clientY - (rect?.top ?? 0);
    const next = clamp(viewport.scale * (e.deltaY < 0 ? 1.08 : 1 / 1.08), 0.25, 2.5);
    // Zoom toward the cursor, not the origin.
    store.setViewport({
      scale: next,
      x: cx - ((cx - viewport.x) / viewport.scale) * next,
      y: cy - ((cy - viewport.y) / viewport.scale) * next,
    });
  };

  /* ---------- keyboard ---------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLElement &&
        (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT');

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        useBoard.getState().undo();
        return;
      }
      // Redo: ⌘⇧Z everywhere, ⌘Y as the Windows habit. Before the typing
      // guard like undo, so it reaches into a card's textarea too.
      if (
        ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && e.shiftKey) ||
        ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y')
      ) {
        e.preventDefault();
        useBoard.getState().redo();
        return;
      }
      if (typing) return;
      // The whole selection goes in one step — one action, one undo entry.
      if ((e.key === 'Backspace' || e.key === 'Delete') && selectedIds.length > 0) {
        e.preventDefault();
        useBoard.getState().deleteNodes(selectedIds);
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && selectedEdgeId) {
        e.preventDefault();
        useBoard.getState().deleteEdge(selectedEdgeId);
      }
      // D crosses the selected idea off, the way the ✓ does. Unmodified only:
      // ⌘D and friends belong to the browser. Deliberately single-card —
      // done is per-idea, so it fires only when one card is selected.
      if (
        e.key.toLowerCase() === 'd' &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        selectedIds.length === 1
      ) {
        e.preventDefault();
        useBoard.getState().toggleNodeDone(selectedIds[0]);
      }
      if (e.key === 'Escape') {
        useBoard.getState().select(null);
        useBoard.getState().selectEdge(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedIds, selectedEdgeId]);

  const pendingLine =
    drag?.kind === 'connect'
      ? (() => {
          const n = board.nodes.find((x) => x.id === drag.from);
          if (!n) return null;
          return { from: { x: n.x + n.w / 2, y: n.y + n.h / 2 }, to: drag.to };
        })()
      : null;

  return (
    <>
      <div
        ref={surfaceRef}
        className={`viewport ${drag?.kind === 'pan' ? 'panning' : ''}`}
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains('world'))
            return;
          if (e.shiftKey) {
            // Shift+drag on empty canvas is the marquee; the plain drag still
            // pans, exactly as it always has.
            const p = toBoardCoords(e.clientX, e.clientY);
            setDrag({ kind: 'marquee', ax: p.x, ay: p.y, cx: p.x, cy: p.y });
            return;
          }
          store.select(null);
          setDrag({
            kind: 'pan',
            startX: e.clientX,
            startY: e.clientY,
            originX: viewport.x,
            originY: viewport.y,
          });
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setDrag(null)}
        onWheel={onWheel}
        onDoubleClick={(e) => {
          if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains('world'))
            return;
          if (Date.now() - lastDeleteAt.current < 400) return;
          const p = toBoardCoords(e.clientX, e.clientY);
          store.addNode(Math.round(p.x - NODE_W / 2), Math.round(p.y - NODE_H / 2));
        }}
      >
        <div
          className="world"
          style={{
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
          }}
        >
          <EdgeLayer
            board={board}
            proposal={proposal}
            pending={pendingLine}
            selectedEdgeId={selectedEdgeId}
            onSelectEdge={(id) => store.selectEdge(id)}
            onDeleteEdge={(id) => {
              // Same guard as the node ×: removing the line mid-click must not
              // turn the next click into a new node.
              lastDeleteAt.current = Date.now();
              store.deleteEdge(id);
            }}
          />

          {board.nodes.map((n) => (
            <div key={n.id} data-node-id={n.id} style={{ position: 'absolute' }}>
              <NodeCard
                node={n}
                selected={selectedIds.includes(n.id)}
                sole={selectedIds.length === 1 && selectedIds[0] === n.id}
                onCardDown={(e) => {
                  // Shift+click is a membership toggle, not a drag: the
                  // selection is being built, and a stray move must not carry
                  // cards with it.
                  if (e.shiftKey) {
                    store.toggleSelect(n.id);
                    return;
                  }
                  const inSelection = selectedIds.includes(n.id);
                  // A plain click on a card outside the selection collapses to
                  // it, exactly as selection has always worked; inside one, the
                  // drag carries the whole set.
                  if (!inSelection) store.select(n.id);
                  const carry = inSelection
                    ? board.nodes.filter((x) => selectedIds.includes(x.id))
                    : [n];
                  const p = toBoardCoords(e.clientX, e.clientY);
                  setDrag({
                    kind: 'nodes',
                    items: carry.map((x) => ({ id: x.id, ox: x.x, oy: x.y })),
                    dx: p.x - n.x,
                    dy: p.y - n.y,
                    gx: n.x,
                    gy: n.y,
                    startX: e.clientX,
                    startY: e.clientY,
                    moved: false,
                    // Only a multi-selection needs the click-vs-drag rule; a
                    // lone card already collapsed above.
                    collapseTo: inSelection && carry.length > 1 ? n.id : null,
                  });
                }}
                onEdit={() => store.select(n.id)}
                onChange={(text, format) => store.setNodeText(n.id, text, format)}
                onPortDown={(e) => {
                  setDrag({ kind: 'connect', from: n.id, to: toBoardCoords(e.clientX, e.clientY) });
                }}
                onResizeStart={(e) => {
                  setDrag({
                    kind: 'resize',
                    id: n.id,
                    startW: n.w,
                    startH: n.h,
                    startX: e.clientX,
                    startY: e.clientY,
                  });
                }}
                onAdjustFont={(dir) => store.adjustNodeFontSize(n.id, dir)}
                onToggleDone={() => store.toggleNodeDone(n.id)}
                onDelete={() => {
                  lastDeleteAt.current = Date.now();
                  store.deleteNode(n.id);
                }}
              />
            </div>
          ))}

          {drag?.kind === 'marquee' ? (
            (() => {
              const r = marqueeRect(drag);
              return (
                <div
                  className="marquee"
                  style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
                />
              );
            })()
          ) : null}

          {proposal ? (
            <GhostCard
              proposal={proposal}
              onAccept={() => store.acceptProposal()}
              onDismiss={() => store.dismissProposal()}
            />
          ) : null}
        </div>
      </div>

      <BoardChrome />

      <div className="legend">
        <span>
          <i className="l-user" />
          yours
        </span>
        <span>
          <i className="l-ghost" />
          suggested
        </span>
        <span>
          <i className="l-accepted" />
          accepted
        </span>
      </div>

      <div className="status">
        {/* First in the row because save state outranks a suggestion: it is
            the answer to "is my work safe?" */}
        <span className={saveState === 'error' ? 'save-error' : undefined}>
          {saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Not saved — retrying…' : 'Saved'}
        </span>
        {suggesting ? <span>thinking…</span> : null}
        <span>{board.nodes.length} ideas</span>
      </div>
    </>
  );
}

/**
 * Exactly what gets PUT, and therefore what "already saved" is compared against.
 * A PUT is a full replace validated only by parseBoard, so a field missing here
 * is not merely unsaved — it is erased on the next autosave.
 */
function savePayload(board: Board): string {
  return JSON.stringify({
    title: board.title,
    objective: board.objective,
    privacy: board.privacy,
    nodes: board.nodes,
    edges: board.edges,
  });
}

/** The swept rectangle, whichever way the pointer dragged it. */
function marqueeRect(d: { ax: number; ay: number; cx: number; cy: number }): Rect {
  return {
    x: Math.min(d.ax, d.cx),
    y: Math.min(d.ay, d.cy),
    w: Math.abs(d.cx - d.ax),
    h: Math.abs(d.cy - d.ay),
  };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
