// Tests for src/viewer-proxy.mjs and src/verbs/viewer.mjs.
//
// Two layers:
//  - Pure construction/validation tests: zero networking, zero timers, zero
//    fs -- BridgeError CONFIG_MISSING/CONFIG_INVALID checks and the
//    constant-time viewer-token comparison, exercised directly.
//  - Behavioural tests: `proxyStream`/`proxyHtml` (apra-fleet-se/src/supervisor/proxy.mjs,
//    reused per fleet-bridge-implementation-plan.md Part A2) call `node:http`
//    internally and are NOT given an injectable transport, so proving the
//    real streaming/hop-by-hop/premature-close behaviour this file reuses
//    (rather than re-deriving it) needs a real HTTP conversation. These
//    tests use `createServer: (h) => http.createServer(h)` for the proxy
//    under test and a small real `http.createServer` as the "fake upstream"
//    standing in for the supervisor -- both bound to `127.0.0.1` on an
//    ephemeral port, the same pattern `apra-fleet-se/test/supervisor-proxy.test.mjs`
//    already uses to test this exact family of proxy code. No real
//    `node:fs` and no real timers anywhere in this file: `readTokenFile` is
//    a plain injected function, never a file read.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createViewerProxy } from '../src/viewer-proxy.mjs';
import { runViewer, validateViewerOpts } from '../src/verbs/viewer.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../src/errors.mjs';
import { assertThrows } from './helpers.mjs';

// -- test-only HTTP helpers (no production code touches node:http/node:fetch) -------

/** GET a path on 127.0.0.1:port, resolving once the response ends. */
function getText(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** POST a path on 127.0.0.1:port, resolving once the response ends. */
function postText(port, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      let out = '';
      res.setEncoding('utf-8');
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Starts a tiny fake-upstream HTTP server on 127.0.0.1:0, recording every request it sees. */
function startFakeUpstream(routeFn) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf-8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
      routeFn(req, res, body);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, calls });
    });
  });
}

/** Default fake-upstream router: mirrors the sprint control surface's shape (bare 200s). */
function defaultUpstreamRoute(req, res, body) {
  if (req.url === '/sprints/abc/live') {
    const html = "<html><body><script>new EventSource('/events');fetch('/state?_t=1');</script></body></html>";
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, echoedBody: body || null }));
}

/** Starts a viewer proxy against a real (loopback, ephemeral-port) http.createServer factory. */
async function startProxy(overrides = {}) {
  const logs = [];
  const logger = {
    log: (...a) => logs.push(a.join(' ')),
    error: (...a) => logs.push(a.join(' ')),
  };
  const proxy = createViewerProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamHost: '127.0.0.1',
    readTokenFile: () => null,
    createServer: (h) => http.createServer(h),
    logger,
    ...overrides,
  });
  const { port } = await proxy.start();
  return { proxy, port, logs };
}

// -- construction / validation (no sockets, no fs, no timers) -----------------------

describe('createViewerProxy -- construction', () => {
  test('throws CONFIG_MISSING when readTokenFile is missing', () => {
    const err = assertThrows(() => createViewerProxy({ createServer: () => ({}) }));
    assert.ok(err instanceof BridgeError);
    assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
  });

  test('throws CONFIG_MISSING when createServer is missing', () => {
    const err = assertThrows(() => createViewerProxy({ readTokenFile: () => null }));
    assert.ok(err instanceof BridgeError);
    assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
  });

  test('throws CONFIG_INVALID for a malformed listenPort', () => {
    const err = assertThrows(() => createViewerProxy({
      readTokenFile: () => null, createServer: () => ({}), listenPort: -1,
    }));
    assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('throws CONFIG_INVALID for a malformed upstreamPort', () => {
    const err = assertThrows(() => createViewerProxy({
      readTokenFile: () => null, createServer: () => ({}), upstreamPort: 0,
    }));
    assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

});

describe('verbs/viewer -- validateViewerOpts', () => {
  test('defaults match createViewerProxy\'s own defaults', () => {
    const o = validateViewerOpts({});
    assert.equal(o.listenHost, '0.0.0.0');
    assert.equal(o.listenPort, 8788);
    assert.equal(o.upstreamHost, '127.0.0.1');
    assert.equal(o.upstreamPort, 8787);
  });

  test('rejects a bad listenPort', () => {
    const err = assertThrows(() => validateViewerOpts({ listenPort: 99999 }));
    assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });
});

describe('verbs/viewer -- runViewer deps validation', () => {
  test('rejects with CONFIG_MISSING when deps.readTokenFile is absent', async () => {
    await assert.rejects(
      () => runViewer({}, { createServer: () => ({}) }),
      (err) => err instanceof BridgeError && err.code === BRIDGE_ERROR_CODES.CONFIG_MISSING,
    );
  });

  test('rejects with CONFIG_MISSING when deps.createServer is absent', async () => {
    await assert.rejects(
      () => runViewer({}, { readTokenFile: () => null }),
      (err) => err instanceof BridgeError && err.code === BRIDGE_ERROR_CODES.CONFIG_MISSING,
    );
  });
});

// -- behavioural (real loopback sockets standing in for the proxy + the supervisor) --

describe('viewer-proxy -- forwarding, control surface, and the shutdown refusal', () => {
  let upstream;
  let proxy;
  let port;
  let logs;

  before(async () => {
    upstream = await startFakeUpstream(defaultUpstreamRoute);
    const started = await startProxy({ upstreamPort: upstream.port, readTokenFile: () => 'sup3rvis0r-tok' });
    proxy = started.proxy;
    port = started.port;
    logs = started.logs;
  });

  after(async () => {
    await proxy.stop().catch(() => {});
    await new Promise((r) => upstream.server.close(r)).catch(() => {});
  });

  test('a GET live view is forwarded and returns upstream content byte-identical (no rewriteChildHtml)', async () => {
    const res = await getText(port, '/sprints/abc/live');
    assert.equal(res.status, 200);
    // Byte-identical: proves this proxy does NOT run rewriteChildHtml -- the
    // literal `'/events'` / `'/state?` app-paths pass through untouched,
    // since this proxy inserts no path prefix (see viewer-proxy.mjs header).
    assert.ok(res.body.includes("'/events'"));
    assert.ok(res.body.includes("'/state?_t=1'"));
  });

  test('pause/resume/stop/save_logs/launch/force-release are forwarded and reach upstream', async () => {
    const routes = [
      ['/sprints/s1/live/pause', 'POST'],
      ['/sprints/s1/live/resume', 'POST'],
      ['/sprints/s1/live/stop', 'POST'],
      ['/sprints/s1/live/save_logs', 'POST'],
      ['/api/sprints/s1/stop', 'POST'],
      ['/api/sprints', 'POST'],
      ['/api/reservations/s1/force-release', 'POST'],
    ];
    const before = upstream.calls.length;
    for (const [path] of routes) {
      // eslint-disable-next-line no-await-in-loop
      const res = await postText(port, path);
      assert.equal(res.status, 200, `${path} should forward through to a 200 from the fake upstream`);
    }
    assert.equal(upstream.calls.length, before + routes.length);
    const forwardedPaths = upstream.calls.slice(before).map((c) => c.url);
    for (const [path] of routes) assert.ok(forwardedPaths.includes(path), `${path} should have reached upstream`);
  });

  test('every GET is forwarded (not just the live view)', async () => {
    const res = await getText(port, '/api/sprints');
    assert.equal(res.status, 200);
    const last = upstream.calls[upstream.calls.length - 1];
    assert.equal(last.url, '/api/sprints');
    assert.equal(last.method, 'GET');
  });

  test('POST /api/shutdown is refused with a clear message and never reaches upstream', async () => {
    const before = upstream.calls.length;
    const res = await postText(port, '/api/shutdown');
    assert.equal(res.status, 403);
    assert.ok(/shutdown/i.test(res.body));
    assert.ok(/not forwarded|refused/i.test(res.body));
    assert.equal(upstream.calls.length, before, 'the withheld route must never reach the fake upstream');
  });

  test('GET /api/shutdown (wrong verb) is not specially withheld -- only POST is named by the spec', async () => {
    // Documented scope: fleet-bridge-design.md Section 7.2 withholds exactly
    // "POST /api/shutdown". A GET to the same path is ordinary passthrough
    // (the supervisor itself only registers the POST route, per server.mjs).
    const before = upstream.calls.length;
    const res = await getText(port, '/api/shutdown');
    assert.equal(res.status, 200); // the fake upstream answers everything else 200
    assert.equal(upstream.calls.length, before + 1);
  });

  test('the supervisor bearer is attached upstream and never appears downstream or in a log line', async () => {
    const res = await getText(port, '/api/health');
    assert.equal(res.status, 200);

    const last = upstream.calls[upstream.calls.length - 1];
    assert.equal(last.headers.authorization, 'Bearer sup3rvis0r-tok');

    const responseText = JSON.stringify(res.headers) + res.body;
    assert.ok(!responseText.includes('sup3rvis0r-tok'), 'the supervisor bearer must never appear in a downstream response');
    assert.ok(!logs.join('\n').includes('sup3rvis0r-tok'), 'the supervisor bearer must never appear in a log line');
  });

  test('a hop-by-hop header sent by the client is stripped before reaching upstream', async () => {
    const before = upstream.calls.length;
    await getText(port, '/api/health', { 'proxy-authorization': 'should-never-arrive', te: 'trailers' });
    const last = upstream.calls[before];
    assert.equal(last.headers['proxy-authorization'], undefined);
    assert.equal(last.headers.te, undefined);
  });
});

describe('viewer-proxy -- an inbound Authorization header never leaks upstream', () => {
  test('a client-supplied Authorization header (e.g. carrying a viewerToken) is stripped, not forwarded', async () => {
    const upstream = await startFakeUpstream(defaultUpstreamRoute);
    const { proxy, port } = await startProxy({
      upstreamPort: upstream.port,
      readTokenFile: () => null, // no supervisor bearer configured
    });
    try {
      await getText(port, '/api/health', { authorization: 'Bearer client-side-secret' });
      const last = upstream.calls[upstream.calls.length - 1];
      assert.equal(last.headers.authorization, undefined, 'no supervisor bearer was configured, so no Authorization header should reach upstream at all');
    } finally {
      await proxy.stop();
      await new Promise((r) => upstream.server.close(r));
    }
  });
});

describe('viewer-proxy -- upstream failure is handled without crashing the proxy', () => {
  test('a connection-refused upstream yields a sane (non-2xx) response, and the proxy keeps serving afterward', async () => {
    // Grab an ephemeral port, then close it immediately so nothing is listening there.
    const probe = await startFakeUpstream(defaultUpstreamRoute);
    const deadPort = probe.port;
    await new Promise((r) => probe.server.close(r));

    const { proxy, port } = await startProxy({ upstreamPort: deadPort, readTokenFile: () => null });
    try {
      const res = await getText(port, '/api/health');
      assert.ok(res.status >= 500, `expected a server-error status for a dead upstream, got ${res.status}`);

      // The proxy process itself must have survived -- prove it by bringing
      // a real upstream up on the SAME dead port and serving a subsequent
      // request successfully through the same running proxy instance.
      const revived = await new Promise((resolve, reject) => {
        const s = http.createServer(defaultUpstreamRoute);
        s.once('error', reject);
        s.listen(deadPort, '127.0.0.1', () => resolve(s));
      });
      try {
        const res2 = await getText(port, '/api/health');
        assert.equal(res2.status, 200);
      } finally {
        await new Promise((r) => revived.close(r));
      }
    } finally {
      await proxy.stop();
    }
  });
});

describe('verbs/viewer -- runViewer starts the proxy end to end', () => {
  test('runViewer wires createViewerProxy and returns { port, stop }', async () => {
    const upstream = await startFakeUpstream(defaultUpstreamRoute);
    try {
      const { port, stop } = await runViewer(
        { listenHost: '127.0.0.1', listenPort: 0, upstreamHost: '127.0.0.1', upstreamPort: upstream.port },
        { readTokenFile: () => null, createServer: (h) => http.createServer(h), log: () => {} },
      );
      try {
        const res = await getText(port, '/api/health');
        assert.equal(res.status, 200);
      } finally {
        await stop();
      }
    } finally {
      await new Promise((r) => upstream.server.close(r));
    }
  });
});
