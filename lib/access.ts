/**
 * Who is calling, and what they may reach (v4.1).
 *
 * v2.5 ruled that `--lan` **is** the entire security model: the app has no login,
 * no session, no cookie and no per-user scoping, so binding wide hands the whole
 * library to whoever can reach the port, and the operator decides that per run.
 * A shareable link inverts that assumption — it is the first thing in the app
 * that must reach *some* of it — and the answer is deliberately not auth. The
 * token authorises a **board**, never a person, so there is still no identity
 * concept anywhere in this codebase.
 *
 * ## What makes a request `local`
 *
 * `collaboration-plan.md` drafted this as reading the peer address. **Next's App
 * Router does not expose the socket**, and the `Host` header is not a substitute:
 * a peer on the LAN can send `Host: localhost`, and read naively that inverts the
 * strictest tier into the most permissive one — the same shape of mistake as the
 * `CF-Connecting-IP` trap below, one release earlier than expected.
 *
 * So `local` is not something a request *looks like*. It is something it must
 * **prove**, and the proof is a per-run secret only the host's own UI carries:
 *
 * 1. `CF-Connecting-IP` / `CF-Ray` present → never `local`, never `trusted`.
 * 2. `x-smarti-local` matches `SMARTI_LOCAL_SECRET` → `local`.
 * 3. the server is not bound wide → `local`.
 * 4. `SMARTI_TRUST_LAN` is set → `trusted`.
 * 5. `x-smarti-share` resolves to this board → `{ share }`.
 * 6. otherwise → `denied`.
 *
 * **Rule 3 is why a clone-and-run install sees no change of any kind.** The npm
 * scripts pin `-H ${SMARTI_HOST:-127.0.0.1}`, so on a loopback-bound server
 * nothing non-local can arrive at all: the operating system is the boundary, and
 * no header has to be believed to say so.
 *
 * **Rule 4 is why v2.5 survives bit-for-bit.** `start.sh --lan` now also exports
 * `SMARTI_TRUST_LAN=1`, and a trusted caller reaches everything, exactly as it
 * has since that release — including the warning block that says so in words.
 *
 * **Rule 2 exists in exactly one place**: the desktop, which binds wide from
 * launch (a listening server cannot rebind, so widening on demand would mean a
 * new port and a reload mid-collaboration) and hands its own `BrowserWindow` a
 * `randomUUID` that no machine on the LAN can guess.
 *
 * **Rule 1 belongs to v4.2 and is landed here with its test**, because it is
 * cheaper to write while this file is being born than to remember later under a
 * feature. `cloudflared` runs *on the host* and dials loopback, so every tunneled
 * request would otherwise arrive looking local — a tunnel would not weaken the
 * strictest tier, it would invert it into the most permissive one for the whole
 * internet. It fails safe: a local caller could forge those headers, but that
 * only downgrades access it already holds, while a remote caller cannot strip
 * them.
 *
 * ## The consequence, stated rather than papered over
 *
 * The gate bites in one configuration only — bound wide *without*
 * `SMARTI_TRUST_LAN` — and that is the desktop's share mode. On the web install
 * you cannot be reached without `--lan`, and `--lan` hands over everything by
 * design, so there the token puts a guest on the right board and is not a
 * boundary. The Share dialog says so.
 *
 * `decideAccess` is pure and node-free and takes every input as an argument, so
 * the refusal matrix is a table of `Headers` and never touches `process.env` or
 * the hub. `accessFor` is the one impure line — the split is ./ai/providers
 * against ./ai/config, applied again.
 */

import { boardForShare } from './hub';

export type Access = 'local' | 'trusted' | { share: string } | 'denied';

/** Only the four variables the decision reads. Everything else is a distraction. */
export type AccessEnv = {
  SMARTI_LOCAL_SECRET?: string;
  SMARTI_TRUST_LAN?: string;
  SMARTI_HOST?: string;
  HOSTNAME?: string;
};

/** The header the desktop's own window carries. Never sent by anything else. */
export const LOCAL_HEADER = 'x-smarti-local';
/** The header a guest's page sends, having read the token out of the fragment. */
export const SHARE_HEADER = 'x-smarti-share';

/**
 * Addresses that mean "every interface". An empty `HOSTNAME` counts too: that is
 * what Next's standalone server defaults to, and defaulting to the permissive
 * reading of an unset variable is how a gate quietly stops being one.
 */
function boundWide(env: AccessEnv): boolean {
  const host = (env.SMARTI_HOST ?? env.HOSTNAME ?? '127.0.0.1').trim();
  return host === '' || host === '0.0.0.0' || host === '::' || host === '[::]';
}

/**
 * A request that reached us through somebody else's edge. See rule 1 above —
 * this is the single most important line in the file, and it is here rather than
 * in v4.2 so that it can never be the thing somebody forgot.
 */
function proxied(headers: Headers): boolean {
  return headers.has('cf-connecting-ip') || headers.has('cf-ray');
}

/**
 * The whole decision. `boardId` is the board the route is about, or null for the
 * routes that are about no board (the library, the settings) — and a null board
 * can never be reached by a share, because a token names exactly one board.
 */
export function decideAccess(
  headers: Headers,
  boardId: string | null,
  env: AccessEnv,
  resolveToken: (token: string) => string | null,
): Access {
  const remote = proxied(headers);

  const secret = (env.SMARTI_LOCAL_SECRET ?? '').trim();
  // The empty secret must never match an absent header — that would make every
  // caller local on every install that does not set one, which is most of them.
  if (!remote && secret && headers.get(LOCAL_HEADER) === secret) return 'local';

  if (!remote && !boundWide(env)) return 'local';

  if (!remote && (env.SMARTI_TRUST_LAN ?? '').trim() !== '') return 'trusted';

  const token = headers.get(SHARE_HEADER);
  if (token && boardId) {
    const shared = resolveToken(token);
    if (shared && shared === boardId) return { share: shared };
  }

  return 'denied';
}

/** The impure line: this process's environment, and this process's registry. */
export function accessFor(req: Request, boardId: string | null = null): Access {
  return decideAccess(req.headers, boardId, process.env as AccessEnv, boardForShare);
}

/**
 * May this caller act on the install — the library, another board, the settings,
 * the provider key, minting a share? Only somebody at the machine, or somebody
 * on a network its operator explicitly vouched for.
 */
export function canManage(a: Access): boolean {
  return a === 'local' || a === 'trusted';
}

/**
 * May this caller reach *this* board? The share tier and nothing wider: a token
 * for board A is a stranger everywhere else, which is the property `access.test`
 * asserts first.
 */
export function canReachBoard(a: Access, id: string): boolean {
  if (canManage(a)) return true;
  return typeof a === 'object' && a.share === id;
}

/* ----------------------------------------------------------------- guards --- */

/**
 * What a refusal says, and why the two differ.
 *
 * **Board-scoped refusals are 404**: a stranger must not be able to learn that a
 * board id exists by the shape of the answer, and "no such board" is the same
 * sentence whether it is absent or merely not theirs. **Install-scoped refusals
 * are 403**: there is nothing to conceal about the library or the settings
 * existing, and a clear refusal is more useful to whoever is looking at it.
 *
 * They return `Response`, not `NextResponse`, so this module stays node-free and
 * `access.test.ts` never has to import a framework to read a decision table.
 */
export function guardManage(req: Request): Response | null {
  if (canManage(accessFor(req))) return null;
  return Response.json({ error: 'forbidden' }, { status: 403 });
}

/**
 * The board-scoped guard. Every route that is about one board calls this as its
 * first statement — **above the privacy check** in `/suggest` and `/ideas`, so a
 * caller with no right to the board cannot tell "privacy is on" from "no such
 * board".
 */
export function guardBoard(req: Request, id: string): Response | null {
  if (canReachBoard(accessFor(req, id), id)) return null;
  return Response.json({ error: 'not found' }, { status: 404 });
}
