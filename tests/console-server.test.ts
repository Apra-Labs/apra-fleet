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
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleConsoleRequest, isConsolePath } from '../src/console/server.js';
import { getOrCreateKey } from '../src/services/jwt.js';
import { addAgent } from '../src/services/registry.js';
import { workflowPackageService } from '../src/services/workflow-packages.js';
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

// apra-fleet-iywi.2.2 review finding: authHeaders() above calls
// getOrCreateKey(), which reads/mints ~/.apra-fleet/fleet.key
// (src/services/jwt.ts). Without a temp HOME this describe block would
// touch the real developer's key file exactly like tests/console-auth.test.ts
// was found to do before its own isolation was fixed. jwt.ts now resolves
// os.homedir() lazily on every call, so setting process.env.HOME here in
// beforeEach (before authHeaders() is ever invoked) is sufficient isolation.
let realHome: string | undefined;
let tempHome: string;

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
  beforeEach(async () => {
    backupAndResetRegistry();
    realHome = process.env.HOME;
    tempHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'console-server-home-'));
    process.env.HOME = tempHome;
  });
  afterEach(async () => {
    restoreRegistry();
    process.env.HOME = realHome;
    await fsp.rm(tempHome, { recursive: true, force: true }).catch(() => {});
  });

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

describe('console seam: dispatch is total (apra-fleet-iywi.10 / apra-fleet-iywi.13)', () => {
  let dispatchRealHome: string | undefined;
  let dispatchTempHome: string;

  beforeEach(async () => {
    dispatchRealHome = process.env.HOME;
    dispatchTempHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'console-dispatch-home-'));
    process.env.HOME = dispatchTempHome;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env.HOME = dispatchRealHome;
    await fsp.rm(dispatchTempHome, { recursive: true, force: true }).catch(() => {});
  });

  it('answers 500 -- never an escaping throw -- when a pre-handler path throws, and the same instance keeps serving afterwards', async () => {
    // Reproduces the recorded incident's SHAPE (a throw reached from inside
    // the /ext dispatch before any route handler runs), but not its exact
    // trigger: src/console/proxy.ts's own baseUrl-scheme guard
    // (apra-fleet-iywi.9, landed after this bead was filed) already turns a
    // bad-scheme registry entry into a 502 before ever reaching http.request,
    // so that specific reproduction can no longer exercise this backstop.
    // workflowPackageService.list() (src/services/workflow-packages.ts) is
    // the resolver the /ext dispatch calls SYNCHRONOUSLY, before any await
    // point, to resolve a package id to its baseUrl -- mocking it to throw is
    // the "injected resolver seam" alternative this task's description
    // explicitly allows, and reproduces the same "a pre-handler step throws
    // synchronously, from inside an async function, before any response is
    // written" shape the original incident had, without writing through (or
    // weakening) the registry lane's own validation.
    const boom = new Error('simulated registry read failure');
    const listSpy = vi.spyOn(workflowPackageService, 'list').mockImplementation(() => {
      throw boom;
    });

    const out = fakeRes();
    const handled = await handleConsoleRequest(fakeReq('/ext/some-package/anything'), out.res, {});
    expect(handled).toBe(true);
    expect(out.status).toBe(500);
    // Loud, not swallowed: the underlying error message reaches the body.
    expect(out.body).toContain('simulated registry read failure');

    listSpy.mockRestore();

    // The SAME dispatcher (no new server, no new process) still serves a
    // following request correctly. Before apra-fleet-iywi.10's fix, the
    // throw above would have escaped handleConsoleRequest's returned promise
    // entirely -- exactly the shape that killed the real process (an
    // unhandled rejection inside src/services/http-transport.ts's async
    // request listener, which awaits handleConsoleRequest with nothing else
    // guarding it).
    const out2 = fakeRes();
    expect(await handleConsoleRequest(fakeReq('/ext/some-package/anything'), out2.res, {})).toBe(true);
    expect(out2.status).toBe(404);
  });

  it('leaves the false-return contract intact: a non-console path still returns false with nothing written and no header set', async () => {
    const out = fakeRes();
    expect(await handleConsoleRequest(fakeReq('/not-a-console-path'), out.res, {})).toBe(false);
    expect(out.status).toBeNull();
    expect(out.writes).toBe(0);
    expect(Object.keys(out.setHeaders)).toHaveLength(0);
    expect(out.body).toBe('');
  });
});
