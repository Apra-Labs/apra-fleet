// viewer-proxy.mjs -- fleet-bridge-implementation-plan.md Part B
// (`src/viewer-proxy.mjs   0.0.0.0 -> 127.0.0.1:8787, bearer injection`) and
// fleet-bridge-design.md Section 7.2 ("A full-control LAN viewer (and its
// collision with #493)").
//
// -----------------------------------------------------------------------------
// WHY THIS EXISTS
// -----------------------------------------------------------------------------
// apra-fleet PR #493 binds the always-on supervisor to 127.0.0.1 and requires
// a bearer token -- correctly, since the supervisor's own API includes
// POST /api/shutdown and full sprint control. That also means a pipeline
// runner can no longer just hand a human `http://<runner-host>:8787/...` --
// the link would be dead off-box the moment #493 lands.
//
// `createViewerProxy` is the fix: a small reverse proxy that binds
// `0.0.0.0:<listenPort>` (LAN-reachable, same as the child viewer used to be
// before #493), forwards to the supervisor at `127.0.0.1:<upstreamPort>`, and
// injects the supervisor's own bearer token on every upstream request. The
// pipeline hands out THIS proxy's URL, never the supervisor's -- the link
// survives #493 because the proxy, not the browser, holds the credential.
//
// This proxy is intentionally unguarded on the LAN: a browser address-bar
// navigation cannot set a request header, so a bearer-token guard accepting
// only programmatic (fetch/XHR) callers would leave the browser unreachable,
// defeating the proxy's entire purpose. The LAN exposure is acknowledged and
// accepted pending #493 (supervisor loopback binding); the supervisor's own
// surface is a larger attack vector and includes POST /api/shutdown, which
// this proxy withholds. After #493, a cookie-based guard (small login route,
// HttpOnly; SameSite=Strict cookie) is the design to build then.
//
// -----------------------------------------------------------------------------
// A CONTROL SURFACE, NOT A READ-ONLY WINDOW
// -----------------------------------------------------------------------------
// This is a BLANKET passthrough: every method and path reaches the supervisor
// unchanged, including the sprint control surface fleet-bridge-design.md
// Section 7.2 calls out by name (pause/resume/stop/save_logs, POST
// /api/sprints, force-release). That is deliberate -- watching a sprint is
// only half of what a person needs, and enumerating an allowlist here would
// silently go stale every time the supervisor grows a new control route.
//
// Exactly ONE route is withheld: `POST /api/shutdown`. That kills the
// supervisor process itself, taking down every other sprint's visibility
// with it -- it is not sprint control, and nobody should reach it from a
// browser on the LAN. It is refused with a clear message and never reaches
// upstream. One `isWithheldRoute` check to change if that judgement is ever
// wrong, per the design doc.
//
// -----------------------------------------------------------------------------
// REUSE, NOT RE-DERIVATION
// -----------------------------------------------------------------------------
// Every byte moves through `proxyStream` (apra-fleet-se/src/supervisor/proxy.mjs,
// exported in fleet-bridge-implementation-plan.md Part A2 specifically for
// this file): SSE flush discipline, premature-close propagation, and
// hop-by-hop stripping all come from there, unmodified. This module never
// calls `node:http` directly and never re-implements streaming.
//
// `extraHeaders` (also added in Part A2, merged into the upstream request
// headers LAST so it always wins) is how the supervisor bearer gets injected
// without this module touching header-copying logic itself.
//
// `rewriteChildHtml` is NOT used here. That function exists because the
// supervisor's OWN internal live-view proxy (`createLiveProxy` in the same
// file) inserts a path PREFIX (`/sprints/:id/live`) between the browser and
// the child viewer, so the child's absolute app-path calls (`'/events'`,
// `'/state?...'`, ...) need rewriting to re-enter under that prefix. This
// proxy inserts NO prefix -- `listenHost:listenPort` maps to
// `upstreamHost:upstreamPort` with the path left byte-identical (a pure
// host:port swap, one layer further out). Whatever absolute paths the
// supervisor already serves (already correctly rewritten by ITS OWN proxy
// where needed) resolve exactly the same way from this proxy's origin, since
// the origin the browser sees changes but the path does not. Rewriting again
// here would either be a no-op (paths this proxy's origin already serves
// correctly) or, worse, double-prefix a path that was already rewritten
// upstream. `test/viewer-proxy.test.mjs` asserts HTML passes through
// byte-identical to prove this.
//
// -----------------------------------------------------------------------------
// SECURITY: THE SUPERVISOR BEARER NEVER LEAKS THE OTHER WAY
// -----------------------------------------------------------------------------
// Two rules, all enforced here (never delegated to the caller):
//   1. The supervisor bearer (from `readTokenFile()`) is attached to the
//      UPSTREAM request only, via `extraHeaders`. It is never written to a
//      downstream response, never logged, never included in an error message.
//   2. Whatever `Authorization` header a LAN client sent is stripped from the
//      request BEFORE it reaches `proxyStream`, so it can never leak upstream
//      verbatim and can never collide with the injected supervisor bearer.
//
// -----------------------------------------------------------------------------
// INJECTED I/O ONLY (this package's rule, restated in every sibling module)
// -----------------------------------------------------------------------------
// `readTokenFile` (sync, matches supervisor-client.mjs's own contract exactly
// -- never `node:fs` here) and `createServer` (never `node:http` here) both
// arrive via the constructor options. `logger` is optional and defaults to a
// silent no-op, never `console`.
//
// THE ERROR RULE (build-log.md, mechanically enforced by test/error-rule.test.mjs):
// every throw crossing this module's boundary is a `BridgeError`. Construction-time
// misconfiguration (a missing/malformed option) is `CONFIG_MISSING` /
// `CONFIG_INVALID`. Once the server is running, a per-request failure (a bad
// URL, an unreachable upstream, a handler defect) is NEVER thrown across an
// HTTP boundary -- it is turned into a plain HTTP response, isolated exactly
// like `apra-fleet-se/src/supervisor/server.mjs`'s own dispatcher isolates a
// route handler's failure, so one bad request can never crash the proxy or
// take down any other in-flight connection.
//
// ASCII only.

import { BridgeError, BRIDGE_ERROR_CODES } from './errors.mjs';
import { proxyStream, sendPlain } from '@apralabs/apra-fleet-se/src/supervisor/proxy.mjs';

/** The one route this proxy deliberately never forwards. See the file header. */
const WITHHELD_METHOD = 'POST';
const WITHHELD_PATH = '/api/shutdown';

const REFUSAL_MESSAGE =
  "refused: POST /api/shutdown is not forwarded by this LAN viewer proxy. " +
  'It would stop the supervisor itself and take down every other sprint\'s ' +
  'visibility, not just this one. Reach the supervisor host directly if ' +
  'that is really what is intended.';

function safeMessage(err) {
  return err && err.message ? err.message : String(err);
}

/**
 * Strips whatever `Authorization` header a LAN client sent so it can never
 * leak upstream verbatim and never collides with the supervisor bearer this
 * module injects itself. Mutates `req.headers` in place -- safe for a real
 * `IncomingMessage` (node discards the object after the request) and for the
 * plain object a test hands in.
 * @param {import('http').IncomingMessage} req
 */
function stripInboundAuthorization(req) {
  if (!req || !req.headers) return;
  delete req.headers.authorization;
  delete req.headers.Authorization;
}

/**
 * @param {string} method
 * @param {string} pathname
 * @returns {boolean}
 */
function isWithheldRoute(method, pathname) {
  return method === WITHHELD_METHOD && pathname === WITHHELD_PATH;
}

/**
 * Validates and normalizes constructor options.
 * @param {object} opts
 * @returns {{ listenHost: string, listenPort: number, upstreamHost: string, upstreamPort: number }}
 * @throws {BridgeError} CONFIG_INVALID
 */
function validateProxyOpts(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};

  const listenHost = typeof o.listenHost === 'string' && o.listenHost.length > 0 ? o.listenHost : '0.0.0.0';
  const upstreamHost = typeof o.upstreamHost === 'string' && o.upstreamHost.length > 0 ? o.upstreamHost : '127.0.0.1';

  const listenPort = o.listenPort === undefined ? 8788 : o.listenPort;
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      'createViewerProxy: opts.listenPort must be an integer in [0, 65535] when provided (0 asks the OS for an ephemeral port)',
      { field: 'listenPort' },
    );
  }

  const upstreamPort = o.upstreamPort === undefined ? 8787 : o.upstreamPort;
  if (!Number.isInteger(upstreamPort) || upstreamPort <= 0 || upstreamPort > 65535) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      'createViewerProxy: opts.upstreamPort must be a positive integer in (0, 65535] when provided',
      { field: 'upstreamPort' },
    );
  }

  return Object.freeze({ listenHost, listenPort, upstreamHost, upstreamPort });
}

/**
 * Validates injected collaborators.
 * @param {object} opts
 * @returns {{ readTokenFile: Function, createServer: Function, log: Function, logError: Function }}
 * @throws {BridgeError} CONFIG_MISSING
 */
function validateProxyDeps(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};

  if (typeof o.readTokenFile !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'createViewerProxy requires opts.readTokenFile -- a synchronous () => string|null reader of the supervisor bearer, following supervisor-client.mjs\'s own pattern; never node:fs directly',
      { param: 'readTokenFile' },
    );
  }
  if (typeof o.createServer !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'createViewerProxy requires opts.createServer -- an injected HTTP server factory ((requestListener) => http.Server-shaped object); never node:http directly',
      { param: 'createServer' },
    );
  }

  const logger = o.logger && typeof o.logger === 'object' ? o.logger : {};
  const log = (...a) => { try { logger.log?.(...a); } catch { /* logging must never break the proxy */ } };
  const logError = (...a) => { try { (logger.error ?? logger.log)?.(...a); } catch { /* ditto */ } };

  return { readTokenFile: o.readTokenFile, createServer: o.createServer, log, logError };
}

/**
 * Creates the LAN viewer proxy described in fleet-bridge-design.md Section
 * 7.2. Does not start listening until `start()` is called.
 *
 * @param {{
 *   listenHost?: string,
 *   listenPort?: number,
 *   upstreamHost?: string,
 *   upstreamPort?: number,
 *   readTokenFile: () => (string|null),
 *   createServer: (requestListener: (req: any, res: any) => void) => ({
 *     listen: (port: number, host: string, cb: () => void) => void,
 *     close: (cb: () => void) => void,
 *     on?: (event: string, cb: Function) => void,
 *     once?: (event: string, cb: Function) => void,
 *     removeListener?: (event: string, cb: Function) => void,
 *     address?: () => ({ port: number } | null),
 *   }),
 *   logger?: { log?: Function, error?: Function },
 * }} opts
 * @returns {{ start: () => Promise<{ port: number }>, stop: () => Promise<void> }}
 * @throws {BridgeError} CONFIG_MISSING / CONFIG_INVALID, at construction time only.
 */
export function createViewerProxy(opts = {}) {
  const { listenHost, listenPort, upstreamHost, upstreamPort } = validateProxyOpts(opts);
  const { readTokenFile, createServer, log, logError } = validateProxyDeps(opts);

  /** Best-effort, defensive read: a throwing/misbehaving injected reader must never crash the proxy or a single request. */
  function readSupervisorToken() {
    let value;
    try {
      value = readTokenFile();
    } catch (err) {
      // Never surface the token itself here -- there isn't one to surface --
      // only the failure kind, matching supervisor-client.mjs's own rule.
      logError(`[viewer-proxy] readTokenFile() threw (forwarding without a bearer): ${err && err.name ? err.name : 'Error'}`);
      return null;
    }
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  /**
   * The one request handler. Never throws -- every failure path (bad URL,
   * withheld route, upstream failure) ends in a plain HTTP response, isolated
   * exactly like the supervisor's own dispatcher isolates a handler failure
   * (server.mjs's `handleRequest`).
   * @param {import('http').IncomingMessage} req
   * @param {import('http').ServerResponse} res
   */
  function handleRequest(req, res) {
    let url;
    try {
      // The base origin is never used for anything but parsing; listenHost
      // may be `0.0.0.0`, which is not itself a valid URL host.
      url = new URL(req.url || '/', 'http://viewer-proxy.local');
    } catch (err) {
      logError(`[viewer-proxy] could not parse request URL "${req && req.url}": ${safeMessage(err)}`);
      sendPlain(res, 400, 'bad request path');
      return;
    }

    const method = (req.method || 'GET').toUpperCase();

    // Rule 1 (file header): withheld unconditionally, before any other
    // considerations. Never reaches proxyStream, never touches the upstream socket.
    if (isWithheldRoute(method, url.pathname)) {
      log(`[viewer-proxy] refused ${method} ${url.pathname} -- withheld route (fleet-bridge-design.md Section 7.2)`);
      sendPlain(res, 403, REFUSAL_MESSAGE);
      return;
    }

    // Rule 2 (file header): never let whatever Authorization the LAN client
    // sent reach the upstream request.
    stripInboundAuthorization(req);

    const supervisorToken = readSupervisorToken();
    const extraHeaders = supervisorToken ? { authorization: `Bearer ${supervisorToken}` } : undefined;

    try {
      proxyStream({
        host: upstreamHost,
        port: upstreamPort,
        childPath: url.pathname + (url.search || ''),
        req,
        res,
        logError,
        extraHeaders,
      });
    } catch (err) {
      // proxyStream is defensive internally (see proxy.mjs), but this module
      // never lets a synchronous defect there escape as an unhandled
      // exception either -- one bad request must never take the proxy down.
      logError(`[viewer-proxy] proxyStream threw synchronously (isolated): ${safeMessage(err)}`);
      if (!res.headersSent) {
        try { sendPlain(res, 502, 'viewer proxy error'); } catch { /* gone */ }
      } else {
        try { res.end(); } catch { /* gone */ }
      }
    }
  }

  let server = null;

  return {
    /**
     * Idempotent: a second call while already listening resolves immediately
     * with the already-bound port rather than binding twice.
     * @returns {Promise<{ port: number }>}
     */
    async start() {
      if (server) {
        const addr = typeof server.address === 'function' ? server.address() : null;
        const boundPort = addr && typeof addr === 'object' && Number.isInteger(addr.port) ? addr.port : listenPort;
        return { port: boundPort };
      }

      const s = createServer((req, res) => {
        // handleRequest is fully synchronous-looking from here but internally
        // hands off to proxyStream's own async I/O; it never returns a
        // rejected promise (there is nothing to await), so no .catch() seam
        // is needed here -- every failure path inside already resolves the
        // response itself.
        handleRequest(req, res);
      });

      await new Promise((resolve, reject) => {
        const onError = (err) => {
          if (typeof s.removeListener === 'function') s.removeListener('listening', onListening);
          reject(new BridgeError(
            BRIDGE_ERROR_CODES.CONFIG_INVALID,
            `viewer proxy failed to bind ${listenHost}:${listenPort}: ${safeMessage(err)}`,
            { listenHost, listenPort },
          ));
        };
        const onListening = () => {
          if (typeof s.removeListener === 'function') s.removeListener('error', onError);
          resolve();
        };
        if (typeof s.once === 'function') {
          s.once('error', onError);
          s.once('listening', onListening);
        } else if (typeof s.on === 'function') {
          s.on('error', onError);
          s.on('listening', onListening);
        } else {
          // A minimal fake server with neither on() nor once(): assume
          // listen()'s callback is the only signal available.
          resolve();
        }
        s.listen(listenPort, listenHost, () => {
          if (typeof s.once !== 'function' && typeof s.on !== 'function') resolve();
        });
      });

      server = s;
      const addr = typeof s.address === 'function' ? s.address() : null;
      const boundPort = addr && typeof addr === 'object' && Number.isInteger(addr.port) ? addr.port : listenPort;
      log(`[viewer-proxy] listening on http://${listenHost}:${boundPort} -> upstream http://${upstreamHost}:${upstreamPort}`);
      return { port: boundPort };
    },

    /**
     * Idempotent: a second call, or a call before `start()`, is a no-op.
     * @returns {Promise<void>}
     */
    async stop() {
      if (!server) return;
      const s = server;
      server = null;
      await new Promise((resolve) => {
        if (typeof s.close !== 'function') { resolve(); return; }
        s.close(() => resolve());
      });
    },
  };
}

export default createViewerProxy;
