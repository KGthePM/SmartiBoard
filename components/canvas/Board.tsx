'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { shouldRequest, type TriggerState } from '@/lib/ai/trigger';
import { emptyBoard, NODE_H, NODE_W, parseBoard, type Board, type NodeId } from '@/lib/graph';
import { rejectedFor, useBoard } from '@/lib/store';
import { BoardChrome } from '../BoardChrome';
import { EdgeLayer } from './EdgeLayer';
import { GhostCard } from './GhostCard';
import { NodeCard } from './NodeCard';

const AUTOSAVE_MS = 700;
const TRIGGER_TICK_MS = 1000;

type Drag =
  | { kind: 'pan'; startX: number; startY: number; originX: number; originY: number }
  | { kind: 'node'; id: NodeId; dx: number; dy: number }
  | { kind: 'resize'; id: NodeId; startW: number; startH: number; startX: number; startY: number }
  | { kind: 'connect'; from: NodeId; to: { x: number; y: number } }
  | null;

export function Board({ boardId }: { boardId: string }) {
  const store = useBoard();
  const {
    board,
    proposal,
    suggesting,
    viewport,
    selectedId,
    selectedEdgeId,
    loaded,
    lastMutationAt,
    lastRequestedFingerprint,
  } = store;

  const surfaceRef = useRef<HTMLDivElement>(null);
  const savedRef = useRef<string>('');
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

  /* ---------- load ---------- */

  useEffect(() => {
    let cancelled = false;
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

    const t = setTimeout(() => {
      savedRef.current = payload;
      void fetch(`/api/boards/${boardId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: payload,
      }).catch(() => {
        // Retry on the next mutation rather than surfacing a save error;
        // the local board stays authoritative in the meantime.
        savedRef.current = '';
      });
    }, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [board, boardId, loaded]);

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
    } else if (drag.kind === 'node') {
      const p = toBoardCoords(e.clientX, e.clientY);
      store.moveNode(drag.id, p.x - drag.dx, p.y - drag.dy);
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
      if (typing) return;
      if ((e.key === 'Backspace' || e.key === 'Delete') && selectedId) {
        e.preventDefault();
        useBoard.getState().deleteNode(selectedId);
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && selectedEdgeId) {
        e.preventDefault();
        useBoard.getState().deleteEdge(selectedEdgeId);
      }
      if (e.key === 'Escape') {
        useBoard.getState().select(null);
        useBoard.getState().selectEdge(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, selectedEdgeId]);

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
                selected={selectedId === n.id}
                onSelect={() => store.select(n.id)}
                onChange={(text, format) => store.setNodeText(n.id, text, format)}
                onDragStart={(e) => {
                  const p = toBoardCoords(e.clientX, e.clientY);
                  setDrag({ kind: 'node', id: n.id, dx: p.x - n.x, dy: p.y - n.y });
                }}
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
                onDelete={() => {
                  lastDeleteAt.current = Date.now();
                  store.deleteNode(n.id);
                }}
              />
            </div>
          ))}

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

      <div className="hint">
        Double-click to add an idea · drag the dot to connect · drag a corner to resize · click a
        line to select it · ⌘Z to undo
      </div>

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
        {suggesting ? <span>thinking…</span> : null}
        <span>{board.nodes.length} ideas</span>
      </div>
    </>
  );
}

/** Exactly what gets PUT, and therefore what "already saved" is compared against. */
function savePayload(board: Board): string {
  return JSON.stringify({ title: board.title, nodes: board.nodes, edges: board.edges });
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
