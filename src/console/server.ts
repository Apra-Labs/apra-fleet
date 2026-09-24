/**
 * Console seam (apra-fleet-v6t7.2.1; guard added by apra-fleet-iywi.2.1).
 *
 * OWNERSHIP RULE -- read before editing.
 * This file is a seam, not a feature. Later sprints add a console screen by
 * APPENDING a new route module under src/console/routes/ and adding ONE line
 * to ROUTE_MODULES below. They do NOT edit the handler bodies here, and they
 * do NOT add route tables inline in this file. That keeps shared-file churn
 * (and the merge conflicts that come with it) out of every console sprint
 * after this one.
 *
 * Route modules are registered from an EXPLICIT import list -- never by
 * filesystem globbing. Globbing cannot work inside the single-executable
 * (SEA) binary, where there is no src/console/routes/ directory on disk to
 * enumerate; an explicit import list is what the esbuild bundle can follow.
 *
 * AUTH GUARD (apra-fleet-iywi.2.1): every `/api/*` request and every
 * non-GET `/ext/*` request is checked against the shared fleet key before
 * route dispatch. The guard is keyed on `API_NAMESPACES`/`isExtPath`, which
 * are DERIVED from ROUTE_MODULES/EXT_PREFIX rather than a hand-maintained
 * path list, so a route module appended later is covered automatically --
 * see `requiresConsoleGuard` below. `/health` and `/mcp` are not console
 * paths at all and never reach this file. `/ui` (the shell) stays open and
 * additionally sets the console cookie on every GET.
 *
 * SECURITY CONSTRAINT (verified against src/services/jwt.ts): the fleet key
 * this guard checks against is ALSO the HS256 HMAC signing secret for member
 * JWTs (jwt.ts sign()/verify() both call getOrCreateKey() and use it as the
 * createHmac key). Handing the raw fleet key to a browser as a cookie would
 * let anyone who reads it mint member JWTs with an arbitrary member_id,
 * role and workspace_id -- HttpOnly does not prevent that (it only stops
 * script access, not exfiltration via XSS/log/proxy, and the cookie is
 * still readable by anything with filesystem/network access to it). The
 * cookie therefore carries `HMAC-SHA256(fleetKey, CONSOLE_COOKIE_LABEL)`
 * (see `deriveConsoleCookieToken`) -- verifiable server-side by recomputing
 * the same HMAC, but not reversible into the signing key. The bearer path
 * still accepts the raw fleet key unchanged, so existing CLI/script callers
 * are unaffected.
 *
 * Static serving (/ui and /ui/*) is reached through the typed
 * ConsoleStaticHandler hook on ConsoleContext rather than inlined here --
 * src/console/static.ts is its implementation and the only place in the
 * tree that reads the built shell.
 */
import crypto from 'node:crypto';
import type http from 'node:http';
import { isAuthorized as checkCredential, cookieFor, normalizePath } from '@apralabs/apra-fleet-client/auth/local-token';
import { getOrCreateKey } from '../services/jwt.js';
import { fleetRoutes } from './routes/fleet.js';
import { serveUiAsset } from './static.js';

/** Where the built shell lives, plus how to read it. Passed straight through
 *  to the static hook, so a test can point the console at a temp dist (or a
 *  fake SEA asset reader) without building a binary. */
export interface ConsoleStaticSource {
  /** Disk root of the built shell dist. Undefined = the implementation's
   *  own default (the real packages/apra-fleet-shell-ui/dist path). */
  shellDistDir?: string;
  /** SEA asset reader, 'ui/'-namespaced. Undefined = the implementation's
   *  own default (real node:sea when running as a binary, else none). */
  getAsset?: ((key: string) => ArrayBuffer | undefined) | null;
}

/** Serves one /ui path. Returns true when it wrote a response, false when
 *  there is no shell to serve at all (caller then answers 404). */
export type ConsoleStaticHandler = (
  pathname: string,
  res: http.ServerResponse,
  source: ConsoleStaticSource,
) => boolean | Promise<boolean>;

export interface ConsoleContext extends ConsoleStaticSource {
  /** Static-serving implementation. Defaults to src/console/static.ts;
   *  overridable so tests (and the migration lane) can swap it. */
  serveStatic?: ConsoleStaticHandler;
}

export interface ConsoleRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Exact pathname match, e.g. '/api/fleet/members'. */
  path: string;
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    context: ConsoleContext,
  ) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Route module registration -- the ONE line a later sprint appends.
// ---------------------------------------------------------------------------
const ROUTE_MODULES: ConsoleRoute[][] = [
  fleetRoutes,
];

/** '/api/fleet/members' -> '/api/fleet'. The set of these is what makes a
 *  path a console API path, so adding a module widens the handled namespace
 *  automatically -- no second list to keep in sync. */
function apiNamespace(routePath: string): string {
  const parts = routePath.split('/').filter(Boolean);
  return '/' + parts.slice(0, 2).join('/');
}

function computeApiNamespaces(rts: ConsoleRoute[]): string[] {
  return [...new Set(rts.map((r) => apiNamespace(r.path)))];
}

// `let`, not `const`: __registerTestRouteModule (below) reassigns both so a
// test can prove the extensibility guarantee (apra-fleet-iywi.2.2) without
// forking this file. Production code only ever reads them.
let routes: ConsoleRoute[] = ROUTE_MODULES.flat();
let API_NAMESPACES: string[] = computeApiNamespaces(routes);

/**
 * TEST-ONLY escape hatch (apra-fleet-iywi.2.2). A REAL future sprint still
 * adds a route the documented way -- a new file under src/console/routes/
 * plus one line in ROUTE_MODULES above, per the OWNERSHIP RULE at the top of
 * this file. This function exists solely so a test can register a
 * throwaway route MODULE at runtime and assert its namespace is guarded
 * automatically, proving the guard keys off the derived API_NAMESPACES
 * rather than a hand-maintained path list -- without forking/editing this
 * file to do it. Returns an unregister function; tests MUST call it in
 * afterEach so one test's route module can never leak into another's.
 */
export function __registerTestRouteModule(moduleRoutes: ConsoleRoute[]): () => void {
  routes = [...routes, ...moduleRoutes];
  API_NAMESPACES = computeApiNamespaces(routes);
  return () => {
    routes = routes.filter((r) => !moduleRoutes.includes(r));
    API_NAMESPACES = computeApiNamespaces(routes);
  };
}

const UI_PREFIX = '/ui';

/** apra-fleet-iywi.2.1: no route module declares /ext -- the reverse proxy
 *  that will serve it lands in a later lane. This path class exists so
 *  mutating /ext/* requests can be guarded (and GET /ext/* left open) before
 *  that proxy exists; until it lands, a guarded-but-unhandled /ext path
 *  falls through to the same "no route registered" 404 every other
 *  unmatched console path gets -- never a 500. */
const EXT_PREFIX = '/ext';

function isUiPath(pathname: string): boolean {
  return pathname === UI_PREFIX || pathname.startsWith(UI_PREFIX + '/');
}

function isApiPath(pathname: string): boolean {
  return API_NAMESPACES.some((ns) => pathname === ns || pathname.startsWith(ns + '/'));
}

function isExtPath(pathname: string): boolean {
  return pathname === EXT_PREFIX || pathname.startsWith(EXT_PREFIX + '/');
}

/** Exported for tests and for callers that want to know whether a path
 *  belongs to the console before dispatching it. */
export function isConsolePath(pathname: string): boolean {
  return isUiPath(pathname) || isApiPath(pathname) || isExtPath(pathname);
}

/**
 * Is `pathname`/`method` behind the console auth guard? Every `/api/*`
 * request (read and write alike -- it exposes fleet/member state) plus
 * every NON-GET `/ext/*` request (GET /ext/* stays open once the proxy
 * lands, matching a normal reverse-proxy's read path). Keyed on
 * `isApiPath`, which is derived from `ROUTE_MODULES` -- so a route module
 * appended by a later sprint is guarded automatically, with no second list
 * to keep in sync (the property apra-fleet-iywi.2.2's extensibility test
 * pins).
 */
function requiresConsoleGuard(pathname: string, method: string): boolean {
  if (isApiPath(pathname)) return true;
  if (isExtPath(pathname) && method !== 'GET') return true;
  return false;
}

/** Fixed label HMAC'd under the fleet key to derive the console cookie
 *  value -- see the SECURITY CONSTRAINT note at the top of this file. Never
 *  change this string without also invalidating every outstanding console
 *  cookie (they'd stop verifying). */
const CONSOLE_COOKIE_LABEL = 'apra-fleet-console-cookie-v1';

/** Cookie name for the console's derived credential. Deliberately distinct
 *  from the fleet-sprint supervisor's `se_token` cookie -- each caller of
 *  the shared local-token helper picks its own name. */
const CONSOLE_COOKIE_NAME = 'apra_console_token';

/**
 * Derive the console's cookie value from the fleet key: a keyed digest of a
 * fixed label, so it is verifiable server-side (recompute and compare) but
 * cannot be reversed into the signing key itself.
 */
function deriveConsoleCookieToken(fleetKey: string): string {
  return crypto.createHmac('sha256', fleetKey).update(CONSOLE_COOKIE_LABEL).digest('hex');
}

/**
 * Does `req` carry valid console credentials? The bearer path and the
 * cookie path are checked against two DIFFERENT expected secrets (the raw
 * fleet key for bearer, the derived digest for the cookie), so each check is
 * run against a request view carrying only the ONE header it applies to --
 * otherwise the shared `isAuthorized` helper (which accepts either
 * credential against a single expected value) could not tell "no bearer,
 * fall through to cookie" from "wrong bearer" using two different secrets.
 */
function isConsoleAuthorized(req: http.IncomingMessage, fleetKey: string, cookieToken: string): boolean {
  const headers = (req.headers ?? {}) as Record<string, unknown>;
  const bearerOnly = { headers: { authorization: headers.authorization } };
  if (checkCredential(bearerOnly, fleetKey, { cookieName: CONSOLE_COOKIE_NAME })) return true;
  const cookieOnly = { headers: { cookie: headers.cookie } };
  return checkCredential(cookieOnly, cookieToken, { cookieName: CONSOLE_COOKIE_NAME });
}

/** Byte-identical to the server's existing catch-all 404 (no content-type,
 *  empty body), so a console path with nothing behind it looks exactly like
 *  any other unmatched route. */
function plainNotFound(res: http.ServerResponse): void {
  res.writeHead(404);
  res.end();
}

function jsonError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

/** Default static implementation: src/console/static.ts, the single
 *  index.html-serving code path in the tree. ConsoleContext.serveStatic
 *  overrides it (tests, and any future alternate shell source). */
const staticHandlerDefault: ConsoleStaticHandler = serveUiAsset;

/**
 * The single entry point the HTTP transport delegates to.
 *
 * Returns true when the request was a console request AND a response has been
 * written (including the 404 for a console path with nothing behind it), and
 * false when the path does not belong to the console at all -- in which case
 * nothing has been written to res and the caller's routing continues
 * unchanged.
 */
export async function handleConsoleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  context: ConsoleContext = {},
): Promise<boolean> {
  // apra-fleet-iywi.2.1: parse the path via the shared normaliser (parse
  // against a dummy origin, take .pathname) so this dispatcher and the guard
  // below can never disagree about which route a URL names. An unparseable
  // URL is not recognised as a console path at all (same as before this
  // task) -- the caller's own routing continues unchanged.
  const pathname = normalizePath(req.url ?? '/');
  if (pathname === null || !isConsolePath(pathname)) return false;

  const method = (req.method ?? 'GET').toUpperCase();

  if (requiresConsoleGuard(pathname, method)) {
    const fleetKey = getOrCreateKey();
    const cookieToken = deriveConsoleCookieToken(fleetKey);
    if (!isConsoleAuthorized(req, fleetKey, cookieToken)) {
      jsonError(res, 401, 'unauthorized');
      return true;
    }
  }

  if (isUiPath(pathname)) {
    if (method === 'GET') {
      // apra-fleet-iywi.2.1: the console cookie carries a value DERIVED from
      // the fleet key (never the raw key -- see the SECURITY CONSTRAINT note
      // at the top of this file), set on every GET so the shell works from
      // any client-side route, not just the literal "/ui" entry path.
      const fleetKey = getOrCreateKey();
      res.setHeader('Set-Cookie', cookieFor(deriveConsoleCookieToken(fleetKey), { cookieName: CONSOLE_COOKIE_NAME }));
      const serveStatic = context.serveStatic ?? staticHandlerDefault;
      try {
        const served = await serveStatic(pathname, res, {
          shellDistDir: context.shellDistDir,
          getAsset: context.getAsset,
        });
        if (served) return true;
      } catch {
        // A broken shell dist must never take the MCP server down with it.
        if (!res.headersSent) plainNotFound(res);
        return true;
      }
    }
    // No shell to serve (or a non-GET method): the same 404 every other
    // unmatched route gets.
    plainNotFound(res);
    return true;
  }

  const route = routes.find((r) => r.path === pathname && r.method === method);
  if (!route) {
    const pathExists = routes.some((r) => r.path === pathname);
    if (pathExists) {
      jsonError(res, 405, 'method not allowed');
    } else {
      jsonError(res, 404, 'not found');
    }
    return true;
  }

  try {
    await route.handler(req, res, context);
  } catch (err) {
    if (!res.headersSent) {
      jsonError(res, 500, err instanceof Error ? err.message : String(err));
    } else {
      res.end();
    }
  }
  return true;
}

