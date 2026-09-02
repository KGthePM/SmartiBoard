/**
 * The share link (v4.1).
 *
 * v4.0 made two clients on one board merge and see each other; this is the part
 * that makes the second client somebody else's. A share is a **capability**: it
 * names one board and authorises reaching it, and it authorises nothing about a
 * person — there is no login, no session and no account anywhere in this app,
 * and this release does not introduce the first one.
 *
 * ```
 * http://<address>:<port>/board/<id>#s=<token>
 * ```
 *
 * **The existing page route, not a new `/b/`.** The shorthand would buy nothing
 * but a second way to open one board.
 *
 * **The token rides in the fragment on purpose.** A fragment is never sent to a
 * server, so the capability stays out of access logs, out of `Referer` headers
 * and out of proxy history — which matters most in v4.2, where the same link
 * crosses somebody else's edge. The page reads it and sends it as a header;
 * ./shareToken is that one DOM line, kept next door so this module stays pure.
 *
 * Minting is server-side and lives in ./hub — a token is process memory that
 * dies with the process, which is v2.5's ruling (a network decision belongs to
 * the invocation, not the install) applied to the capability as well.
 *
 * Pure and node-free: the dialog, the route and the tests import the same
 * functions. Address enumeration needs `node:os` and therefore is *not* here.
 */

/** The fragment key. One letter, because it is typed by nobody and read by us. */
const KEY = 's';

/**
 * The link, built from an origin the caller already knows to be reachable.
 *
 * `origin` is a whole scheme-host-port (`http://192.168.1.20:3000`) rather than
 * pieces, because the route that offers a set of addresses is the only thing in
 * a position to know which of them are real, and it holds the port already.
 * A trailing slash is tolerated so a caller may pass `location.origin` or a
 * hand-written string without either being wrong.
 */
export function shareUrl(origin: string, boardId: string, token: string): string {
  const base = origin.replace(/\/+$/, '');
  return `${base}/board/${encodeURIComponent(boardId)}#${KEY}=${encodeURIComponent(token)}`;
}

/**
 * The token out of a `location.hash`, or null.
 *
 * `parseBoard`'s doctrine in miniature — **total and tolerant**: no fragment, a
 * bare `#`, junk, and a fragment carrying only other keys each answer null
 * rather than throw. A malformed link is somebody with no access, which the gate
 * already has an answer for; it is never a crash on the page that was going to
 * tell them so.
 *
 * Other keys are permitted around it so that a future fragment (a card anchor, a
 * view) does not silently invalidate every link already sent.
 */
export function parseShareToken(hash: string): string | null {
  if (typeof hash !== 'string') return null;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;

  for (const part of raw.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq) !== KEY) continue;
    // A token that fails to decode is a token that was never ours.
    let value: string;
    try {
      value = decodeURIComponent(part.slice(eq + 1));
    } catch {
      return null;
    }
    return value ? value : null;
  }
  return null;
}
