'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Sharing a board on the network (v4.1).
 *
 * The link is minted server-side and **dies with the host's process**, which is
 * v2.5's ruling — a network decision belongs to the invocation, not the install
 * — applied to the capability as well. So closing the app is the revocation
 * story, and the dialog says so rather than implying a link that outlives it.
 *
 * Local `useState` in the chrome rather than a store flag, following
 * `BoardSwitcher`: this is session UI, not board content. It spends nothing —
 * no undo snapshot, no `lastMutationAt` bump, not in the fingerprint, never a
 * token, and no model is involved anywhere in the feature.
 *
 * The shell is `TemplateLibrary`'s, unchanged: a backdrop that closes on
 * `onPointerDown`, an inner dialog that stops it, an × titled `Close (Esc)`,
 * and a window-level Escape listener.
 */

type ShareUrl = { label: string; url: string };
type ShareState = { sharing: boolean; token: string | null; gated: boolean; urls: ShareUrl[] };

export function ShareDialog({ boardId, onClose }: { boardId: string; onClose: () => void }) {
  const [state, setState] = useState<ShareState | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * One call for all three methods: each returns the same state, so the dialog
   * never has to reason about what it just did — it renders what it was told.
   */
  const call = useCallback(
    async (method: 'GET' | 'POST' | 'DELETE') => {
      setBusy(true);
      try {
        const res = await fetch(`/api/boards/${boardId}/share`, { method });
        setState(res.ok ? ((await res.json()) as ShareState) : null);
      } catch {
        setState(null);
      } finally {
        setBusy(false);
      }
    },
    [boardId],
  );

  useEffect(() => {
    void call('GET');
  }, [call]);

  const copy = (url: string) => {
    void navigator.clipboard?.writeText(url).then(
      () => setCopied(url),
      () => {
        /* A clipboard the browser refuses is why the link is also selectable. */
      },
    );
  };

  return (
    <div className="share-back" onPointerDown={onClose}>
      <div
        className="share"
        role="dialog"
        aria-label="Share this board"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="share-head">
          <span className="share-title">Share this board</span>
          <button className="share-x" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="share-body">
          {state === null ? (
            <p className="share-note">{busy ? 'Checking…' : 'Sharing is unavailable here.'}</p>
          ) : !state.sharing ? (
            <>
              <p className="share-lead">
                Anyone on your network who opens the link can edit this board with you, live.
              </p>
              <button className="share-go" disabled={busy} onClick={() => void call('POST')}>
                {busy ? 'Starting…' : 'Start sharing'}
              </button>
            </>
          ) : (
            <>
              <p className="share-lead">
                Send one of these. Which one works depends on how your teammate reaches this
                machine.
              </p>
              {state.urls.length === 0 ? (
                <p className="share-note">
                  This machine has no network address right now, so the link would reach only
                  itself. Join a network and reopen this.
                </p>
              ) : (
                <ul className="share-urls">
                  {state.urls.map((u) => (
                    <li key={u.url}>
                      <span className="share-url-label">{u.label}</span>
                      {/* Selectable as well as copyable: a clipboard the browser
                          refuses must not be the only way to get the link out. */}
                      <input className="share-url" readOnly value={u.url} onFocus={(e) => e.currentTarget.select()} />
                      <button className="share-copy" onClick={() => copy(u.url)}>
                        {copied === u.url ? 'Copied' : 'Copy'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button className="share-stop" disabled={busy} onClick={() => void call('DELETE')}>
                {busy ? 'Stopping…' : 'Stop sharing'}
              </button>
            </>
          )}

          {/* The three things that are true the moment you press the button, and
              therefore belong here rather than in the README. */}
          {state?.sharing ? (
            <div className="share-caveats">
              <p>The link stops working when you close Smarti Board. Nothing is stored.</p>
              <p>It reaches this board and nothing else — not your other boards, not your settings.</p>
              <p>
                Whoever you share with can use the AI on this board, which spends your model
                provider key. Turn on Private to stop that.
              </p>
              {state.gated ? null : (
                <p className="share-warn">
                  You started this with <code>--lan</code>, so every board on this machine is
                  already reachable by anyone on the network. Here the link is a shortcut to this
                  board, not a limit on what they can see.
                </p>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
