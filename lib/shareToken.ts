/**
 * The share token, client-side (v4.1). The DOM half of ./share, kept in its own
 * module so that one stays pure and node-free — the house split, the same one
 * ./download makes against ./transfer. The parsing is tested next door; the two
 * lines that touch `location` and `fetch` are not.
 *
 * The token arrives in the URL fragment, which is never sent to a server, so the
 * page is the first thing that ever sees it and a header is how it travels from
 * here. That is also why the whole app reads the stream with `fetch` and a reader
 * rather than `EventSource`: `EventSource` cannot set a header, and the
 * alternative is the token in a query string, which is the one place it must
 * never be.
 */

import { parseShareToken } from './share';

/**
 * Read once and remembered.
 *
 * **Not React state and not a prop.** `useSync`'s `handle()` is memoized on
 * `[boardId]` alone and its stream effect on `[boardId, loaded, handle]`,
 * precisely so a keystroke cannot reopen the stream; a fresh object in a
 * dependency array would undo that. A module read is stable by construction.
 *
 * The fragment is deliberately left in the address bar rather than stripped:
 * stripping it would make a reload — or a bookmark — lose access to the board
 * the person is looking at, and a fragment reaches no server or log to be
 * cleaned out of.
 */
let token: string | null | undefined;

export function shareToken(): string | null {
  if (token === undefined) {
    token = typeof window === 'undefined' ? null : parseShareToken(window.location.hash);
  }
  return token;
}

/**
 * Whether this page is somebody else's board.
 *
 * Used to remove the chrome a share token cannot reach — Home, the ⌘K switcher,
 * Settings, Export — **and their keyboard shortcuts with it**, because a control
 * you cannot see but that still fires is the v2.6 reachability rule inverted.
 */
export function isGuest(): boolean {
  return shareToken() !== null;
}

/**
 * Every API call the canvas makes. Adds the token when there is one and is
 * otherwise `fetch`, unchanged.
 *
 * Nothing in v4.1 forces this consolidation — a guest is on the host's own
 * origin, so every call is same-origin and would work without it. v4.3's
 * "Shared with me" is what forces it, when the guest's *installed* app has to
 * prefix a remote origin onto the same seven call sites. Doing it now makes that
 * release one line inside this function instead of the same threading exercise
 * repeated across three files.
 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const t = shareToken();
  if (!t) return fetch(path, init);
  return fetch(path, {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), 'x-smarti-share': t },
  });
}
