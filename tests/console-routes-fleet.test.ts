/**
 * Console fleet routes (apra-fleet-9h9j.1.1).
 *
 * One route per client API method the shell pages need. Every case here is
 * dispatched through handleConsoleRequest -- the same entry point the HTTP
 * transport uses -- rather than by calling a route handler or a local-api
 * adapter directly, so the table registration and the seam's own 404/405
 * behaviour are exercised too.
 *
 * Every tool module the adapters import is vi.mock'ed (spreading the real
 * module so the zod schemas the routes validate against stay REAL), so no
 * test here touches a member, a credential store, or a shell.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type http from 'node:http';
import { Readable } from 'node:stream';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// --- tool module mocks -----------------------------------------------------
// importOriginal is spread back in on purpose: the routes import each tool's
// exported zod schema for body validation, and a bare factory would replace
// those schemas with undefined and turn every 400 case into a TypeError.
vi.mock('../src/tools/member-detail.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  memberDetail: vi.fn(),
}));

vi.mock('../src/tools/register-member.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerMember: vi.fn(),
}));

vi.mock('../src/tools/update-member.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateMember: vi.fn(),
}));

vi.mock('../src/tools/remove-member.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  removeMember: vi.fn(),
}));

vi.mock('../src/tools/setup-ssh-key.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setupSSHKey: vi.fn(),
}));

vi.mock('../src/tools/provision-auth.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  provisionAuth: vi.fn(),
}));

vi.mock('../src/tools/provision-vcs-auth.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  provisionVcsAuth: vi.fn(),
}));

vi.mock('../src/tools/revoke-vcs-auth.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  revokeVcsAuth: vi.fn(),
}));

vi.mock('../src/tools/compose-permissions.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  composePermissions: vi.fn(),
}));

vi.mock('../src/tools/update-agent-cli.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateAgentCli: vi.fn(),
}));

vi.mock('../src/tools/credential-store-set.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  credentialStoreSet: vi.fn(),
}));

vi.mock('../src/tools/credential-store-list.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  credentialStoreList: vi.fn(),
}));

vi.mock('../src/tools/credential-store-update.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  credentialStoreUpdate: vi.fn(),
}));

vi.mock('../src/tools/credential-store-delete.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  credentialStoreDelete: vi.fn(),
}));

vi.mock('../src/tools/setup-git-app.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setupGitApp: vi.fn(),
}));

vi.mock('../src/tools/check-status.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fleetStatus: vi.fn(),
}));

vi.mock('../src/tools/version.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  version: vi.fn(),
}));

vi.mock('../src/tools/execute-command.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  executeCommand: vi.fn(),
}));

import { handleConsoleRequest } from '../src/console/server.js';
import { fleetRoutes } from '../src/console/routes/fleet.js';
import { getOrCreateKey } from '../src/services/jwt.js';

import { memberDetail } from '../src/tools/member-detail.js';
import { registerMember } from '../src/tools/register-member.js';
import { updateMember } from '../src/tools/update-member.js';
import { removeMember } from '../src/tools/remove-member.js';
import { setupSSHKey } from '../src/tools/setup-ssh-key.js';
import { provisionAuth } from '../src/tools/provision-auth.js';
import { provisionVcsAuth } from '../src/tools/provision-vcs-auth.js';
import { revokeVcsAuth } from '../src/tools/revoke-vcs-auth.js';
import { composePermissions } from '../src/tools/compose-permissions.js';
import { updateAgentCli } from '../src/tools/update-agent-cli.js';
import { credentialStoreSet } from '../src/tools/credential-store-set.js';
import { credentialStoreList } from '../src/tools/credential-store-list.js';
import { credentialStoreUpdate } from '../src/tools/credential-store-update.js';
import { credentialStoreDelete } from '../src/tools/credential-store-delete.js';
import { setupGitApp } from '../src/tools/setup-git-app.js';
import { fleetStatus } from '../src/tools/check-status.js';
import { version } from '../src/tools/version.js';
import { executeCommand } from '../src/tools/execute-command.js';

// ---------------------------------------------------------------------------
// Test doubles for the node http request/response pair
// ---------------------------------------------------------------------------

export interface CapturedRes {
  res: http.ServerResponse;
  status: number | null;
  headers: Record<string, string>;
  body: string;
  writes: number;
}

export function fakeRes(): CapturedRes {
  const captured: CapturedRes = {
    res: null as unknown as http.ServerResponse,
    status: null,
    headers: {},
    body: '',
    writes: 0,
  };
  const stub = {
    headersSent: false,
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

/** A real Readable so the routes' body reader has a stream to drain -- the
 *  seam's older {url, method} object literal cannot carry a POST body.
 *
 *  Every /api/fleet/* request now passes through the console auth guard
 *  (apra-fleet-iywi.2.1), so every request built here carries the fleet-key
 *  bearer by default (see the HOME isolation in beforeEach/afterEach below,
 *  which keeps getOrCreateKey() away from the real developer key) -- pass
 *  headers explicitly to exercise the guard itself. */
export function fakeReq(url: string, method = 'GET', body?: string, headers?: Record<string, string>): http.IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')]);
  const req = stream as unknown as http.IncomingMessage & { url: string; method: string; headers: Record<string, string> };
  req.url = url;
  req.method = method;
  req.headers = headers ?? { authorization: `Bearer ${getOrCreateKey()}` };
  return req;
}

/** POST a JSON body through the console seam and return what was written. */
export async function post(path: string, body: unknown): Promise<CapturedRes> {
  const out = fakeRes();
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const handled = await handleConsoleRequest(fakeReq(path, 'POST', raw), out.res, {});
  expect(handled).toBe(true);
  return out;
}

// ---------------------------------------------------------------------------
// The route matrix
// ---------------------------------------------------------------------------

export interface RouteCase {
  /** Client API method name this route exists for. */
  method: string;
  path: string;
  /** The mocked tool handler the adapter calls. */
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  tool: () => any;
  /** A body that must reach the handler. */
  validBody: Record<string, unknown>;
  /** What the stubbed handler resolves to on the success case. */
  okResult: unknown;
  /** Assertion over the parsed 2xx body. */
  expectOk: (parsed: any) => void;
  /** A body (or raw string) that must be rejected before the handler runs. */
  badBody: unknown;
  /** Substring the 400 must contain -- the field it is complaining about.
   *  undefined = this route has no required field (see NO_REQUIRED_FIELD). */
  badField?: string;
}

const m = (fn: unknown) => () => fn as any;

const OK_TEXT = 'STUB-OK';
const expectText = (parsed: any) => expect(parsed.text).toBe(OK_TEXT);

/** Routes whose option shape has no required field at all (the client calls
 *  them with `options = {}`): "400 naming the missing field" is not
 *  expressible for them, so their bad-body case asserts the 400 they CAN
 *  produce -- a body that is not an object at all. */
export const NO_REQUIRED_FIELD = ['credentialStoreList', 'version'];

export const ROUTE_CASES: RouteCase[] = [
  {
    method: 'memberDetail',
    path: '/api/fleet/member-detail',
    tool: m(memberDetail),
    validBody: { member_id: 'm1' },
    okResult: '{"friendlyName":"box","status":"online"}',
    expectOk: (p) => expect(p.friendlyName).toBe('box'),
    badBody: { format: 'json' },
    badField: 'member_id or member_name',
  },
  {
    method: 'registerMember',
    path: '/api/fleet/register-member',
    tool: m(registerMember),
    validBody: { friendly_name: 'box', work_folder: '/home/box/repo', member_type: 'local' },
    okResult: OK_TEXT,
    expectOk: expectText,
    badBody: { work_folder: '/home/box/repo' },
    badField: 'friendly_name',
  },
  {
    method: 'updateMember',
    path: '/api/fleet/update-member',
    tool: m(updateMember),
    validBody: { member_id: 'm1', port: 2222 },
    okResult: OK_TEXT,
    expectOk: expectText,
    badBody: { port: 2222 },
    badField: 'member_id or member_name',
  },
  {
    method: 'removeMember',
    path: '/api/fleet/remove-member',
    tool: m(removeMember),
    validBody: { member_name: 'box', force: true },
    okResult: OK_TEXT,
    expectOk: expectText,
    badBody: { force: true },
    badField: 'member_id or member_name',
  },
  {
    method: 'setupSshKey',
    path: '/api/fleet/setup-ssh-key',
    tool: m(setupSSHKey),
    validBody: { member_name: 'box' },
    okResult: OK_TEXT,
    expectOk: expectText,
    badBody: {},
    badField: 'member_id or member_name',
  },
  {
    method: 'provisionLlmAuth',
    path: '/api/fleet/provision-llm-auth',
    tool: m(provisionAuth),
    validBody: { member_id: 'm1' },
    okResult: { text: OK_TEXT, structuredContent: { ok: true, reason: 'ok' } },
    expectOk: (p) => {
      expect(p.text).toBe(OK_TEXT);
      expect(p.structuredContent.reason).toBe('ok');
    },
    badBody: { api_key: 'sk-test' },
    badField: 'member_id or member_name',
  },
  {
    method: 'provisionVcsAuth',
    path: '/api/fleet/provision-vcs-auth',
    tool: m(provisionVcsAuth),
    validBody: { member_id: 'm1', provider: 'github', github_mode: 'pat', token: 'ghp_x' },
    okResult: { text: OK_TEXT, structuredContent: { ok: true, reason: 'ok' } },
    expectOk: (p) => expect(p.text).toBe(OK_TEXT),
    badBody: { member_id: 'm1' },
    badField: 'provider',
  },
  {
    method: 'revokeVcsAuth',
    path: '/api/fleet/revoke-vcs-auth',
    tool: m(revokeVcsAuth),
    validBody: { member_id: 'm1', provider: 'github' },
    okResult: OK_TEXT,
    expectOk: expectText,
    badBody: { member_id: 'm1' },
    badField: 'provider',
  },
  {
    method: 'composePermissions',
    path: '/api/fleet/compose-permissions',
    tool: m(composePermissions),
    validBody: { member_id: 'm1', role: 'doer' },
    okResult: OK_TEXT,
    expectOk: expectText,
    badBody: { role: 'doer' },
    badField: 'member_id or member_name',
  },
  {
    method: 'updateLlmCli',
    path: '/api/fleet/update-llm-cli',
    tool: m(updateAgentCli),
    validBody: { member_id: 'm1', install_if_missing: true },
    okResult: OK_TEXT,
    expectOk: expectText,
    badBody: { install_if_missing: 'yes-please' },
    badField: 'install_if_missing',
  },
  {
    method: 'credentialStoreSet',
    path: '/api/fleet/credential-store-set',
    tool: m(credentialStoreSet),
    validBody: { name: 'my_token', prompt: 'Paste the token' },
    okResult: {
      text: 'ignored by the route',
      structuredContent: { url: 'http://127.0.0.1:9999/secret/abc', expiresAt: '2026-01-01T00:00:00.000Z' },
    },
    expectOk: (p) => {
      expect(p.url).toBe('http://127.0.0.1:9999/secret/abc');
      expect(p.expiresAt).toBe('2026-01-01T00:00:00.000Z');
    },
    badBody: { prompt: 'Paste the token' },
    badField: 'name',
  },
  {
    method: 'credentialStoreList',
    path: '/api/fleet/credential-store-list',
    tool: m(credentialStoreList),
    validBody: {},
    okResult: JSON.stringify([
      { name: 'my_token', scope: 'session', network_policy: 'confirm', members: '*', expiry: 'none', created_at: 'x' },
    ]),
    expectOk: (p) => {
      expect(p.credentials).toHaveLength(1);
      expect(p.credentials[0].name).toBe('my_token');
    },
    badBody: '[]',
  },
  {
    method: 'credentialStoreUpdate',
    path: '/api/fleet/credential-store-update',
    tool: m(credentialStoreUpdate),
    validBody: { name: 'my_token', members: 'box', network_policy: 'deny' },
    okResult: 'Credential "my_token" updated.',
    expectOk: (p) => {
      expect(p.name).toBe('my_token');
      expect(p.members).toBe('box');
      expect(p.network_policy).toBe('deny');
    },
    badBody: { members: 'box' },
    badField: 'name',
  },
  {
    method: 'credentialStoreDelete',
    path: '/api/fleet/credential-store-delete',
    tool: m(credentialStoreDelete),
    validBody: { name: 'my_token' },
    okResult: 'Credential "my_token" deleted.',
    expectOk: (p) => expect(p.name).toBe('my_token'),
    badBody: {},
    badField: 'name',
  },
  {
    method: 'setupGitApp',
    path: '/api/fleet/setup-git-app',
    tool: m(setupGitApp),
    validBody: { app_id: '12345', private_key_path: '/keys/app.pem', installation_id: 42 },
    okResult: OK_TEXT,
    expectOk: expectText,
    badBody: { private_key_path: '/keys/app.pem', installation_id: 42 },
    badField: 'app_id',
  },
  {
    method: 'fleetStatus',
    path: '/api/fleet/status',
    tool: m(fleetStatus),
    validBody: {},
    okResult: '{"members":[]}',
    expectOk: (p) => expect(p.members).toEqual([]),
    badBody: { format: 'yaml' },
    badField: 'format',
  },
  {
    method: 'version',
    path: '/api/fleet/version',
    tool: m(version),
    validBody: {},
    okResult: OK_TEXT,
    expectOk: expectText,
    badBody: '"not-an-object"',
  },
  {
    method: 'executeCommand',
    path: '/api/fleet/execute-command',
    tool: m(executeCommand),
    validBody: { member_id: 'm1', command: 'echo hi' },
    okResult: { text: OK_TEXT, structuredContent: { exitCode: 0, stdout: 'hi', stderr: '' } },
    expectOk: (p) => {
      expect(p.text).toBe(OK_TEXT);
      expect(p.structuredContent.exitCode).toBe(0);
    },
    badBody: { member_id: 'm1' },
    badField: 'command',
  },
];

// -----------------------------------------------------------------------------
// Test isolation: every /api/fleet/* request now passes through the console
// auth guard (apra-fleet-iywi.2.1), which is keyed on the real fleet.key
// under HOME. Point HOME (and, on Windows, USERPROFILE -- os.homedir() never
// reads HOME there) at a fresh temp dir per test so getOrCreateKey() here is
// never the real developer's key.
// -----------------------------------------------------------------------------
let realHome: string | undefined;
let realUserProfile: string | undefined;
let tempHome: string;

beforeEach(async () => {
  vi.clearAllMocks();
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  tempHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'console-routes-fleet-home-'));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
});

afterEach(async () => {
  process.env.HOME = realHome;
  process.env.USERPROFILE = realUserProfile;
  await fsp.rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------

describe('console fleet routes: the table', () => {
  it('registers all 18 client-API routes plus the pre-existing members route', () => {
    const paths = fleetRoutes.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain('GET /api/fleet/members');
    for (const c of ROUTE_CASES) expect(paths).toContain(`POST ${c.path}`);
    expect(ROUTE_CASES).toHaveLength(18);
  });

  it('has no duplicate method+path entries', () => {
    const paths = fleetRoutes.map((r) => `${r.method} ${r.path}`);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe.each(ROUTE_CASES)('POST $path ($method)', (route) => {
  it('valid body -> 2xx json carrying the tool payload', async () => {
    route.tool().mockResolvedValue(route.okResult);
    const out = await post(route.path, route.validBody);
    expect(out.status).toBe(200);
    expect(out.headers['Content-Type']).toBe('application/json');
    route.expectOk(JSON.parse(out.body));
  });

  it('passes the validated body straight to the tool handler', async () => {
    route.tool().mockResolvedValue(route.okResult);
    await post(route.path, route.validBody);
    expect(route.tool()).toHaveBeenCalledTimes(1);
    const arg = (route.tool().mock.calls[0][0] ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(route.validBody)) {
      expect(arg[k]).toEqual(v);
    }
  });

  it('a tool isError result -> 4xx carrying the tool error text', async () => {
    const text = `STUB-TOOL-ERROR ${route.method}`;
    route.tool().mockResolvedValue({ text, isError: true });
    const out = await post(route.path, route.validBody);
    expect(out.status).toBeGreaterThanOrEqual(400);
    expect(out.status).toBeLessThan(500);
    expect(out.body).toContain(text);
  });

  // apra-fleet-9h9j.1.2: the isError case above is only half the contract --
  // a tool that THROWS must produce the same 4xx carrying the same text, not
  // the seam's catch-all 500.
  it('a tool that THROWS -> 4xx carrying the thrown message verbatim', async () => {
    const text = `STUB-THROWN-ERROR ${route.method}`;
    route.tool().mockRejectedValue(new Error(text));
    const out = await post(route.path, route.validBody);
    expect(out.status).toBeGreaterThanOrEqual(400);
    expect(out.status).toBeLessThan(500);
    expect(out.body).toContain(text);
  });

  it('a bad body -> 400 naming the offending field, without calling the tool', async () => {
    route.tool().mockResolvedValue(route.okResult);
    const out = await post(route.path, route.badBody);
    expect(out.status).toBe(400);
    if (route.badField) {
      expect(out.body).toContain(route.badField);
    } else {
      expect(NO_REQUIRED_FIELD).toContain(route.method);
      expect(out.body).toContain('invalid request body');
    }
    expect(route.tool()).not.toHaveBeenCalled();
  });
});

describe('console fleet routes: credential_store_set is never interactive', () => {
  it('pins return_url true and answers {url, expiresAt}', async () => {
    vi.mocked(credentialStoreSet).mockResolvedValue({
      text: 'ignored',
      structuredContent: { url: 'http://127.0.0.1:9999/secret/xyz', expiresAt: '2026-02-02T00:00:00.000Z' },
    });
    const out = await post('/api/fleet/credential-store-set', {
      name: 'my_token',
      prompt: 'Paste it',
      return_url: false,
    });
    expect(out.status).toBe(200);
    // return_url is pinned by the route, so the caller's false is overridden.
    expect(vi.mocked(credentialStoreSet).mock.calls[0][0].return_url).toBe(true);
    expect(JSON.parse(out.body)).toEqual({
      url: 'http://127.0.0.1:9999/secret/xyz',
      expiresAt: '2026-02-02T00:00:00.000Z',
    });
  });

  it('never blocks: a tool result with no url is a 4xx, not a passthrough of its prose', async () => {
    vi.mocked(credentialStoreSet).mockResolvedValue('Secret stored interactively.');
    const out = await post('/api/fleet/credential-store-set', { name: 'my_token', prompt: 'Paste it' });
    expect(out.status).toBe(422);
    expect(out.body).not.toContain('Secret stored interactively');
  });
});

describe('console fleet routes: seam behaviour is unchanged', () => {
  it('an unknown /api/fleet/ path is still a 404 claimed by the console', async () => {
    const out = fakeRes();
    expect(await handleConsoleRequest(fakeReq('/api/fleet/no-such-route', 'POST', '{}'), out.res, {})).toBe(true);
    expect(out.status).toBe(404);
  });

  it('a registered path with the wrong method is a 405', async () => {
    const out = fakeRes();
    expect(await handleConsoleRequest(fakeReq('/api/fleet/version', 'GET'), out.res, {})).toBe(true);
    expect(out.status).toBe(405);
  });

  // apra-fleet-9h9j.1.2: widening the /api/fleet/ table must not widen what
  // the console CLAIMS. A path outside /api/fleet/ and /ui is still declined
  // with nothing written, so the transport's own routing continues.
  it.each([
    '/',
    '/mcp',
    '/health',
    '/shutdown',
    '/api',
    '/api/other/thing',
    '/uix',
    '/api/fleetx/version',
  ])('declines %s without touching the response', async (url) => {
    const out = fakeRes();
    expect(await handleConsoleRequest(fakeReq(url, 'POST', '{}'), out.res, {})).toBe(false);
    expect(out.status).toBeNull();
    expect(out.writes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// apra-fleet-9h9j.1.2: no credential route may leak a secret VALUE.
//
// Each stub below deliberately carries the sentinel in a field the route's
// whitelist has to drop (tool prose, or an extra key alongside the metadata).
// The stub payload itself is asserted to contain the sentinel first, so a
// future stub that quietly stops carrying it cannot make these vacuous.
// ---------------------------------------------------------------------------

const SENTINEL = 'SENTINEL-SECRET-DO-NOT-LEAK';

interface CredentialLeakCase {
  path: string;
  tool: () => any;
  body: Record<string, unknown>;
  stubResult: unknown;
}

const CREDENTIAL_LEAK_CASES: CredentialLeakCase[] = [
  {
    path: '/api/fleet/credential-store-set',
    tool: m(credentialStoreSet),
    body: { name: 'my_token', prompt: 'Paste it' },
    stubResult: {
      text: `Stored "my_token" = ${SENTINEL}`,
      structuredContent: {
        url: 'http://127.0.0.1:9999/secret/abc',
        expiresAt: '2026-03-03T00:00:00.000Z',
        value: SENTINEL,
        plaintext: SENTINEL,
      },
    },
  },
  {
    path: '/api/fleet/credential-store-list',
    tool: m(credentialStoreList),
    body: {},
    stubResult: JSON.stringify([
      {
        name: 'my_token',
        scope: 'session',
        network_policy: 'confirm',
        members: '*',
        expiry: 'none',
        created_at: '2026-01-01',
        value: SENTINEL,
        plaintext: SENTINEL,
      },
    ]),
  },
  {
    path: '/api/fleet/credential-store-update',
    tool: m(credentialStoreUpdate),
    body: { name: 'my_token', members: 'box' },
    stubResult: `Credential "my_token" updated. value=${SENTINEL}`,
  },
  {
    path: '/api/fleet/credential-store-delete',
    tool: m(credentialStoreDelete),
    body: { name: 'my_token' },
    stubResult: `Credential "my_token" (${SENTINEL}) deleted.`,
  },
];

describe.each(CREDENTIAL_LEAK_CASES)('credential route $path is secret-free', (leak) => {
  it('never serialises a secret value the tool handed it', async () => {
    const stubText = typeof leak.stubResult === 'string' ? leak.stubResult : JSON.stringify(leak.stubResult);
    // The stub really is carrying a secret -- otherwise the assertion below
    // would pass for the wrong reason.
    expect(stubText).toContain(SENTINEL);

    leak.tool().mockResolvedValue(leak.stubResult);
    const out = await post(leak.path, leak.body);

    expect(out.status).toBe(200);
    expect(out.body).not.toContain(SENTINEL);
    // Same check over the reparsed-and-reserialised body, so a secret hidden
    // behind an escape sequence cannot slip past the raw string search.
    expect(JSON.stringify(JSON.parse(out.body))).not.toContain(SENTINEL);
  });

  it('answers only whitelisted credential metadata', async () => {
    leak.tool().mockResolvedValue(leak.stubResult);
    const out = await post(leak.path, leak.body);
    const parsed = JSON.parse(out.body);
    const allowed = new Set([
      'name',
      'scope',
      'network_policy',
      'members',
      'expiry',
      'created_at',
      'ttl_seconds',
      'url',
      'expiresAt',
      'credentials',
    ]);
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          expect(allowed).toContain(key);
          walk(child);
        }
      }
    };
    walk(parsed);
  });
});
