// viewer.mjs -- fleet-bridge-implementation-plan.md Part B ("`fleet-bridge
// viewer`") and fleet-bridge-design.md Section 7.2 ("A full-control LAN
// viewer (and its collision with #493)").
//
// This verb is a thin, deps-validating wrapper around
// `../viewer-proxy.mjs`'s `createViewerProxy` -- see that file's header for
// the proxy's own behaviour contract (blanket passthrough, the one withheld
// route, bearer injection, `viewerToken` guarding). This module owns nothing
// of the proxy's own logic; it exists only so `bin/fleet-bridge.mjs` (and
// tests) get the same `run<Verb>(opts, deps)` envelope every sibling verb
// uses (see verbs/preflight.mjs, verbs/watch.mjs), with the same split
// between a pure opts validator and a pure deps validator.
//
// INJECTED I/O ONLY (this package's rule, restated in every sibling verb):
// `deps.readTokenFile` and `deps.createServer` arrive already-constructed --
// this module never imports `node:fs` or `node:http` itself, exactly like
// `viewer-proxy.mjs`. Constructing a real `readTokenFile` from a data
// directory (`<dataDir>/private/token`, per `supervisor-client.mjs`'s own
// documented default path) is the caller's job (the eventual
// `bin/fleet-bridge.mjs` wiring), not this verb's.
//
// THE ERROR RULE (build-log.md): every throw crossing this module's boundary
// is a BridgeError. A missing/malformed `opts` field is CONFIG_MISSING /
// CONFIG_INVALID; a missing injected dependency is CONFIG_MISSING. Once the
// proxy is started, this verb throws nothing of its own -- `createViewerProxy`
// already turns every per-request failure into an HTTP response rather than
// an exception (see that file's header), and construction-time failures
// there are already BridgeError per its own contract.
//
// ASCII only.

import { BridgeError, BRIDGE_ERROR_CODES } from '../errors.mjs';
import { createViewerProxy } from '../viewer-proxy.mjs';

/** Matches `createViewerProxy`'s own default (viewer-proxy.mjs). */
export const DEFAULT_LISTEN_HOST = '0.0.0.0';
export const DEFAULT_LISTEN_PORT = 8788;
export const DEFAULT_UPSTREAM_HOST = '127.0.0.1';
export const DEFAULT_UPSTREAM_PORT = 8787;

// ---------------------------------------------------------------------------
// Step 0: validate this verb's own inputs -- see preflight.mjs/watch.mjs for
// the same split (a pure opts validator, a pure deps validator).
// ---------------------------------------------------------------------------

/**
 * @param {{ listenHost?: string, listenPort?: number, upstreamHost?: string, upstreamPort?: number }} opts
 * @returns {{ listenHost: string, listenPort: number, upstreamHost: string, upstreamPort: number }} frozen, normalized
 * @throws {BridgeError} CONFIG_INVALID
 */
export function validateViewerOpts(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};

  const listenHost = typeof o.listenHost === 'string' && o.listenHost.length > 0 ? o.listenHost : DEFAULT_LISTEN_HOST;
  const upstreamHost = typeof o.upstreamHost === 'string' && o.upstreamHost.length > 0 ? o.upstreamHost : DEFAULT_UPSTREAM_HOST;

  const listenPort = o.listenPort === undefined ? DEFAULT_LISTEN_PORT : o.listenPort;
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      'viewer: opts.listenPort must be an integer in [0, 65535] when provided',
      { field: 'listenPort' },
    );
  }

  const upstreamPort = o.upstreamPort === undefined ? DEFAULT_UPSTREAM_PORT : o.upstreamPort;
  if (!Number.isInteger(upstreamPort) || upstreamPort <= 0 || upstreamPort > 65535) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      'viewer: opts.upstreamPort must be a positive integer in (0, 65535] when provided',
      { field: 'upstreamPort' },
    );
  }

  return Object.freeze({ listenHost, listenPort, upstreamHost, upstreamPort });
}

/**
 * @param {object} deps
 * @returns {{ readTokenFile: Function, createServer: Function, logger: object|undefined, log: Function }}
 * @throws {BridgeError} CONFIG_MISSING
 */
function validateViewerDeps(deps) {
  const d = deps && typeof deps === 'object' ? deps : {};

  if (typeof d.readTokenFile !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'viewer: deps.readTokenFile is required -- a synchronous () => string|null reader of the supervisor bearer (see supervisor-client.mjs for the same pattern); never node:fs here',
      { param: 'deps.readTokenFile' },
    );
  }
  if (typeof d.createServer !== 'function') {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'viewer: deps.createServer is required -- an injected HTTP server factory; never node:http here',
      { param: 'deps.createServer' },
    );
  }

  const logger = d.logger && typeof d.logger === 'object' ? d.logger : undefined;
  const log = typeof d.log === 'function' ? d.log : (logger ? (...a) => logger.log?.(...a) : () => {});

  return { readTokenFile: d.readTokenFile, createServer: d.createServer, logger, log };
}

/**
 * `fleet-bridge viewer`: starts the LAN viewer reverse proxy
 * (`../viewer-proxy.mjs`) and returns its handle. Does not block -- the
 * running HTTP server is what keeps a real CLI process alive; the caller
 * (the eventual `bin/fleet-bridge.mjs` wiring) is expected to hook
 * SIGINT/SIGTERM to the returned `stop()`.
 *
 * @param {{ listenHost?: string, listenPort?: number, upstreamHost?: string, upstreamPort?: number }} opts
 * @param {{
 *   readTokenFile: () => (string|null),
 *   createServer: (requestListener: Function) => object,
 *   logger?: { log?: Function, error?: Function },
 *   log?: (msg: string) => void,
 * }} deps
 * @returns {Promise<{ port: number, stop: () => Promise<void> }>}
 * @throws {BridgeError} CONFIG_MISSING / CONFIG_INVALID.
 */
export async function runViewer(opts, deps) {
  const o = validateViewerOpts(opts);
  const d = validateViewerDeps(deps);

  const proxy = createViewerProxy({
    listenHost: o.listenHost,
    listenPort: o.listenPort,
    upstreamHost: o.upstreamHost,
    upstreamPort: o.upstreamPort,
    readTokenFile: d.readTokenFile,
    createServer: d.createServer,
    logger: d.logger,
  });

  const { port } = await proxy.start();
  d.log(`[viewer] LAN viewer listening on http://${o.listenHost}:${port} -> upstream http://${o.upstreamHost}:${o.upstreamPort}`);

  return { port, stop: proxy.stop };
}

export default runViewer;
