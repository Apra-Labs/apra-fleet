/**
 * Reverse proxy for /ext/<package id>/* (apra-fleet-iywi.4.1).
 *
 * Serves the `/ext` path class that the auth-core lane (apra-fleet-iywi.2.1)
 * added to ../server.ts's `isConsolePath`/`requiresConsoleGuard`. VERIFIED
 * before writing this file: that path class exists (`EXT_PREFIX`,
 * `isExtPath`, and the non-GET guard branch in `requiresConsoleGuard`), so
 * this module supplies the handler BEHIND the existing path class -- it does
 * not add a second, divergent /ext branch. ../server.ts dispatches here from
 * exactly one place.
 *
 * Responsibilities:
 *  - resolve `<package id>` to a baseUrl through the registry service
 *    (src/services/workflow-packages.ts, apra-fleet-iywi.3.1). An id that is
 *    not registered is a 404 -- NOT a 502; "you asked for something that does
 *    not exist" and "it exists but is down" are different answers and the
 *    console UI distinguishes them.
 *  - stream request and response bodies. Everything here is pipe-based:
 *    no body, in either direction, is ever held whole in memory. That is not
 *    just a memory optimisation -- a buffering proxy silently breaks SSE,
 *    which is the primary reason workflow packages are proxied at all.
 *  - pass `text/event-stream` through unbuffered: no compression, headers
 *    flushed before the first event, Nagle disabled so a small event is not
 *    held back waiting for more bytes.
 *  - rewrite upstream `Location` headers so a redirect stays under
 *    `/ext/<package id>` instead of escaping the console origin.
 *  - answer 502 with a package-offline body when the upstream is unreachable,
 *    or when the registered baseUrl is unusable (unparseable, or carrying a
 *    scheme other than http:/https: -- see the branch below, which must run
 *    BEFORE any transport is selected).
 *
 * ---------------------------------------------------------------------------
 * CREDENTIAL FORWARDING -- the security core of this module. Read before
 * changing anything below.
 * ---------------------------------------------------------------------------
 * VERIFIED against src/services/jwt.ts: the console's fleet key
 * (~/.apra-fleet/fleet.key, `getOrCreateKey()`) is ALSO the HS256 HMAC
 * signing secret for member JWTs -- `sign()` and `verify()` both pass it
 * straight to `createHmac`. Workflow packages are third-party by design and
 * registered at RUNTIME over HTTP, so forwarding that key verbatim would hand
 * every registered package the ability to mint member JWTs with an arbitrary
 * `member_id`, `role` and `workspace_id`. The raw fleet key therefore NEVER
 * leaves this process on an /ext request.
 *
 * What is forwarded instead is a PER-PACKAGE derived credential:
 *
 *     HMAC-SHA256(fleetKey, "<label>:<len(id)>:<id>")
 *
 * (`deriveUpstreamCredential` below). Properties this buys, each of which the
 * companion suite asserts rather than assumes:
 *  - not reversible into the fleet key, so a compromised package cannot mint
 *    member JWTs or authenticate to the fleet as the console;
 *  - different per package id, so package A cannot replay its own credential
 *    against package B (or against a package it is not);
 *  - DOMAIN-SEPARATED from the console cookie. ../server.ts derives the
 *    browser cookie as HMAC-SHA256(fleetKey, CONSOLE_COOKIE_LABEL) -- same
 *    primitive, same key, a DIFFERENT label. That separation is load-bearing,
 *    not cosmetic: were the labels shared, any package could replay the
 *    credential we just handed it back at the console as a valid console
 *    cookie and walk straight through the guard the auth-core lane added.
 *    This is consistent with (and deliberately distinct from) that lane's
 *    cookie construction -- the two credentials are the same shape and can
 *    never be used interchangeably.
 *
 * The length prefix in the HMAC input is what makes the label/id encoding
 * unambiguous: a bare `label + id` concatenation lets two different ids
 * produce the same digest input, which would defeat the per-package property
 * above.
 *
 * The client's own credentials are STRIPPED, never relayed: the inbound
 * `Cookie` header carries the console cookie, and the inbound `Authorization`
 * header may carry the raw fleet key (the guard's bearer path accepts it).
 * Forwarding either to a third-party upstream would leak exactly what the
 * derivation above exists to protect.
 *
 * No value here is ever interpolated into a shell command -- everything is
 * resolved in JavaScript and passed to node:http as structured options.
 */
import http from 'node:http';
import https from 'node:https';
import { deriveUpstreamCredential } from '@apralabs/apra-fleet-client/auth/local-token';
import { getOrCreateKey } from '../services/jwt.js';
import { workflowPackageService } from '../services/workflow-packages.js';

/** Mount point. Kept in sync with ../server.ts's `EXT_PREFIX` by the single
 *  call site there -- this module is only ever reached through it. */
export const EXT_PREFIX = '/ext';

/**
 * The per-package upstream credential derivation now LIVES IN the shared
 * client package (packages/apra-fleet-client/src/auth/local-token.mjs) so the
 * registry health probe (../services/workflow-packages.ts) and a package's own
 * supervisor can derive the identical value without importing this proxy.
 *
 * Both names stay re-exported from here: this module remains the documented
 * home of the /ext hop's credential policy, and existing importers (including
 * tests/console-proxy.test.ts) keep working against an unchanged surface. The
 * derivation itself is byte-identical to what this file shipped before the
 * lift -- see the fixed-vector test in
 * packages/apra-fleet-client/test/local-token.test.mjs.
 *
 * `UPSTREAM_CREDENTIAL_LABEL` MUST differ from ../server.ts's
 * `CONSOLE_COOKIE_LABEL` -- see the CREDENTIAL FORWARDING note above; making
 * them equal would let any package replay its credential as a console cookie.
 */
export { UPSTREAM_CREDENTIAL_LABEL } from '@apralabs/apra-fleet-client/auth/local-token';
export { deriveUpstreamCredential };

/** Hop-by-hop headers (RFC 7230 s6.1): meaningful only on a single
 *  connection, so they are never relayed across a proxy hop. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Inbound headers dropped on top of the hop-by-hop set. `cookie` and
 *  `authorization` carry the CONSOLE's credentials and must never reach a
 *  third-party package (see the CREDENTIAL FORWARDING note); `host` is
 *  re-derived for the upstream; `accept-encoding` is replaced with
 *  `identity`. */
const DROPPED_REQUEST_HEADERS = new Set(['cookie', 'authorization', 'host', 'accept-encoding']);

export interface ExtProxyOptions {
  /** Pathname already normalised by the caller (../server.ts). */
  pathname: string;
  /** Raw `req.url`, used for the query string -- `pathname` has it stripped. */
  rawUrl: string;
  /** The console's own cookie name. Passed IN rather than imported so this
   *  module and ../server.ts do not form an import cycle; ../server.ts stays
   *  the single owner of the constant. An upstream trying to Set-Cookie this
   *  name is refused (see `filterResponseHeaders`). */
  reservedCookieName: string;
  /**
   * apra-fleet-iywi.11: does the INBOUND request itself carry a valid console
   * credential (bearer fleet key or console cookie)? Decided by ../server.ts
   * -- for a non-GET request this is always true (requiresConsoleGuard
   * already 401ed anything else before this module is ever reached); for a
   * GET request (never guarded, matching a normal reverse-proxy's read path)
   * ../server.ts checks it explicitly and passes the result through here.
   *
   * When `false`, the derived per-package upstream credential (see the
   * CREDENTIAL FORWARDING note above) is NOT attached: the request still
   * reaches the upstream (GET stays open), but carries no `Authorization`
   * header. This closes the credentialed cross-origin GET this task
   * adjudicates -- see docs/console-architecture.md for the recorded
   * decision and the two rejected alternatives -- without changing the
   * unknown-id 404 / unreachable-upstream 502 / success 200 contract for an
   * unauthenticated GET, which is unaffected by whether a credential rides
   * along.
   *
   * Defaults to `true` (the credential is attached) so a caller that omits
   * this option -- an existing test seam, or a future caller that has
   * already authenticated by some other means -- keeps the original
   * behaviour rather than silently losing the credential.
   */
  forwardCredential?: boolean;
  /** Test seam: resolve a package id to its baseUrl. Defaults to the real
   *  registry service. */
  resolveBaseUrl?: (packageId: string) => string | null;
  /** Test seam: the fleet key. Defaults to the real `getOrCreateKey()`. */
  getFleetKey?: () => string;
}

function jsonError(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Default resolver: the registry service's merged view (config-declared and
 *  runtime-registered packages alike). Read fresh per request -- the service
 *  re-reads its file on every `list()`, so a package registered a moment ago
 *  is reachable immediately, with no proxy-side cache to invalidate. */
function defaultResolveBaseUrl(packageId: string): string | null {
  const hit = workflowPackageService.list().find((p) => p.id === packageId);
  return hit ? hit.baseUrl : null;
}

/**
 * Split `/ext/<id>/<rest>` into its still-ENCODED id segment and the
 * remainder. The id is returned both raw (for rebuilding the mount path
 * byte-identically to what the client asked for) and decoded (for registry
 * lookup and credential derivation).
 *
 * A malformed percent-escape in the id makes `decodeURIComponent` throw
 * URIError. That is treated as "no such package" (null -> 404), exactly as
 * apra-fleet-iywi.3.2's `matchParamPath` treats it as a non-match: this
 * function is reached from an async request listener, so an escaping throw
 * would become an unhandled rejection and take the server down.
 */
export function parseExtPath(pathname: string): { rawId: string; id: string; rest: string } | null {
  if (!pathname.startsWith(EXT_PREFIX + '/')) return null;
  const remainder = pathname.slice(EXT_PREFIX.length + 1);
  if (remainder === '') return null;
  const slash = remainder.indexOf('/');
  const rawId = slash === -1 ? remainder : remainder.slice(0, slash);
  if (rawId === '') return null;
  const rest = slash === -1 ? '' : remainder.slice(slash);
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return null;
  }
  if (id === '') return null;
  return { rawId, id, rest };
}

/**
 * Rewrite an upstream `Location` so the client stays under `/ext/<id>`.
 *
 *  - same-origin absolute URL, or a root-relative path: re-mounted under
 *    `mountPath` (the upstream's own base path prefix, if its baseUrl has
 *    one, is stripped first so it is not doubled);
 *  - a genuinely external origin: left untouched. Re-mounting it would turn
 *    the console into an open redirector for arbitrary hosts;
 *  - anything unparseable: left untouched rather than mangled.
 */
export function rewriteLocation(location: string, upstreamUrl: URL, baseUrl: URL, mountPath: string): string {
  let target: URL;
  try {
    target = new URL(location, upstreamUrl);
  } catch {
    return location;
  }
  if (target.origin !== baseUrl.origin) return location;

  const basePath = baseUrl.pathname.replace(/\/+$/, '');
  let rest = target.pathname;
  if (basePath && (rest === basePath || rest.startsWith(basePath + '/'))) {
    rest = rest.slice(basePath.length);
  }
  if (!rest.startsWith('/')) rest = '/' + rest;
  return mountPath + rest + target.search + target.hash;
}

/** Response headers to relay: hop-by-hop dropped, and any attempt by an
 *  upstream to set the CONSOLE's own cookie refused -- packages all share
 *  the console's origin, so an unfiltered Set-Cookie would let one of them
 *  overwrite the console credential in the browser. */
function filterResponseHeaders(
  headers: http.IncomingHttpHeaders,
  reservedCookieName: string,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === 'content-length') continue; // may not survive the hop; Node recomputes/chunks
    if (lower === 'set-cookie') {
      const cookies = (Array.isArray(value) ? value : [value]).filter(
        (c) => !new RegExp(`^\\s*${reservedCookieName}\\s*=`).test(c),
      );
      if (cookies.length > 0) out['set-cookie'] = cookies;
      continue;
    }
    out[lower] = value;
  }
  return out;
}

function isEventStream(headers: http.IncomingHttpHeaders): boolean {
  const ct = headers['content-type'];
  const value = Array.isArray(ct) ? ct[0] : ct;
  return typeof value === 'string' && value.toLowerCase().includes('text/event-stream');
}

/**
 * Proxy one `/ext/*` request. Always writes a response (or tears the socket
 * down when the upstream dies mid-body, which is the only honest signal once
 * headers are already on the wire) and never throws.
 */
export async function handleExtProxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: ExtProxyOptions,
): Promise<void> {
  const parsed = parseExtPath(options.pathname);
  if (!parsed) {
    jsonError(res, 404, { error: 'not found' });
    return;
  }

  const resolveBaseUrl = options.resolveBaseUrl ?? defaultResolveBaseUrl;
  const rawBaseUrl = resolveBaseUrl(parsed.id);
  if (rawBaseUrl === null) {
    // Unknown package id: 404, deliberately distinct from the 502 an
    // unreachable-but-registered package gets.
    jsonError(res, 404, { error: `unknown workflow package "${parsed.id}"` });
    return;
  }

  // An unusable registered baseUrl answers 502 package-offline WITHOUT ever
  // reaching http.request. One branch covers both ways a baseUrl can be
  // unusable, because to the caller they are the same failure -- the package
  // cannot be talked to:
  //
  //   - it does not parse as a URL at all;
  //   - it parses, but its scheme is neither http: nor https:.
  //
  // The second case is NOT caught by parsing, which is why the parse alone
  // was not enough. `new URL()` happily accepts 'ftp://host/' (protocol
  // 'ftp:'), 'file:///x' (protocol 'file:') and even the scheme-less
  // 'localhost:9000' (protocol 'localhost:', empty host). Any of those would
  // previously have been handed straight to http.request below, which throws
  // ERR_INVALID_PROTOCOL SYNCHRONOUSLY -- from inside an async request
  // listener, so it surfaced as an unhandled rejection and took the whole
  // console process down (observed stack: new ClientRequest -> Object.request
  // -> proxy -> handleExtProxyRequest -> handleConsoleRequest). Packages are
  // third-party and registered at runtime, so one of them must never be able
  // to kill the server just by declaring a baseUrl. The scheme is therefore
  // checked HERE, before any transport is selected.
  let parsedBaseUrl: URL | null = null;
  try {
    parsedBaseUrl = new URL(rawBaseUrl);
  } catch {
    parsedBaseUrl = null;
  }
  if (
    parsedBaseUrl === null ||
    (parsedBaseUrl.protocol !== 'http:' && parsedBaseUrl.protocol !== 'https:')
  ) {
    const why =
      parsedBaseUrl === null
        ? 'is not a valid URL'
        : `has unsupported scheme "${parsedBaseUrl.protocol}" (only http: and https: can be proxied)`;
    jsonError(res, 502, {
      error: `workflow package "${parsed.id}" is offline: its registered baseUrl "${rawBaseUrl}" ${why}`,
      packageId: parsed.id,
      baseUrl: rawBaseUrl,
      offline: true,
    });
    return;
  }
  const baseUrl = parsedBaseUrl;

  // Rebuild the upstream URL: the package's base path + whatever followed
  // /ext/<id>, plus the original query string. `pathname` has the query
  // stripped, so it is read back off the raw url here.
  const search = (() => {
    const idx = options.rawUrl.indexOf('?');
    return idx === -1 ? '' : options.rawUrl.slice(idx);
  })();
  const basePath = baseUrl.pathname.replace(/\/+$/, '');
  const upstreamUrl = new URL(baseUrl.toString());
  upstreamUrl.pathname = `${basePath}${parsed.rest}` || '/';
  upstreamUrl.search = search;

  const mountPath = `${EXT_PREFIX}/${parsed.rawId}`;

  // --- request headers -----------------------------------------------------
  const outHeaders: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || DROPPED_REQUEST_HEADERS.has(lower)) continue;
    outHeaders[lower] = value;
  }
  outHeaders.host = upstreamUrl.host;
  // `identity`, always: compression is never negotiated on this hop. An
  // SSE response MUST NOT be compressed (a compressor aggregates bytes and
  // destroys the per-event flush this proxy exists to preserve), and the
  // content type is unknowable until the response headers arrive -- by which
  // point the negotiation has already happened. Declining it up front is the
  // only point at which the SSE case can be guaranteed.
  outHeaders['accept-encoding'] = 'identity';

  // apra-fleet-iywi.11: only attach the derived credential when the inbound
  // request itself was authenticated (always true for a non-GET request,
  // since ../server.ts's guard already 401ed anything else; explicitly
  // decided per-request for GET). An unauthenticated GET still reaches the
  // upstream -- see ExtProxyOptions.forwardCredential's doc comment -- it
  // simply carries nothing an observer could use as a credential.
  if (options.forwardCredential ?? true) {
    const fleetKey = (options.getFleetKey ?? getOrCreateKey)();
    // Derived, per-package, domain-separated -- NEVER the raw fleet key.
    outHeaders.authorization = `Bearer ${deriveUpstreamCredential(fleetKey, parsed.id)}`;
    outHeaders['x-apra-fleet-package-id'] = parsed.id;
  }

  const transport = upstreamUrl.protocol === 'https:' ? https : http;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const upstreamReq = transport.request(
      {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port,
        method: req.method ?? 'GET',
        path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
        headers: outHeaders,
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;
        const headers = filterResponseHeaders(upstreamRes.headers, options.reservedCookieName);

        const location = upstreamRes.headers.location;
        if (typeof location === 'string') {
          headers.location = rewriteLocation(location, upstreamUrl, baseUrl, mountPath);
        }

        const sse = isEventStream(upstreamRes.headers);
        if (sse) {
          // Unbuffered pass-through. Nagle off so a single short event is put
          // on the wire immediately instead of waiting for more bytes, and no
          // content-length/compression is involved either way.
          res.socket?.setNoDelay(true);
          headers['cache-control'] = 'no-cache, no-transform';
        }

        res.writeHead(status, headers);
        if (sse) res.flushHeaders();

        // pipe(): per-chunk writes with real backpressure, so neither side is
        // ever accumulated whole in memory.
        upstreamRes.pipe(res);
        upstreamRes.on('error', () => {
          // Upstream died mid-body. Headers are already sent, so the only
          // truthful signal left is an incomplete response.
          res.destroy();
          finish();
        });
        res.on('close', finish);
        upstreamRes.on('end', finish);
      },
    );

    upstreamReq.on('error', () => {
      jsonError(res, 502, {
        error: `workflow package "${parsed.id}" is offline`,
        packageId: parsed.id,
        offline: true,
      });
      finish();
    });

    // Client went away before the upstream answered -- do not leak the
    // upstream socket waiting for a response nobody will read.
    res.on('close', () => {
      if (!settled) upstreamReq.destroy();
    });

    // Request body streams too: never read into a buffer first.
    req.pipe(upstreamReq);
    req.on('error', () => {
      upstreamReq.destroy();
      finish();
    });
  });
}
