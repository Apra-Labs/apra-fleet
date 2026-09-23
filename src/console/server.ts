/**
 * Console seam (apra-fleet-v6t7.2.1).
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
 * NO AUTH GUARD IN THIS SPRINT. Every console path handled here is open on
 * the server's existing 127.0.0.1-only trust boundary, exactly like the
 * interim /ui route it replaces. A later sprint adds the console guard and
 * cookie in front of the dispatch below; until then do not assume any
 * request reaching a route handler has been authenticated.
 *
 * Static serving (/ui and /ui/*) is reached through the typed
 * ConsoleStaticHandler hook on ConsoleContext rather than inlined here --
 * src/console/static.ts (apra-fleet-v6t7.2.2) is its implementation.
 */
import type http from 'node:http';
import { fleetRoutes } from './routes/fleet.js';

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

const routes: ConsoleRoute[] = ROUTE_MODULES.flat();

/** '/api/fleet/members' -> '/api/fleet'. The set of these is what makes a
 *  path a console API path, so adding a module widens the handled namespace
 *  automatically -- no second list to keep in sync. */
function apiNamespace(routePath: string): string {
  const parts = routePath.split('/').filter(Boolean);
  return '/' + parts.slice(0, 2).join('/');
}

const API_NAMESPACES: string[] = [...new Set(routes.map((r) => apiNamespace(r.path)))];

const UI_PREFIX = '/ui';

function isUiPath(pathname: string): boolean {
  return pathname === UI_PREFIX || pathname.startsWith(UI_PREFIX + '/');
}

function isApiPath(pathname: string): boolean {
  return API_NAMESPACES.some((ns) => pathname === ns || pathname.startsWith(ns + '/'));
}

/** Exported for tests and for callers that want to know whether a path
 *  belongs to the console before dispatching it. */
export function isConsolePath(pathname: string): boolean {
  return isUiPath(pathname) || isApiPath(pathname);
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

/** Default static implementation. The sibling static task
 *  (apra-fleet-v6t7.2.2) is its owner and destination: until it lands, the
 *  caller injects the implementation through ConsoleContext.serveStatic and
 *  this default answers "nothing to serve", which the dispatch below turns
 *  into the server's existing 404. */
const staticHandlerDefault: ConsoleStaticHandler = () => false;

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
  let pathname: string;
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    return false;
  }
  if (!isConsolePath(pathname)) return false;

  const method = (req.method ?? 'GET').toUpperCase();

  if (isUiPath(pathname)) {
    if (method === 'GET') {
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

