/**
 * /ext reverse-proxy suite (apra-fleet-iywi.4.2) -- the lane-level check for
 * the proxy lane, and the last lane of the sprint.
 *
 * Everything here runs against the REAL http-transport server
 * (`createHttpTransport`) and REAL local upstream HTTP servers, all bound on
 * port 0 with the assigned port read back. Nothing is mocked, because the
 * properties under test are STREAMING properties: a mock upstream cannot
 * falsify "this byte reached the client before that byte was written", which
 * is the entire point of proxying workflow packages.
 *
 * HOW THE STREAMING CASES ARE MADE TO ACTUALLY FALSIFY
 * ----------------------------------------------------
 * A test that writes three SSE events, closes the upstream, then counts
 * three events at the client passes just as happily against a proxy that
 * buffered the whole stream and flushed it at close. So the streaming cases
 * here are written as HANDSHAKES instead: the upstream writes event N and
 * then WAITS for the client to have actually received event N before writing
 * event N+1. Against a buffering proxy the handshake can never advance, so
 * the test fails (on the bounded deadline below) instead of passing
 * vacuously. `upstreamEnded` is additionally asserted false at the moment
 * each event lands, which pins the "before the upstream closes" requirement
 * directly rather than by inference.
 *
 * DETERMINISM (this suite runs under the bounded runner on Linux, macOS and
 * Windows CI):
 *  - every server binds port 0 and reads its port back; no port is ever
 *    hardcoded, and the reserved staging ports are never touched;
 *  - there are NO fixed sleeps anywhere -- every wait is on a real event
 *    (a chunk arriving, a response ending, a socket closing). `withDeadline`
 *    is a FAILURE bound, not a sleep: nothing in a passing run ever waits
 *    for it to elapse;
 *  - every server is closed and every socket destroyed in afterEach, and
 *    the final test in this file asserts that nothing leaked;
 *  - HOME is redirected to a fresh temp dir per test, so the fleet key this
 *    suite mints and reads is never the real developer's.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createHttpTransport, type HttpTransportHandle } from '../src/services/http-transport.js';
import { getOrCreateKey } from '../src/services/jwt.js';
import { FLEET_DIR } from '../src/paths.js';
import { deriveUpstreamCredential } from '../src/console/proxy.js';
import { workflowPackageService } from '../src/services/workflow-packages.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

function noop(_server: McpServer): void {
  // no tools registered -- this suite never opens an /mcp session
}

/** Bound on how long any single handshake step may take before the test is
 *  declared failed. NOT a sleep: a passing run never reaches it (the whole
 *  file runs in ~100ms on a warm checkout). It exists so a buffering proxy
 *  fails with a readable message instead of hanging until the runner's
 *  wall-clock bound.
 *
 *  Deliberately BELOW vitest's 5s default per-test timeout so that this
 *  message -- which names the actual defect -- is what a future reader sees,
 *  rather than a generic "Test timed out in 5000ms". The two large-body
 *  cases pass an explicit, larger per-test timeout instead, so that a slow
 *  CI runner moving 8 MiB has headroom while a buffering proxy still trips
 *  this deadline first. */
const STEP_DEADLINE_MS = 4_000;

function withDeadline<T>(promise: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `timed out after ${STEP_DEADLINE_MS}ms waiting for: ${what}. ` +
        'If this fired on the SSE or large-body case, the proxy is buffering ' +
        'instead of streaming -- the handshake cannot advance until the ' +
        'previous chunk has actually reached the other side.',
      ));
    }, STEP_DEADLINE_MS);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// -----------------------------------------------------------------------------
// Lifecycle: fresh HOME per test; every server and socket tracked and torn down.
// -----------------------------------------------------------------------------
let realHome: string | undefined;
let tempHome: string;
const handles: HttpTransportHandle[] = [];
const upstreams: http.Server[] = [];
const sockets: net.Socket[] = [];
const registeredIds: string[] = [];

let idCounter = 0;
function uniqueId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${process.pid}-${idCounter}`;
}

beforeEach(async () => {
  // apra-fleet-iywi.8: this suite REGISTERS packages, which writes
  // workflow-packages.json under FLEET_DIR. Prove FLEET_DIR resolved to the
  // per-run isolated temp dir before writing anything, so a future
  // import-order break can never have this file write into a developer's
  // real ~/.apra-fleet/data.
  if (!process.env.APRA_FLEET_DATA_DIR || FLEET_DIR !== process.env.APRA_FLEET_DATA_DIR) {
    throw new Error(
      `Refusing to write under FLEET_DIR ("${FLEET_DIR}"): it does not match the ` +
      `isolated APRA_FLEET_DATA_DIR ("${process.env.APRA_FLEET_DATA_DIR}"), so it may ` +
      'resolve under the real home directory instead of a per-run isolated temp dir.',
    );
  }

  realHome = process.env.HOME;
  tempHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'console-proxy-home-'));
  process.env.HOME = tempHome;
});

afterEach(async () => {
  // Sockets first: an open keep-alive connection would otherwise keep
  // server.close() pending and leak the handle past this test.
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of upstreams.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const handle of handles.splice(0)) {
    try { await handle.close(); } catch { /* already down */ }
  }
  for (const id of registeredIds.splice(0)) {
    await workflowPackageService.unregister(id).catch(() => undefined);
  }
  process.env.HOME = realHome;
  await fsp.rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

/** Start the real console/MCP server on an OS-assigned port. */
async function startConsole(): Promise<HttpTransportHandle> {
  const handle = await createHttpTransport({ registerTools: noop, preferredPort: 0 });
  handle.httpServer.on('connection', (s) => sockets.push(s));
  handles.push(handle);
  return handle;
}

/** Start a real upstream on an OS-assigned port and return its baseUrl. */
async function startUpstream(handler: http.RequestListener): Promise<{ server: http.Server; port: number; baseUrl: string }> {
  const server = http.createServer(handler);
  server.on('connection', (s) => sockets.push(s));
  upstreams.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
  return { server, port, baseUrl: `http://127.0.0.1:${port}` };
}

/** A port nothing is listening on: bind one on 0, read it back, release it.
 *  Deterministic -- no guessed port number, and never a reserved one. */
async function closedPort(): Promise<number> {
  const server = http.createServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function registerPackage(id: string, baseUrl: string): Promise<void> {
  const result = await workflowPackageService.register({ id, baseUrl, apraFleetApi: '*' });
  expect(result).toEqual({ ok: true });
  registeredIds.push(id);
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function rawRequest(
  port: number,
  method: string,
  urlPath: string,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

// -----------------------------------------------------------------------------
// SSE pass-through -- the case the whole proxy exists for.
// -----------------------------------------------------------------------------

describe('/ext proxy: SSE pass-through', () => {
  it('delivers every event to the client BEFORE the upstream closes the stream (handshake -- fails against a buffering proxy)', async () => {
    const received: string[] = [];
    // Resolved by the CLIENT as each event lands; awaited by the UPSTREAM
    // before it writes the next one. A proxy that buffers can never advance
    // past event 1, so this case cannot pass vacuously.
    const landed = [deferred(), deferred(), deferred()];
    let upstreamEnded = false;
    /** upstreamEnded as observed at the instant each event reached the client. */
    const endedWhenReceived: boolean[] = [];

    const upstream = await startUpstream(async (req, res) => {
      expect(req.url).toBe('/stream');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      for (let i = 0; i < 3; i++) {
        res.write(`data: event-${i + 1}\n\n`);
        await withDeadline(landed[i].promise, `client to receive SSE event ${i + 1}`);
      }
      upstreamEnded = true;
      res.end();
    });

    const id = uniqueId('pkg-sse');
    await registerPackage(id, upstream.baseUrl);
    const console_ = await startConsole();

    const done = deferred();
    const req = http.request(
      { hostname: '127.0.0.1', port: console_.port, path: `/ext/${id}/stream`, method: 'GET' },
      (res) => {
        expect(res.statusCode).toBe(200);
        expect(String(res.headers['content-type'])).toContain('text/event-stream');
        res.on('data', (chunk: Buffer) => {
          for (const line of chunk.toString('utf8').split('\n\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            received.push(trimmed);
            endedWhenReceived.push(upstreamEnded);
            landed[received.length - 1]?.resolve();
          }
        });
        res.on('end', () => done.resolve());
      },
    );
    req.end();
    await withDeadline(done.promise, 'the proxied SSE response to end');

    expect(received).toEqual(['data: event-1', 'data: event-2', 'data: event-3']);
    // The load-bearing assertion: not one of the three arrived after close.
    expect(endedWhenReceived).toEqual([false, false, false]);
  });

  it('negotiates and applies no compression on an event-stream response, even when the client asks for gzip', async () => {
    let upstreamAcceptEncoding: string | undefined;
    const landed = deferred();

    const upstream = await startUpstream(async (req, res) => {
      upstreamAcceptEncoding = req.headers['accept-encoding'] as string | undefined;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: only-event\n\n');
      await withDeadline(landed.promise, 'client to receive the single SSE event');
      res.end();
    });

    const id = uniqueId('pkg-nogzip');
    await registerPackage(id, upstream.baseUrl);
    const console_ = await startConsole();

    const seen: string[] = [];
    const done = deferred<http.IncomingMessage>();
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: console_.port,
        path: `/ext/${id}/stream`,
        method: 'GET',
        // The client explicitly asks for compression; the proxy must not
        // pass that negotiation upstream on a stream it has to flush.
        headers: { 'accept-encoding': 'gzip, deflate, br' },
      },
      (res) => {
        res.on('data', (c: Buffer) => {
          seen.push(c.toString('utf8').trim());
          landed.resolve();
        });
        res.on('end', () => done.resolve(res));
      },
    );
    req.end();
    const res = await withDeadline(done.promise, 'the proxied event-stream response to end');

    // Not negotiated upstream...
    expect(upstreamAcceptEncoding).toBe('identity');
    expect(upstreamAcceptEncoding).not.toMatch(/gzip|deflate|br/);
    // ...and nothing compressed on the way back.
    expect(res.headers['content-encoding']).toBeUndefined();
    // Readable as plain text -- if anything had compressed it, this would be
    // gzip magic bytes rather than the event.
    expect(seen).toEqual(['data: only-event']);
  });
});

// -----------------------------------------------------------------------------
// Streaming bodies in both directions.
// -----------------------------------------------------------------------------

describe('/ext proxy: body streaming', () => {
  it('streams a large REQUEST body through without holding it whole (upstream sees the first chunk before the client finishes writing)', async () => {
    const CHUNK = Buffer.alloc(256 * 1024, 0x61); // 256 KiB, well past any socket buffer
    const CHUNKS = 32;                            // 8 MiB total
    const firstChunkSeen = deferred();
    let bytesUpstream = 0;

    const upstream = await startUpstream((req, res) => {
      req.on('data', (c: Buffer) => {
        bytesUpstream += c.length;
        firstChunkSeen.resolve();
      });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(String(bytesUpstream));
      });
    });

    const id = uniqueId('pkg-bigreq');
    await registerPackage(id, upstream.baseUrl);
    const console_ = await startConsole();
    const fleetKey = getOrCreateKey();

    const responded = deferred<string>();
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: console_.port,
        path: `/ext/${id}/upload`,
        method: 'POST',
        // non-GET /ext is guarded (auth-core lane) -- authenticate.
        headers: { ...bearer(fleetKey), 'content-type': 'application/octet-stream' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => responded.resolve(Buffer.concat(chunks).toString('utf8')));
      },
    );

    // Write ONE chunk, then block until the upstream has actually seen bytes.
    // A proxy that buffered the request body would never let this resolve,
    // because it would not forward anything until the client ended.
    req.write(CHUNK);
    await withDeadline(firstChunkSeen.promise, 'upstream to see the first request chunk before the client finished writing');

    for (let i = 1; i < CHUNKS; i++) req.write(CHUNK);
    req.end();

    const body = await withDeadline(responded.promise, 'the upload response');
    // Nothing lost or duplicated across the hop.
    expect(Number(body)).toBe(CHUNK.length * CHUNKS);
    // Explicit per-test timeout: headroom for 8 MiB on a slow CI runner,
    // while STEP_DEADLINE_MS above still trips first against a buffering proxy.
  }, 20_000);

  it('streams a large RESPONSE body through without holding it whole (client sees the first chunk before the upstream ends)', async () => {
    const CHUNK = Buffer.alloc(256 * 1024, 0x62);
    const CHUNKS = 32;
    const clientSawFirst = deferred();
    let upstreamEnded = false;
    let sawFirstBeforeEnd: boolean | null = null;

    const upstream = await startUpstream(async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.write(CHUNK);
      // Block until the client has actually received bytes.
      await withDeadline(clientSawFirst.promise, 'client to receive the first response chunk before the upstream ended');
      for (let i = 1; i < CHUNKS; i++) res.write(CHUNK);
      upstreamEnded = true;
      res.end();
    });

    const id = uniqueId('pkg-bigres');
    await registerPackage(id, upstream.baseUrl);
    const console_ = await startConsole();

    let bytesClient = 0;
    const done = deferred();
    const req = http.request(
      { hostname: '127.0.0.1', port: console_.port, path: `/ext/${id}/download`, method: 'GET' },
      (res) => {
        res.on('data', (c: Buffer) => {
          bytesClient += c.length;
          if (sawFirstBeforeEnd === null) sawFirstBeforeEnd = !upstreamEnded;
          clientSawFirst.resolve();
        });
        res.on('end', () => done.resolve());
      },
    );
    req.end();
    await withDeadline(done.promise, 'the large response to end');

    expect(sawFirstBeforeEnd).toBe(true);
    expect(bytesClient).toBe(CHUNK.length * CHUNKS);
    // Same headroom rationale as the request-side case above.
  }, 20_000);
});

// -----------------------------------------------------------------------------
// Error answers: 404 (no such package) vs 502 (there, but down).
// -----------------------------------------------------------------------------

describe('/ext proxy: unknown package vs unreachable upstream', () => {
  it('answers 404 for an unregistered package id', async () => {
    const console_ = await startConsole();
    const res = await rawRequest(console_.port, 'GET', `/ext/${uniqueId('never-registered')}/anything`);
    expect(res.status).toBe(404);
  });

  it('answers 502 with a package-offline body when a REGISTERED upstream is not listening', async () => {
    const dead = await closedPort();
    const id = uniqueId('pkg-dead');
    await registerPackage(id, `http://127.0.0.1:${dead}`);
    const console_ = await startConsole();

    const res = await rawRequest(console_.port, 'GET', `/ext/${id}/anything`);
    expect(res.status).toBe(502);
    expect(res.body).toMatch(/offline/i);
    expect(res.body).toContain(id);
  });

  it('keeps the two answers DISTINCT -- same request shape, same server, different status', async () => {
    const dead = await closedPort();
    const registeredButDown = uniqueId('pkg-down');
    await registerPackage(registeredButDown, `http://127.0.0.1:${dead}`);
    const console_ = await startConsole();

    const unknown = await rawRequest(console_.port, 'GET', `/ext/${uniqueId('pkg-unknown')}/x`);
    const down = await rawRequest(console_.port, 'GET', `/ext/${registeredButDown}/x`);

    expect(unknown.status).toBe(404);
    expect(down.status).toBe(502);
    expect(unknown.status).not.toBe(down.status);
    // "Does not exist" must not claim the package is offline.
    expect(unknown.body).not.toMatch(/offline/i);
  });
});

// -----------------------------------------------------------------------------
// Unusable baseUrl SCHEME -- the crash regression.
//
// A registered baseUrl whose scheme is not http(s) parses FINE as a WHATWG
// URL, so the proxy's parse-only check never saw it: `new URL('ftp://h/')`
// gives protocol 'ftp:' and the scheme-less `new URL('localhost:9000')` gives
// protocol 'localhost:' with an empty host. Both were then handed to
// http.request, which throws ERR_INVALID_PROTOCOL SYNCHRONOUSLY from inside
// an async request listener -- an unhandled rejection that killed the console
// process. Packages are third-party and registered at RUNTIME, so one of them
// must never be able to take the server down just by declaring a baseUrl.
//
// The bad entries are written through the REGISTRY STORE (the same
// `register()` every other case here uses, landing in the per-run isolated
// data dir), deliberately NOT by weakening the registry lane's validation:
// what is under test is the proxy's behaviour when it is handed such a value,
// however it got there.
// -----------------------------------------------------------------------------

describe('/ext proxy: unusable baseUrl scheme', () => {
  it('answers 502 naming the package id and the offending ftp:// baseUrl, and never contacts the upstream', async () => {
    // A REAL listening server, addressed with the WRONG scheme. Its host and
    // port are genuinely reachable, so "the upstream was never contacted" is
    // a falsifiable assertion here rather than a tautology about a dead port.
    let upstreamHits = 0;
    const upstream = await startUpstream((_req, res) => {
      upstreamHits += 1;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('must never be reached');
    });
    const badBaseUrl = `ftp://127.0.0.1:${upstream.port}`;
    // Parsability alone does not catch this -- pinned, because it is the
    // exact reason the pre-existing try/catch was insufficient.
    expect(() => new URL(badBaseUrl)).not.toThrow();
    expect(new URL(badBaseUrl).protocol).toBe('ftp:');

    const id = uniqueId('pkg-ftp');
    await registerPackage(id, badBaseUrl);
    const console_ = await startConsole();

    const res = await rawRequest(console_.port, 'GET', `/ext/${id}/anything`);
    expect(res.status).toBe(502);
    expect(res.body).toMatch(/offline/i);
    expect(res.body).toContain(id);
    expect(res.body).toContain(badBaseUrl);
    // Never reached http.request -- the listening server saw nothing.
    expect(upstreamHits).toBe(0);

    // And the console survived it: without the scheme branch the synchronous
    // ERR_INVALID_PROTOCOL throw took the process down, so a second request
    // is the direct regression check on the recorded crash.
    const after = await rawRequest(console_.port, 'GET', `/ext/${uniqueId('after-bad-scheme')}/x`);
    expect(after.status).toBe(404);
  });

  it("answers 502 for the scheme-less 'localhost:9000' baseUrl, which also parses as a valid URL", async () => {
    const badBaseUrl = 'localhost:9000';
    expect(() => new URL(badBaseUrl)).not.toThrow();
    expect(new URL(badBaseUrl).protocol).toBe('localhost:');
    expect(new URL(badBaseUrl).host).toBe('');

    const id = uniqueId('pkg-schemeless');
    await registerPackage(id, badBaseUrl);
    const console_ = await startConsole();

    const res = await rawRequest(console_.port, 'GET', `/ext/${id}/anything`);
    expect(res.status).toBe(502);
    expect(res.body).toMatch(/offline/i);
    expect(res.body).toContain(id);
    expect(res.body).toContain(badBaseUrl);

    const after = await rawRequest(console_.port, 'GET', `/ext/${uniqueId('after-schemeless')}/x`);
    expect(after.status).toBe(404);
  });

  it('keeps the bad-scheme 502 DISTINCT from the unreachable-upstream 502 -- same status, different diagnosis', async () => {
    const dead = await closedPort();
    const downId = uniqueId('pkg-down-scheme');
    await registerPackage(downId, `http://127.0.0.1:${dead}`);
    const badId = uniqueId('pkg-badscheme');
    const badBaseUrl = 'ftp://127.0.0.1:1/';
    await registerPackage(badId, badBaseUrl);
    const console_ = await startConsole();

    const down = await rawRequest(console_.port, 'GET', `/ext/${downId}/x`);
    const bad = await rawRequest(console_.port, 'GET', `/ext/${badId}/x`);

    expect(down.status).toBe(502);
    expect(bad.status).toBe(502);
    // "It is registered and reachable-looking but not answering" blames no
    // baseUrl...
    expect(down.body).not.toMatch(/baseUrl/i);
    expect(down.body).not.toContain('ftp:');
    // ...whereas "we refuse to dial this" names the value it refused.
    expect(bad.body).toMatch(/baseUrl/i);
    expect(bad.body).toContain(badBaseUrl);
  });
});

// -----------------------------------------------------------------------------
// The credential reaching the upstream -- the sprint's highest-risk property.
// -----------------------------------------------------------------------------

describe('/ext proxy: derived upstream credential', () => {
  it('sends a credential that is NOT the fleet key and DIFFERS per package id, and never leaks the console cookie', async () => {
    const captured = new Map<string, { authorization?: string; cookie?: string; all: http.IncomingHttpHeaders }>();
    const upstream = await startUpstream((req, res) => {
      const pkg = String(req.headers['x-apra-fleet-package-id'] ?? '');
      captured.set(pkg, {
        authorization: req.headers.authorization as string | undefined,
        cookie: req.headers.cookie as string | undefined,
        all: req.headers,
      });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });

    // Two DIFFERENT package ids pointing at the SAME upstream, so any
    // difference in the credential can only come from the id.
    const idA = uniqueId('pkg-cred-a');
    const idB = uniqueId('pkg-cred-b');
    await registerPackage(idA, upstream.baseUrl);
    await registerPackage(idB, upstream.baseUrl);
    const console_ = await startConsole();
    const fleetKey = getOrCreateKey();

    // Send the console's OWN credentials inbound: a cookie and a bearer
    // carrying the raw fleet key. Neither may be relayed to a package.
    const consoleCreds = {
      cookie: `apra_console_token=some-console-cookie-value`,
      ...bearer(fleetKey),
    };
    expect((await rawRequest(console_.port, 'GET', `/ext/${idA}/ping`, consoleCreds)).status).toBe(200);
    expect((await rawRequest(console_.port, 'GET', `/ext/${idB}/ping`, consoleCreds)).status).toBe(200);

    const seenA = captured.get(idA);
    const seenB = captured.get(idB);
    expect(seenA).toBeDefined();
    expect(seenB).toBeDefined();

    const tokenA = String(seenA!.authorization).replace(/^Bearer /, '');
    const tokenB = String(seenB!.authorization).replace(/^Bearer /, '');

    // (1) NOT byte-equal to the fleet key. Compared as raw bytes, which is
    // what "must not be the signing key" actually means.
    expect(Buffer.from(tokenA, 'utf8').equals(Buffer.from(fleetKey, 'utf8'))).toBe(false);
    expect(Buffer.from(tokenB, 'utf8').equals(Buffer.from(fleetKey, 'utf8'))).toBe(false);
    expect(tokenA).not.toBe(fleetKey);
    expect(tokenB).not.toBe(fleetKey);

    // (2) Differs per package id.
    expect(tokenA).not.toBe(tokenB);

    // (3) It is exactly the documented derivation -- reverting that
    // derivation in src/console/proxy.ts makes this fail.
    expect(tokenA).toBe(deriveUpstreamCredential(fleetKey, idA));
    expect(tokenB).toBe(deriveUpstreamCredential(fleetKey, idB));

    // (4) The raw key must not appear ANYWHERE in what the upstream saw --
    // not in a header we forgot about, not as a substring.
    const everythingUpstreamSaw = JSON.stringify([seenA!.all, seenB!.all]);
    expect(everythingUpstreamSaw).not.toContain(fleetKey);

    // (5) The console's own cookie is stripped, never relayed.
    expect(seenA!.cookie).toBeUndefined();
    expect(everythingUpstreamSaw).not.toContain('some-console-cookie-value');
  });

  it('the per-package credential is domain-separated from the console cookie, so a package cannot replay it as one', async () => {
    const captured: string[] = [];
    const upstream = await startUpstream((req, res) => {
      captured.push(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
      res.writeHead(200);
      res.end('ok');
    });

    const id = uniqueId('pkg-domain');
    await registerPackage(id, upstream.baseUrl);
    const console_ = await startConsole();

    // The console cookie, as a browser would receive it from GET /ui.
    const uiRes = await rawRequest(console_.port, 'GET', '/ui');
    const setCookie = uiRes.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieHeader).toBeDefined();
    const cookieToken = decodeURIComponent(/apra_console_token=([^;]+)/.exec(String(cookieHeader))![1]);

    // apra-fleet-iywi.11: GET /ext/* only carries the derived credential when
    // the GET itself is authenticated -- send the browser's own console
    // cookie, exactly as a real shell-loaded package request would.
    expect((await rawRequest(console_.port, 'GET', `/ext/${id}/ping`, {
      cookie: `apra_console_token=${encodeURIComponent(cookieToken)}`,
    })).status).toBe(200);
    const upstreamToken = captured[0];

    // Same primitive, same key, DIFFERENT label -- so the value handed to a
    // package is useless as a console cookie.
    expect(upstreamToken).not.toBe(cookieToken);

    // Prove it is actually rejected, not merely different: replaying the
    // package's credential as the console cookie must not open the guard.
    const replay = await rawRequest(console_.port, 'POST', '/api/workflow-packages/register', {
      cookie: `apra_console_token=${encodeURIComponent(upstreamToken)}`,
      'content-type': 'application/json',
    });
    expect(replay.status).toBe(401);
  });
});

// -----------------------------------------------------------------------------
// Location rewriting.
// -----------------------------------------------------------------------------

describe('/ext proxy: Location rewriting', () => {
  it('rewrites a root-relative upstream redirect back under /ext/<package id>, preserving the query', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(302, { Location: '/after-login?next=%2Fdash' });
      res.end();
    });
    const id = uniqueId('pkg-redir');
    await registerPackage(id, upstream.baseUrl);
    const console_ = await startConsole();

    const res = await rawRequest(console_.port, 'GET', `/ext/${id}/login`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/ext/${id}/after-login?next=%2Fdash`);
  });

  it('rewrites an ABSOLUTE same-origin upstream redirect under /ext/<package id>, and leaves a genuinely external one alone', async () => {
    const upstream = await startUpstream((req, res) => {
      const target = req.url === '/self'
        ? `http://127.0.0.1:${(upstream.server.address() as net.AddressInfo).port}/landed`
        : 'https://example.com/elsewhere';
      res.writeHead(302, { Location: target });
      res.end();
    });
    const id = uniqueId('pkg-abs');
    await registerPackage(id, upstream.baseUrl);
    const console_ = await startConsole();

    const self = await rawRequest(console_.port, 'GET', `/ext/${id}/self`);
    expect(self.headers.location).toBe(`/ext/${id}/landed`);

    // An external origin is NOT re-mounted -- doing so would make the
    // console an open redirector for arbitrary hosts.
    const external = await rawRequest(console_.port, 'GET', `/ext/${id}/external`);
    expect(external.headers.location).toBe('https://example.com/elsewhere');
  });
});

// -----------------------------------------------------------------------------
// The guard split the auth-core lane defined, now that /ext actually serves.
// -----------------------------------------------------------------------------

describe('/ext proxy: guarded/unguarded method split', () => {
  it('answers 401 for a non-GET /ext request with no credential, and never reaches the upstream', async () => {
    let upstreamHits = 0;
    const upstream = await startUpstream((_req, res) => {
      upstreamHits += 1;
      res.writeHead(200);
      res.end('ok');
    });
    const id = uniqueId('pkg-guard');
    await registerPackage(id, upstream.baseUrl);
    const console_ = await startConsole();

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await rawRequest(console_.port, method, `/ext/${id}/write`);
      expect(res.status).toBe(401);
    }
    // The load-bearing half: an unauthorised write is not merely reported as
    // 401, it never touches the package at all.
    expect(upstreamHits).toBe(0);
  });

  it('lets GET /ext/* through unguarded but WITHOUT a credential when unauthenticated, forwards a credential when authenticated, and lets an authenticated non-GET through to the upstream (apra-fleet-iywi.11)', async () => {
    const methodsSeen: string[] = [];
    const authorizationSeen: Array<string | undefined> = [];
    const upstream = await startUpstream((req, res) => {
      methodsSeen.push(String(req.method));
      authorizationSeen.push(req.headers.authorization as string | undefined);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`saw ${req.method}`);
    });
    const id = uniqueId('pkg-open');
    await registerPackage(id, upstream.baseUrl);
    const console_ = await startConsole();
    const fleetKey = getOrCreateKey();

    // Unauthenticated GET: still reaches the upstream (the read path stays
    // open)...
    const read = await rawRequest(console_.port, 'GET', `/ext/${id}/read`);
    expect(read.status).toBe(200);
    expect(read.body).toBe('saw GET');

    // Authenticated GET: reaches the upstream WITH the derived credential.
    const authedRead = await rawRequest(console_.port, 'GET', `/ext/${id}/read-authed`, bearer(fleetKey));
    expect(authedRead.status).toBe(200);

    const write = await rawRequest(console_.port, 'POST', `/ext/${id}/write`, bearer(fleetKey));
    expect(write.status).toBe(200);
    expect(write.body).toBe('saw POST');

    expect(methodsSeen).toEqual(['GET', 'GET', 'POST']);
    // ...but WITHOUT the derived credential -- the load-bearing half of this
    // decision. The authenticated GET and the authenticated POST both carry
    // one; the unauthenticated GET carries none at all.
    expect(authorizationSeen[0]).toBeUndefined();
    expect(authorizationSeen[1]).toBe(`Bearer ${deriveUpstreamCredential(fleetKey, id)}`);
    expect(authorizationSeen[2]).toBe(`Bearer ${deriveUpstreamCredential(fleetKey, id)}`);
  });

  it('closes the credentialed cross-origin GET: an unauthenticated, cross-origin-shaped GET reaches the upstream with zero credential headers, never with the derived credential (apra-fleet-iywi.11)', async () => {
    // "cross-origin-shaped" here means exactly what a third-party page's
    // <img>/<script>/fetch GET to this loopback port would look like: no
    // Authorization header, no console cookie -- nothing this process did not
    // put there itself. rawRequest() below never attaches either.
    const seenHeaders: http.IncomingHttpHeaders[] = [];
    const upstream = await startUpstream((req, res) => {
      seenHeaders.push(req.headers);
      res.writeHead(200);
      res.end('ok');
    });
    const id = uniqueId('pkg-cross-origin');
    await registerPackage(id, upstream.baseUrl);
    const console_ = await startConsole();
    const fleetKey = getOrCreateKey();

    // A plausible attacker-controlled Origin header changes nothing here --
    // the decision is keyed on whether a valid credential is present, not on
    // Origin/Referer, which a non-browser client (or a browser sending a
    // simple cross-origin GET) does not have to supply honestly anyway.
    const res = await rawRequest(console_.port, 'GET', `/ext/${id}/anything`, {
      origin: 'http://attacker.example',
    });
    expect(res.status).toBe(200);
    expect(seenHeaders).toHaveLength(1);
    expect(seenHeaders[0].authorization).toBeUndefined();

    // Reverting the forwardCredential gating in src/console/proxy.ts (i.e.
    // always attaching the derived credential regardless of
    // options.forwardCredential) makes this assertion fail: the upstream
    // would see `Bearer ${deriveUpstreamCredential(fleetKey, id)}` here too.
    expect(JSON.stringify(seenHeaders[0])).not.toContain(deriveUpstreamCredential(fleetKey, id));
  });

  it('answers 404 (never a crash) for a malformed percent-escape in the package id segment', async () => {
    const console_ = await startConsole();
    // '%zz' is not a valid escape -- decodeURIComponent throws on it. The
    // server must answer, and must still be alive afterwards.
    const res = await rawRequest(console_.port, 'GET', '/ext/%zz/anything');
    expect(res.status).toBe(404);

    const stillAlive = await rawRequest(console_.port, 'GET', '/health');
    expect(stillAlive.status).toBe(200);
  });
});

// -----------------------------------------------------------------------------
// Leak check -- runs last, asserts this file's own teardown actually works.
// -----------------------------------------------------------------------------

describe('/ext proxy: suite hygiene', () => {
  it('leaves no listening server and no open socket behind after a proxied request', async () => {
    const upstream = await startUpstream((_req, res) => { res.writeHead(200); res.end('ok'); });
    const id = uniqueId('pkg-hygiene');
    await registerPackage(id, upstream.baseUrl);
    const console_ = await startConsole();
    expect((await rawRequest(console_.port, 'GET', `/ext/${id}/ping`)).status).toBe(200);

    // Tear down exactly the way afterEach does, then prove it took effect.
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const server of upstreams.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const handle of handles.splice(0)) await handle.close();

    expect(upstream.server.listening).toBe(false);
    expect(console_.httpServer.listening).toBe(false);

    // Both ports are genuinely free again -- nothing is still bound.
    for (const port of [upstream.port, console_.port]) {
      await new Promise<void>((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
      });
    }
  });
});
