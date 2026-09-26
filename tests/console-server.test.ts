/**
 * Console seam dispatch (apra-fleet-v6t7.2.1).
 *
 * Exercises handleConsoleRequest directly -- what it claims, what it lets
 * fall through, and that GET /api/fleet/members answers the list_members
 * json payload produced IN-PROCESS (the tool handler is imported and called;
 * nothing here opens a socket back to the server or spawns a client).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleConsoleRequest, isConsolePath } from '../src/console/server.js';
import { getOrCreateKey } from '../src/services/jwt.js';
import { addAgent } from '../src/services/registry.js';
import { workflowPackageService } from '../src/services/workflow-packages.js';
import { createHttpTransport, type HttpTransportHandle } from '../src/services/http-transport.js';
import { listMembers } from '../src/tools/list-members.js';
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

// Home isolation for EVERY test in this file. authHeaders() and every GET
// /ui (which sets the console cookie) call getOrCreateKey(), which
// reads/mints <os.homedir()>/.apra-fleet/fleet.key (src/services/jwt.ts,
// resolved lazily per call). On win32 os.homedir() ignores HOME and reads
// USERPROFILE (then HOMEDRIVE+HOMEPATH), so a HOME-only override would
// silently touch the real developer key -- all four are pointed at a temp
// dir and restored afterwards. APRA_FLEET_DATA_DIR is already isolated per
// run by tests/setup.ts (FLEET_DIR is an eager module-load constant, so it
// cannot be re-pointed per test here).
const HOME_VARS = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'] as const;
let savedHomeVars: Record<string, string | undefined> = {};
let tempHome: string;

beforeEach(async () => {
  savedHomeVars = Object.fromEntries(HOME_VARS.map((k) => [k, process.env[k]]));
  tempHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'console-server-home-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  const parsed = path.parse(tempHome);
  process.env.HOMEDRIVE = parsed.root.replace(/[\\/]+$/, '');
  process.env.HOMEPATH = tempHome.slice(process.env.HOMEDRIVE.length);
});

afterEach(async () => {
  for (const k of HOME_VARS) {
    if (savedHomeVars[k] === undefined) delete process.env[k];
    else process.env[k] = savedHomeVars[k];
  }
  await fsp.rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

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
  beforeEach(() => {
    backupAndResetRegistry();
  });
  afterEach(() => {
    restoreRegistry();
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
  afterEach(() => {
    vi.restoreAllMocks();
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

// ---------------------------------------------------------------------------
// End to end over a REAL server (createHttpTransport) on an ephemeral port
// (preferredPort 0 -- never the reserved staging ports). The disk-mode
// static root is a temp fixture dist, so `npm run build:ui` is not a
// prerequisite. One test per console-seam assertion:
//   a. shell          b. asset Content-Type    c. SPA fallback
//   d. members json with a credential (== in-process list_members) + 401 without
//   e. non-console paths (/, /health) behave exactly as before
//   f. /mcp untouched -- proved by tests/http-transport.test.ts, unmodified.
// ---------------------------------------------------------------------------
interface WireResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function wireRequest(port: number, method: string, urlPath: string, headers: Record<string, string> = {}): Promise<WireResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('console seam end to end: real server, fixture shell dist', () => {
  const SHELL_HTML = '<!doctype html><html><body><div id="root">console-seam-e2e-shell</div></body></html>';
  let distDir: string;
  let handle: HttpTransportHandle | null = null;

  beforeEach(async () => {
    backupAndResetRegistry();
    distDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'console-seam-e2e-dist-'));
    fs.writeFileSync(path.join(distDir, 'index.html'), SHELL_HTML);
    fs.mkdirSync(path.join(distDir, 'assets'));
    fs.writeFileSync(path.join(distDir, 'assets', 'app-abc123.js'), 'console.log("app");');
    fs.writeFileSync(path.join(distDir, 'assets', 'app-abc123.css'), 'body{}');
    handle = await createHttpTransport({ registerTools: () => {}, preferredPort: 0, shellDistDir: distDir });
    expect([7601, 8801]).not.toContain(handle.port);
  });

  afterEach(async () => {
    if (handle) await handle.close().catch(() => {});
    handle = null;
    restoreRegistry();
    await fsp.rm(distDir, { recursive: true, force: true }).catch(() => {});
  });

  it('(a) GET /ui returns 200 with the shell index.html', async () => {
    for (const p of ['/ui', '/ui/']) {
      const res = await wireRequest(handle!.port, 'GET', p);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/html');
      expect(res.body).toBe(SHELL_HTML);
    }
  });

  it('(b) GET /ui/<asset> returns 200 with the right Content-Type', async () => {
    const js = await wireRequest(handle!.port, 'GET', '/ui/assets/app-abc123.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toBe('application/javascript');
    expect(js.body).toBe('console.log("app");');
    const css = await wireRequest(handle!.port, 'GET', '/ui/assets/app-abc123.css');
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toBe('text/css');
  });

  it('(c) GET /ui/some/unknown/route falls back to index.html with 200', async () => {
    const res = await wireRequest(handle!.port, 'GET', '/ui/some/unknown/route');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html');
    expect(res.body).toBe(SHELL_HTML);
  });

  it('(d) authenticated GET /api/fleet/members is 200 json matching in-process list_members; unauthenticated is 401', async () => {
    addAgent(makeTestLocalAgent({ id: 'e2e-member-a', friendlyName: 'e2e-alpha' }));
    addAgent(makeTestLocalAgent({ id: 'e2e-member-b', friendlyName: 'e2e-beta' }));

    const unauth = await wireRequest(handle!.port, 'GET', '/api/fleet/members');
    expect(unauth.status).toBe(401);
    expect(unauth.headers['content-type']).toBe('application/json');
    expect(JSON.parse(unauth.body)).toEqual({ error: 'unauthorized' });

    const authed = await wireRequest(handle!.port, 'GET', '/api/fleet/members', authHeaders());
    expect(authed.status).toBe(200);
    expect(authed.headers['content-type']).toBe('application/json');
    const inProcess = JSON.parse(await listMembers({ format: 'json' }));
    const overWire = JSON.parse(authed.body);
    expect(overWire).toEqual(inProcess);
    expect(overWire.members.map((m: { id: string }) => m.id).sort()).toEqual(['e2e-member-a', 'e2e-member-b']);

    // The console cookie handed out by GET /ui is the other accepted credential.
    const ui = await wireRequest(handle!.port, 'GET', '/ui');
    const raw = ui.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw[0] : String(raw)).split(';')[0];
    const viaCookie = await wireRequest(handle!.port, 'GET', '/api/fleet/members', { cookie });
    expect(viaCookie.status).toBe(200);
    expect(JSON.parse(viaCookie.body)).toEqual(inProcess);
  });

  it('(e) non-console paths behave exactly as before: GET / is the bare 404, /health is 200 json', async () => {
    const root = await wireRequest(handle!.port, 'GET', '/');
    expect(root.status).toBe(404);
    expect(root.body).toBe('');
    expect(root.headers['content-type']).toBeUndefined();
    expect(root.headers['set-cookie']).toBeUndefined();

    const health = await wireRequest(handle!.port, 'GET', '/health');
    expect(health.status).toBe(200);
    expect(health.headers['content-type']).toBe('application/json');
    expect(JSON.parse(health.body).status).toBe('ok');
    expect(health.headers['set-cookie']).toBeUndefined();

    const uix = await wireRequest(handle!.port, 'GET', '/uix');
    expect(uix.status).toBe(404);
    expect(uix.body).toBe('');
  });
});
