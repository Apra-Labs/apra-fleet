/**
 * Console auth guard matrix (apra-fleet-iywi.2.2) -- the lane-level check for
 * apra-fleet-iywi (One console token, workflow-package registry and the ext
 * reverse proxy). Exercises the REAL http-transport server (createHttpTransport),
 * not handleConsoleRequest directly, so the guard is proved end to end exactly
 * as a browser or CLI caller would see it.
 *
 * Every test in this file runs with HOME (and, on Windows, USERPROFILE)
 * pointed at a fresh temp directory (see beforeEach/afterEach below) so the
 * shared fleet key
 * (~/.apra-fleet/fleet.key, src/services/jwt.ts) this suite mints and reads
 * is NEVER the real developer's key. Every server started here is closed in
 * afterEach so nothing leaks under the bounded runner (scripts/run-all-tests.mjs).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { createHttpTransport, HttpTransportHandle } from '../src/services/http-transport.js';
import { getOrCreateKey } from '../src/services/jwt.js';
import { __registerTestRouteModule, type ConsoleRoute } from '../src/console/server.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { applyIsolatedHome } from './helpers/isolated-home.mjs';

function noop(_server: McpServer): void {
  // no tools registered -- this suite never opens an /mcp session
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function rawRequest(port: number, method: string, urlPath: string, headers: Record<string, string> = {}): Promise<RawResponse> {
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

function firstSetCookie(headers: http.IncomingHttpHeaders): string {
  const raw = headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) throw new Error('expected a Set-Cookie header, got none');
  return value;
}

// -----------------------------------------------------------------------------
// Test isolation: a fresh HOME (and therefore a fresh ~/.apra-fleet/fleet.key)
// per test, and every server started in a test closed in this file's afterEach.
// -----------------------------------------------------------------------------
let realHome: string | undefined;
let tempHome: string;
let restoreHome: (() => Promise<void>) | undefined;
const handles: HttpTransportHandle[] = [];

beforeEach(async () => {
  // Captured BEFORE applying the isolated home, purely so the
  // anti-vacuity test below can compare against wherever the real
  // developer/runner key would have lived.
  realHome = process.env.HOME;
  const home = await applyIsolatedHome('console-auth-home-');
  tempHome = home.tempHome;
  restoreHome = home.restore;
});

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    try { await handle.close(); } catch { /* ignore */ }
  }
  await restoreHome?.();
});

async function startServer(): Promise<HttpTransportHandle> {
  const handle = await createHttpTransport({ registerTools: noop, preferredPort: 0 });
  handles.push(handle);
  return handle;
}

function bearerHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function fetchConsoleCookie(port: number): Promise<string> {
  const res = await rawRequest(port, 'GET', '/ui');
  return firstSetCookie(res.headers).split(';')[0];
}

describe('console auth guard: the temp HOME isolation above is real, not vacuous', () => {
  it('getOrCreateKey() actually writes fleet.key under the temp HOME, not the real one', async () => {
    // Anti-vacuity for the file-header claim above: assert the fresh key this
    // test mints lands inside tempHome (proving process.env.HOME really
    // steered src/services/jwt.ts), and that nothing was written under the
    // real developer HOME this suite saved off in beforeEach.
    const fleetKey = getOrCreateKey();
    expect(fleetKey).toMatch(/^[0-9a-f]{64}$/);

    const tempKeyPath = path.join(tempHome, '.apra-fleet', 'fleet.key');
    const written = await fsp.readFile(tempKeyPath, 'utf8');
    expect(written.trim()).toBe(fleetKey);

    if (realHome) {
      const realKeyPath = path.join(realHome, '.apra-fleet', 'fleet.key');
      let realKeyBefore: string | null = null;
      try {
        realKeyBefore = await fsp.readFile(realKeyPath, 'utf8');
      } catch {
        realKeyBefore = null;
      }
      // The temp-home key must never equal whatever (if anything) sits at
      // the real path -- a collision here would mean this test read/wrote
      // the developer's actual key instead of the isolated temp one.
      if (realKeyBefore !== null) {
        expect(realKeyBefore.trim()).not.toBe(fleetKey);
      }
    }
  });
});

describe('console auth guard: credential x method matrix on /api/*', () => {
  it('GET /api/fleet/members: no credential -> 401', async () => {
    const handle = await startServer();
    const res = await rawRequest(handle.port, 'GET', '/api/fleet/members');
    expect(res.status).toBe(401);
  });

  it('GET /api/fleet/members: wrong token -> 401', async () => {
    const handle = await startServer();
    const res = await rawRequest(handle.port, 'GET', '/api/fleet/members', bearerHeader('not-the-real-token'));
    expect(res.status).toBe(401);
  });

  it('GET /api/fleet/members: correct fleet.key bearer -> 200', async () => {
    const handle = await startServer();
    const fleetKey = getOrCreateKey();
    const res = await rawRequest(handle.port, 'GET', '/api/fleet/members', bearerHeader(fleetKey));
    expect(res.status).toBe(200);
  });

  it('GET /api/fleet/members: correct console cookie -> 200', async () => {
    const handle = await startServer();
    const cookie = await fetchConsoleCookie(handle.port);
    const res = await rawRequest(handle.port, 'GET', '/api/fleet/members', { cookie });
    expect(res.status).toBe(200);
  });

  it('POST /api/fleet/members: no credential -> 401 (guard runs before the 405 method-not-allowed check)', async () => {
    const handle = await startServer();
    const res = await rawRequest(handle.port, 'POST', '/api/fleet/members');
    expect(res.status).toBe(401);
  });

  it('POST /api/fleet/members: wrong token -> 401', async () => {
    const handle = await startServer();
    const res = await rawRequest(handle.port, 'POST', '/api/fleet/members', bearerHeader('not-the-real-token'));
    expect(res.status).toBe(401);
  });

  it('POST /api/fleet/members: correct fleet.key bearer -> guard passes, 405 (no POST route registered)', async () => {
    const handle = await startServer();
    const fleetKey = getOrCreateKey();
    const res = await rawRequest(handle.port, 'POST', '/api/fleet/members', bearerHeader(fleetKey));
    expect(res.status).toBe(405);
  });

  it('POST /api/fleet/members: correct console cookie -> guard passes, 405', async () => {
    const handle = await startServer();
    const cookie = await fetchConsoleCookie(handle.port);
    const res = await rawRequest(handle.port, 'POST', '/api/fleet/members', { cookie });
    expect(res.status).toBe(405);
  });
});

describe('console auth guard: GET /ext/* is open, POST /ext/* is guarded', () => {
  it('GET /ext/* with no credential is NOT 401 (open, matching a normal reverse-proxy read path)', async () => {
    const handle = await startServer();
    const res = await rawRequest(handle.port, 'GET', '/ext/some-package/status');
    expect(res.status).not.toBe(401);
  });

  it('POST /ext/* with no credential IS 401 (guarded, even though no proxy is wired up yet)', async () => {
    const handle = await startServer();
    const res = await rawRequest(handle.port, 'POST', '/ext/some-package/status');
    expect(res.status).toBe(401);
  });

  it('POST /ext/* with the correct fleet.key bearer passes the guard (falls through to the seam 404, never a 500 -- no proxy registered yet)', async () => {
    const handle = await startServer();
    const fleetKey = getOrCreateKey();
    const res = await rawRequest(handle.port, 'POST', '/ext/some-package/status', bearerHeader(fleetKey));
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(500);
  });

  it('asserts the asymmetry directly: same path, same (absent) credential, different verdicts by method', async () => {
    const handle = await startServer();
    const getRes = await rawRequest(handle.port, 'GET', '/ext/same-path');
    const postRes = await rawRequest(handle.port, 'POST', '/ext/same-path');
    expect(getRes.status).not.toBe(401);
    expect(postRes.status).toBe(401);
  });
});

describe('console auth guard: /health and /mcp are untouched', () => {
  it('/health is reachable with no credential', async () => {
    const handle = await startServer();
    const res = await rawRequest(handle.port, 'GET', '/health');
    expect(res.status).toBe(200);
    const payload = JSON.parse(res.body) as { status: string };
    expect(payload.status).toBe('ok');
  });

  it('/mcp is reachable with no credential -- the console guard never widened onto it', async () => {
    const handle = await startServer();
    const res = await rawRequest(handle.port, 'GET', '/mcp');
    expect(res.status).not.toBe(401);
  });
});

describe('console auth guard: extensibility -- a route module appended at runtime is guarded automatically', () => {
  let unregister: (() => void) | null = null;

  afterEach(() => {
    if (unregister) {
      unregister();
      unregister = null;
    }
  });

  it('a TEST-ONLY route registered without any edit to src/console/server.ts is guarded exactly like the shipped routes', async () => {
    const handle = await startServer();
    const testRoutes: ConsoleRoute[] = [
      {
        method: 'GET',
        path: '/api/testonly/probe',
        handler: async (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        },
      },
    ];
    unregister = __registerTestRouteModule(testRoutes);

    const noCred = await rawRequest(handle.port, 'GET', '/api/testonly/probe');
    expect(noCred.status).toBe(401);

    const fleetKey = getOrCreateKey();
    const withCred = await rawRequest(handle.port, 'GET', '/api/testonly/probe', bearerHeader(fleetKey));
    expect(withCred.status).toBe(200);
    expect(JSON.parse(withCred.body)).toEqual({ ok: true });
  });

  it('unregistering removes the namespace from the guard -- it reverts to whatever handled the path before (here, the console 404)', async () => {
    const handle = await startServer();
    const testRoutes: ConsoleRoute[] = [
      { method: 'GET', path: '/api/testonly2/probe', handler: async (_req, res) => { res.writeHead(200); res.end('ok'); } },
    ];
    const cleanup = __registerTestRouteModule(testRoutes);
    cleanup();
    unregister = null;

    const fleetKey = getOrCreateKey();
    const res = await rawRequest(handle.port, 'GET', '/api/testonly2/probe', bearerHeader(fleetKey));
    // Not a console API namespace anymore -- falls through past handleConsoleRequest
    // entirely, to the transport's generic 404.
    expect(res.status).toBe(404);
  });
});

describe('console auth guard: GET /ui sets the console cookie', () => {
  it('carries HttpOnly, SameSite=Strict, Path=/, and a value distinct from the fleet key', async () => {
    const handle = await startServer();
    const res = await rawRequest(handle.port, 'GET', '/ui');
    const setCookie = firstSetCookie(res.headers);

    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).toMatch(/Path=\//);

    const cookieValue = decodeURIComponent(setCookie.split(';')[0].split('=')[1] ?? '');
    const fleetKey = getOrCreateKey();
    expect(cookieValue.length).toBeGreaterThan(0);
    expect(cookieValue).not.toBe(fleetKey);
  });
});

describe('console auth guard: fail-closed path normalisation', () => {
  it('a dot-segment path (/foo/../api/fleet/members) is guarded, not open', async () => {
    const handle = await startServer();
    const res = await rawRequest(handle.port, 'GET', '/foo/../api/fleet/members');
    expect(res.status).toBe(401);
  });

  it('the SAME dot-segment path with the correct bearer resolves to the real route (200), proving it is normalised to /api/fleet/members and not merely rejected outright', async () => {
    const handle = await startServer();
    const fleetKey = getOrCreateKey();
    const res = await rawRequest(handle.port, 'GET', '/foo/../api/fleet/members', bearerHeader(fleetKey));
    expect(res.status).toBe(200);
  });
});
