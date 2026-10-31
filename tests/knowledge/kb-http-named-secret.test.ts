import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

// Named-secret token for the HTTP KB provider (kb_setup token {{secret.NAME}}
// stored as token_ref): the provider looks the secret up on every request,
// retries once on 401 after re-reading it, and otherwise raises
// E-KB-HTTP-AUTH -- with captures kept in the offline queue and a MEMBER
// session's CONFIRMED reads still served from its checkout bible.
//
// Real pieces only: a local stub KB server whose accepted token the test
// changes, the real credential store (credentials.json under the per-run
// APRA_FLEET_DATA_DIR from tests/setup.ts), the real KB config file and
// getKbProviders, the real kb_* handlers, and for the member case the real
// HTTP transport with an MCP client.
//
// Every secret value starts with CANARY, so one substring check proves no
// value leaked into tool results, errors, logs, stderr or the environment.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { HttpKbProvider, KbHttpAuthError } from '../../src/services/knowledge/http-provider.js';
import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { KB_CONFIG_PATH } from '../../src/services/knowledge/kb-config.js';
import { getKbHttpAuthState, resetKbHttpAuthState } from '../../src/services/knowledge/kb-http-auth-state.js';
import { credentialSet, credentialDelete, lookupServerSecretMeta } from '../../src/services/credential-store.js';
import { encryptPassword } from '../../src/utils/crypto.js';
import { FLEET_DIR } from '../../src/paths.js';
import { getActiveLogFile } from '../../src/utils/log-helpers.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { createHttpTransport, type HttpTransportHandle } from '../../src/services/http-transport.js';
import { registerAllTools } from '../../src/services/tool-registry.js';
import { addAgent, getAllAgents } from '../../src/services/registry.js';
import { memberBiblePath, resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry, memberSecretRequestInit } from '../test-helpers.js';
import { isolateGitConfig } from './isolate-git-config.js';

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const NAME = `KB_NAMED_SECRET_${RUN.replace(/-/g, '_')}`;
const CANARY = `zq-canary-kbtok-${RUN}`;
const TOKEN_A = `${CANARY}-A`;
const TOKEN_A2 = `${CANARY}-A2`;
const TOKEN_B = `${CANARY}-B`;
const TOKEN_C = `${CANARY}-C`;
const ORIGIN = `https://example.test/kb-named-secret-${RUN}.git`;

// ---------------------------------------------------------------------------
// Stub KB server
// ---------------------------------------------------------------------------

interface StubRequest { method: string; path: string; authorized: boolean }

const stub = {
  accepted: TOKEN_A,
  requests: [] as StubRequest[],
  captures: [] as KBEntryInput[],
  /** Runs when a request is about to be answered 401 (before the response). */
  on401: undefined as (() => void) | undefined,
  /** Echo the Authorization header back in the 401 body (a badly behaved server). */
  echoAuth: false,
};

let server: http.Server;
let kbUrl: string;

function startStub(): Promise<void> {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      const pathname = (req.url ?? '').split('?')[0];
      const authorized = req.headers.authorization === `Bearer ${stub.accepted}`;
      stub.requests.push({ method: req.method ?? '', path: pathname, authorized });
      res.setHeader('Content-Type', 'application/json');
      if (!authorized) {
        stub.on401?.();
        res.writeHead(401);
        res.end(JSON.stringify({ error: stub.echoAuth ? `Unauthorized: ${req.headers.authorization}` : 'Unauthorized' }));
        return;
      }
      if (pathname === '/api/kb/capture') {
        stub.captures.push(JSON.parse(body) as KBEntryInput);
        res.writeHead(201);
        res.end(JSON.stringify({ id: `srv-${stub.captures.length}`, audn_decision: 'add' }));
      } else if (pathname === '/api/kb/query') {
        res.writeHead(200);
        res.end(JSON.stringify({ results: [], total: 0, l1_only: false }));
      } else if (pathname === '/api/kb/invalidate') {
        res.writeHead(200);
        res.end(JSON.stringify({ invalidated: 1 }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    kbUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    resolve();
  }));
}

const count = (p: string) => stub.requests.filter(r => r.path === p).length;

// ---------------------------------------------------------------------------
// Repo, config and output capture
// ---------------------------------------------------------------------------

let scratch: string;
let repo: string;
let savedConfig: string | null;
let restoreGitConfig: () => void;
const stderrChunks: string[] = [];
const consoleLines: string[] = [];
const toolTexts: string[] = [];
const errorTexts: string[] = [];

function gitRepo(name: string): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'gear.ts'), 'export const gear = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', ORIGIN], { cwd: dir });
  return dir;
}

function writeConfig(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify({ provider: 'http', url: kbUrl, ...cfg }, null, 2));
}

const refConfig = () => writeConfig({ token_ref: `{{secret.${NAME}}}` });
const setSecret = (value: string, ttlSeconds?: number) => credentialSet(NAME, value, true, 'allow', '*', ttlSeconds);

async function provider(): Promise<HttpKbProvider> {
  const p = (await getKbProviders(repo)).project;
  expect(p).toBeInstanceOf(HttpKbProvider);
  return p as HttpKbProvider;
}

function entry(title: string): KBEntryInput {
  return {
    type: 'learning', title, summary: `${title} -- summary for the named secret suite`,
    content: `${title} content`, source_files: ['src/gear.ts'], symbols: [], tags: [],
    content_hash: '', content_hash_type: 'sha256', flagged_for_review: false,
    author: 'test', source: 'session', confidence: 'INFERRED',
  };
}

async function expectAuthError(p: Promise<unknown>, reason: string): Promise<KbHttpAuthError> {
  let caught: unknown;
  try { await p; } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(KbHttpAuthError);
  const err = caught as KbHttpAuthError;
  errorTexts.push(err.message, err.stack ?? '');
  expect(err.code).toBe('E-KB-HTTP-AUTH');
  expect(err.reason).toBe(reason);
  expect(err.secretName).toBe(NAME);
  expect(err.message).toContain('E-KB-HTTP-AUTH');
  expect(err.message).toContain(`"${NAME}"`);
  expect(err.message).toContain(`apra-fleet secret --set ${NAME} --persist -y`);
  return err;
}

beforeAll(async () => {
  restoreGitConfig = isolateGitConfig();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-named-secret-'));
  repo = gitRepo('repo');
  savedConfig = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH, 'utf-8') : null;
  await startStub();
  const origWrite = process.stderr.write.bind(process.stderr);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    stderrChunks.push(String(chunk));
    return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write);
  const origError = console.error.bind(console);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleLines.push(args.map(String).join(' '));
    origError(...args);
  });
});

beforeEach(() => {
  stub.accepted = TOKEN_A;
  stub.requests.length = 0;
  stub.captures.length = 0;
  stub.on401 = undefined;
  stub.echoAuth = false;
  resetKbProviders();
  resetKbHttpAuthState();
  setSecret(TOKEN_A);
  refConfig();
});

afterEach(() => {
  credentialDelete(NAME);
});

afterAll(async () => {
  resetKbProviders();
  vi.restoreAllMocks();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (savedConfig === null) fs.rmSync(KB_CONFIG_PATH, { force: true });
  else fs.writeFileSync(KB_CONFIG_PATH, savedConfig);
  fs.rmSync(scratch, { recursive: true, force: true });
  restoreGitConfig();
});

// ---------------------------------------------------------------------------

describe('HTTP KB provider with a named-secret token', () => {
  it('1. a secret update takes effect on the next call, same provider instance, no restart', async () => {
    const p = await provider();
    expect((await p.capture(entry('Gear one'))).id).toBe('srv-1');

    setSecret(TOKEN_A2);
    stub.accepted = TOKEN_A2;
    const again = await provider();
    expect(again).toBe(p);
    expect((await p.capture(entry('Gear two'))).id).toBe('srv-2');
    expect(count('/api/kb/capture')).toBe(2);
    expect(stub.requests.every(r => r.authorized)).toBe(true);
    expect(getKbHttpAuthState(kbUrl).lastSuccessAt).toBeDefined();
    expect(getKbHttpAuthState(kbUrl).lastRejectedAt).toBeUndefined();
  });

  it('2. server rotated, secret stale: E-KB-HTTP-AUTH, capture queued and kept; one retry per 401; updated secret drains the queue', async () => {
    const p = await provider();
    stub.accepted = TOKEN_B;

    const err = await expectAuthError(p.capture(entry('Queued gear')), 'rejected');
    expect(err.queued).toBe(true);
    expect(err.message).toContain('queued offline');
    expect(count('/api/kb/capture')).toBe(2); // first try + exactly one retry
    expect(p.offlineQueue).toHaveLength(1);
    expect(getKbHttpAuthState(kbUrl).lastRejectedAt).toBeDefined();

    // A further call flushes first: the auth failure stops the flush and the
    // queued capture stays (it is not dropped).
    stub.requests.length = 0;
    await expectAuthError(p.query({ query: 'gear' }), 'rejected');
    expect(p.offlineQueue).toHaveLength(1);
    expect(count('/api/kb/capture')).toBe(2); // the queued capture: try + retry
    expect(count('/api/kb/query')).toBe(2);
    expect(stub.captures).toHaveLength(0);

    setSecret(TOKEN_B);
    stub.requests.length = 0;
    expect((await p.capture(entry('After rotation'))).audn_decision).toBe('add');
    expect(p.offlineQueue).toHaveLength(0);
    expect(stub.captures.map(c => c.title)).toEqual(['Queued gear', 'After rotation']);
    expect(stub.requests.every(r => r.authorized)).toBe(true);
  });

  it('3. 401 on the first try, secret updated before the retry: the retry succeeds with no error', async () => {
    const p = await provider();
    stub.accepted = TOKEN_C;
    stub.on401 = () => { setSecret(TOKEN_C); stub.on401 = undefined; };
    expect((await p.capture(entry('Refreshed mid call'))).id).toBe('srv-1');
    expect(count('/api/kb/capture')).toBe(2);
    expect(stub.requests.map(r => r.authorized)).toEqual([false, true]);
    expect(p.offlineQueue).toHaveLength(0);
  });

  it('4a. missing secret: E-KB-HTTP-AUTH (missing) with zero requests sent', async () => {
    credentialDelete(NAME);
    const p = await provider();
    const err = await expectAuthError(p.capture(entry('No secret')), 'missing');
    expect(err.message).toContain('does not exist');
    await expectAuthError(p.query({ query: 'gear' }), 'missing');
    await expectAuthError(p.invalidate(['src/gear.ts']), 'missing');
    expect(stub.requests).toHaveLength(0);
    expect(p.offlineQueue).toHaveLength(2); // capture + invalidate kept
  });

  it('4b. expired secret: E-KB-HTTP-AUTH (expired) with zero requests sent; the record is kept', async () => {
    setSecret(TOKEN_A, -60);
    const p = await provider();
    const err = await expectAuthError(p.capture(entry('Expired secret')), 'expired');
    expect(err.message).toContain('expired at');
    await expectAuthError(p.context(['src/gear.ts']), 'expired');
    expect(stub.requests).toHaveLength(0);
    expect(lookupServerSecretMeta(NAME).status).toBe('expired');
  });

  it('4c. unreadable credential store: E-KB-HTTP-AUTH (unreadable) with a fixed message, no file content quoted', async () => {
    const credPath = path.join(process.env.APRA_FLEET_DATA_DIR ?? FLEET_DIR, 'credentials.json');
    const saved = fs.readFileSync(credPath, 'utf-8');
    const marker = `zqcipher${RUN.replace(/-/g, '')}`;
    try {
      // JSON.parse quotes the start of the source in its error message.
      fs.writeFileSync(credPath, `${marker} not json`);
      const p = await provider();
      const err = await expectAuthError(p.query({ query: 'gear' }), 'unreadable');
      expect(err.message).toContain('could not be read');
      expect(err.message).not.toContain(marker);
      expect(err.message).not.toMatch(/not valid JSON|Unexpected token/);
      expect(stub.requests).toHaveLength(0);
    } finally {
      fs.writeFileSync(credPath, saved);
    }
  });

  it('6a. through the kb_* handlers: E-KB-HTTP-AUTH is the thrown tool error, value never in it', async () => {
    stub.accepted = TOKEN_B;
    stub.echoAuth = true; // a server echoing the header must not leak it either
    await expectAuthError(kbCapture({ type: 'learning', title: 'Tool level gear', summary: 'Tool level capture under auth failure', content: 'x', source_files: ['src/gear.ts'] } as never, { folder: repo }), 'rejected');
    await expectAuthError(kbQuery({ query: 'gear' } as never, { folder: repo }), 'rejected');
  });

  it('7. literal token config: unchanged -- no retry on 401, plain HTTP_401 error, nothing queued', async () => {
    writeConfig({ token_encrypted: encryptPassword(TOKEN_A) });
    const p = await provider();
    expect((await p.capture(entry('Literal ok'))).id).toBe('srv-1');

    stub.accepted = TOKEN_B;
    stub.requests.length = 0;
    let caught: unknown;
    try { await p.capture(entry('Literal rejected')); } catch (err) { caught = err; }
    expect(caught).not.toBeInstanceOf(KbHttpAuthError);
    expect((caught as NodeJS.ErrnoException).code).toBe('HTTP_401');
    expect((caught as Error).message).toBe('HTTP 401: Unauthorized');
    expect(count('/api/kb/capture')).toBe(1);
    expect(p.offlineQueue).toHaveLength(0);

    // Echoed header: redacted, never the literal value.
    stub.echoAuth = true;
    let echoed: unknown;
    try { await p.query({ query: 'gear' }); } catch (err) { echoed = err; }
    expect((echoed as NodeJS.ErrnoException).code).toBe('HTTP_401');
    errorTexts.push((echoed as Error).message);
  });
});

// ---------------------------------------------------------------------------
// Member session: CONFIRMED reads come from the checkout bible under auth
// failure, as they do when the KB server is down. Over the real HTTP transport.
// ---------------------------------------------------------------------------

describe('member session under auth failure', () => {
  let handle: HttpTransportHandle;
  let memberId: string;
  let memberFolder: string;
  const clients: Client[] = [];

  beforeAll(async () => {
    backupAndResetRegistry();
    resetMemberBibleViews();
    memberFolder = gitRepo('member-checkout');
    fs.writeFileSync(memberBiblePath(memberFolder), JSON.stringify({
      version: 2,
      entries: [{
        id: 'bible-gear-1', type: 'knowledge', title: 'Gear ratio is fixed by the bible',
        summary: 'Gear ratio is fixed; recorded in the member checkout bible.',
        symbols: ['gear_ratio'], source_files: ['src/gear.ts'], confidence: 'CONFIRMED',
        updated_at: '2026-09-01T00:00:00.000Z',
      }],
    }, null, 2));
    const agent = makeTestLocalAgent({ friendlyName: `kb-named-secret-${RUN}`, workFolder: memberFolder });
    addAgent(agent);
    memberId = agent.id;
    handle = await createHttpTransport({ registerTools: registerAllTools, preferredPort: 0 });
  }, 30_000);

  afterAll(async () => {
    for (const c of clients.splice(0)) { try { await c.close(); } catch { /* ignore */ } }
    try { await handle?.close(); } catch { /* ignore */ }
    resetMemberBibleViews();
    restoreRegistry();
  });

  async function connect(): Promise<Client> {
    const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
    url.searchParams.set('member', memberId);
    const client = new Client({ name: 'kb-named-secret', version: '1.0.0' }, { capabilities: {} });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: memberSecretRequestInit() }));
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
    const result = await client.callTool({ name, arguments: args });
    const text = ((result.content as Array<{ text?: string }>) ?? []).map(c => c.text ?? '').join('\n');
    toolTexts.push(text);
    return { isError: result.isError === true, text };
  }

  it('5. CONFIRMED kb_query is served from the bible; kb_capture reports E-KB-HTTP-AUTH', async () => {
    stub.accepted = TOKEN_B; // secret is still A: every remote call is rejected
    const client = await connect();

    const read = await call(client, 'kb_query', { query: 'gear' });
    expect(read.isError, read.text).toBe(false);
    expect(JSON.parse(read.text).l1_results.map((e: { id: string }) => e.id)).toEqual(['bible-gear-1']);
    expect(count('/api/kb/query')).toBe(0);

    const write = await call(client, 'kb_capture', {
      type: 'learning', title: 'Member capture under auth failure',
      summary: 'Member capture is queued and reports the auth error', content: 'x', source_files: ['src/gear.ts'],
    });
    expect(write.isError).toBe(true);
    expect(write.text).toContain('E-KB-HTTP-AUTH');
    expect(write.text).toContain(NAME);
    expect(count('/api/kb/capture')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Canary: runs last, over everything the cases above produced.
// ---------------------------------------------------------------------------

describe('canary', () => {
  it('6. no secret value appears in tool results, errors, stderr, console, the fleet log or the environment', () => {
    expect(toolTexts.length).toBeGreaterThan(0);
    expect(errorTexts.length).toBeGreaterThan(0);
    for (const text of [...toolTexts, ...errorTexts, ...stderrChunks, ...consoleLines]) {
      expect(text).not.toContain(CANARY);
    }
    const logFile = getActiveLogFile();
    if (logFile && fs.existsSync(logFile)) {
      expect(fs.readFileSync(logFile, 'utf-8')).not.toContain(CANARY);
    }
    for (const value of Object.values(process.env)) {
      expect(value ?? '').not.toContain(CANARY);
    }
    // The member registry (what member commands are built from) never holds it.
    expect(JSON.stringify(getAllAgents())).not.toContain(CANARY);
    expect(fs.readFileSync(KB_CONFIG_PATH, 'utf-8')).not.toContain(CANARY);
  });
});
