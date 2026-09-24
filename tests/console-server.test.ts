/**
 * Console seam dispatch (apra-fleet-v6t7.2.1).
 *
 * Exercises handleConsoleRequest directly -- what it claims, what it lets
 * fall through, and that GET /api/fleet/members answers the list_members
 * json payload produced IN-PROCESS (the tool handler is imported and called;
 * nothing here opens a socket back to the server or spawns a client).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type http from 'node:http';
import { handleConsoleRequest, isConsolePath } from '../src/console/server.js';
import { getOrCreateKey } from '../src/services/jwt.js';
import { addAgent } from '../src/services/registry.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

// Offline-safe: mirror tests/list-members.test.ts so no test here depends on
// a reachable member or a cloud workspace.
vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    testConnection: async () => ({ ok: false }),
    execCommand: async () => ({ stdout: '', stderr: '' }),
  }),
}));

vi.mock('../src/providers/index.js', () => ({
  getProvider: () => ({
    oauthCredentialFiles: () => [],
    authEnvVar: undefined,
  }),
}));

vi.mock('../src/services/cloud-sync.js', () => ({
  syncCloudCache: vi.fn(async () => ({ status: 'not-connected' })),
}));

interface FakeRes {
  res: http.ServerResponse;
  status: number | null;
  headers: Record<string, string>;
  /** Headers set via res.setHeader() (e.g. Set-Cookie on GET /ui), separate
   *  from the writeHead() headers bag above -- apra-fleet-iywi.2.1. */
  setHeaders: Record<string, string | string[]>;
  body: string;
  writes: number;
}

function fakeRes(): FakeRes {
  const captured: FakeRes = { res: null as unknown as http.ServerResponse, status: null, headers: {}, setHeaders: {}, body: '', writes: 0 };
  const stub = {
    headersSent: false,
    setHeader(name: string, value: string | string[]) {
      captured.setHeaders[name] = value;
      return stub;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      captured.headers = headers ?? {};
      captured.writes += 1;
      stub.headersSent = true;
      return stub;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) captured.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    },
  };
  captured.res = stub as unknown as http.ServerResponse;
  return captured;
}

function fakeReq(url: string, method = 'GET', headers?: Record<string, string>): http.IncomingMessage {
  return { url, method, headers: headers ?? {} } as unknown as http.IncomingMessage;
}

/** apra-fleet-iywi.2.1: /api/* is now guarded, so every request in this file
 *  that expects to reach a route handler (not the 401 itself) must carry the
 *  fleet-key bearer -- the same pattern tests/http-transport.test.ts already
 *  uses for its own admin-only /shutdown check. */
function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${getOrCreateKey()}` };
}

describe('console seam: handleConsoleRequest path ownership', () => {
  it('claims /ui, /ui/*, and /api/fleet/*', async () => {
    for (const url of ['/ui', '/ui/', '/ui/members', '/ui/assets/app.js', '/api/fleet/members', '/api/fleet/anything']) {
      const out = fakeRes();
      expect(await handleConsoleRequest(fakeReq(url), out.res, { shellDistDir: '/no/such/dist' })).toBe(true);
    }
  });

  it('declines every other path without touching the response', async () => {
    for (const url of ['/', '/mcp', '/mcp?member=x', '/health', '/shutdown', '/uix', '/api', '/api/other/thing']) {
      const out = fakeRes();
      expect(await handleConsoleRequest(fakeReq(url), out.res, {})).toBe(false);
      expect(out.status).toBeNull();
      expect(out.writes).toBe(0);
    }
  });

  it('isConsolePath agrees with the dispatcher', () => {
    expect(isConsolePath('/ui')).toBe(true);
    expect(isConsolePath('/ui/members')).toBe(true);
    expect(isConsolePath('/api/fleet/members')).toBe(true);
    expect(isConsolePath('/mcp')).toBe(false);
    expect(isConsolePath('/uix')).toBe(false);
  });

  it('a /ui request with no shell to serve answers the plain 404', async () => {
    const out = fakeRes();
    expect(await handleConsoleRequest(fakeReq('/ui/'), out.res, { shellDistDir: '/no/such/dist' })).toBe(true);
    expect(out.status).toBe(404);
  });

  it('routes /ui GETs through the injected static hook', async () => {
    const seen: string[] = [];
    const out = fakeRes();
    const handled = await handleConsoleRequest(fakeReq('/ui/members'), out.res, {
      shellDistDir: '/tmp/some-dist',
      serveStatic: (pathname, res, source) => {
        seen.push(`${pathname}|${source.shellDistDir}`);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html>shell</html>');
        return true;
      },
    });
    expect(handled).toBe(true);
    expect(seen).toEqual(['/ui/members|/tmp/some-dist']);
    expect(out.status).toBe(200);
    expect(out.body).toContain('shell');
  });
});

describe('console seam: GET /api/fleet/members', () => {
  beforeEach(() => backupAndResetRegistry());
  afterEach(() => restoreRegistry());

  it('answers 200 application/json with the list_members json payload, in-process', async () => {
    addAgent(makeTestLocalAgent({ id: 'member-a', friendlyName: 'alpha' }));
    addAgent(makeTestLocalAgent({ id: 'member-b', friendlyName: 'beta' }));

    const out = fakeRes();
    const handled = await handleConsoleRequest(fakeReq('/api/fleet/members', 'GET', authHeaders()), out.res, {});
    expect(handled).toBe(true);
    expect(out.status).toBe(200);
    expect(out.headers['Content-Type']).toBe('application/json');

    const payload = JSON.parse(out.body) as { total: number; server_version: string; members: Array<{ id: string; name: string }> };
    expect(payload.total).toBe(2);
    expect(typeof payload.server_version).toBe('string');
    expect(payload.members.map((m) => m.id).sort()).toEqual(['member-a', 'member-b']);
    expect(payload.members.map((m) => m.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('answers 405 json for a non-GET method on a registered route', async () => {
    const out = fakeRes();
    expect(await handleConsoleRequest(fakeReq('/api/fleet/members', 'POST', authHeaders()), out.res, {})).toBe(true);
    expect(out.status).toBe(405);
    expect(out.headers['Content-Type']).toBe('application/json');
  });

  it('answers 404 json for an unregistered /api/fleet path', async () => {
    const out = fakeRes();
    expect(await handleConsoleRequest(fakeReq('/api/fleet/nope', 'GET', authHeaders()), out.res, {})).toBe(true);
    expect(out.status).toBe(404);
    expect(JSON.parse(out.body)).toEqual({ error: 'not found' });
  });

  it('answers 401 json for GET /api/fleet/members with no credential at all', async () => {
    const out = fakeRes();
    expect(await handleConsoleRequest(fakeReq('/api/fleet/members'), out.res, {})).toBe(true);
    expect(out.status).toBe(401);
    expect(out.headers['Content-Type']).toBe('application/json');
  });
});
