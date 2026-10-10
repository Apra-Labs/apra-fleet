import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { kbPromote } from '../../src/tools/kb-promote.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { FLEET_DIR } from '../../src/paths.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

// Promote over an http project KB, at provider and kb_promote tool level.
// Real local http.Server stand-in (stateful: it only promotes ids it has been
// told about), real HttpKbProvider and SqliteProvider, real member sessions.
// No mocks of code under test.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_ENV_VAR = 'APRA_FLEET_TEST_KB_HTTP_TOKEN';
const TOKEN_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'kb-http-test-token.txt');

function loadTestToken(): string {
  const fromEnv = process.env[TOKEN_ENV_VAR];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  if (fs.existsSync(TOKEN_FIXTURE_PATH)) {
    const fromFile = fs.readFileSync(TOKEN_FIXTURE_PATH, 'utf-8').trim();
    if (fromFile.length > 0) return fromFile;
  }
  throw new Error(`Missing test KB token: set ${TOKEN_ENV_VAR} or provide a non-empty ${TOKEN_FIXTURE_PATH}`);
}

const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const REASON = 'Verified against src/widget.ts: the widget stage batches work per tick.';

interface RecordedRequest {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
  headers: http.IncomingHttpHeaders;
}

let server: http.Server | null = null;
let port = 0;
let token: string;
let scratch: string;
const requests: RecordedRequest[] = [];
const serverIds = new Set<string>();
let responseSpelling: 'previous_new' | 'before_after' = 'previous_new';
let refusalOverride: { status: number; body: Record<string, unknown> } | null = null;

function startServer(listenPort: number): Promise<void> {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      requests.push({ method: req.method ?? '', url: req.url ?? '', body, headers: req.headers });
      if (req.url === '/api/kb/promote' && req.method === 'POST') {
        if (refusalOverride) {
          res.writeHead(refusalOverride.status, { 'Content-Type': 'application/problem+json' });
          res.end(JSON.stringify(refusalOverride.body));
          return;
        }
        const id = String(body?.id);
        if (!serverIds.has(id)) {
          res.writeHead(404, { 'Content-Type': 'application/problem+json' });
          res.end(JSON.stringify({ title: 'Entry not found', status: 404, code: 'KB-NOT-FOUND', detail: id }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(
          responseSpelling === 'previous_new'
            ? { id, previous_confidence: 'INFERRED', new_confidence: 'CONFIRMED' }
            : { id, confidence_before: 'INFERRED', confidence_after: 'CONFIRMED' },
        ));
      } else if (req.url === '/api/kb/capture' && req.method === 'POST') {
        const id = `srv-${crypto.randomUUID()}`;
        serverIds.add(id);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, audn_decision: 'add' }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
  });
  return new Promise<void>(resolve => server!.listen(listenPort, '127.0.0.1', resolve));
}

function stopServer(): Promise<void> {
  const current = server;
  server = null;
  if (!current) return Promise.resolve();
  return new Promise<void>(resolve => current.close(() => resolve()));
}

function makeCheckout(name: string, origin: string): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'widget.ts'), 'export const widget = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: dir });
  return dir;
}

const remoteUrlFor = () => `http://127.0.0.1:${port}`;

async function configureHttp(folder: string): Promise<void> {
  const result = JSON.parse(await kbSetup({ provider: 'http', remote: remoteUrlFor(), token }, { folder }));
  expect(result.success).toBe(true);
}

async function httpProject(): Promise<{ provider: HttpKbProvider; fallback: SqliteProvider; rows: () => number }> {
  const repo = makeCheckout(`provider-${crypto.randomUUID()}`, `https://example.test/kb-promote-http-${crypto.randomUUID()}.git`);
  await configureHttp(repo);
  const providers = await getKbProviders(repo, `https://example.test/kb-promote-http-${crypto.randomUUID()}.git`);
  expect(providers.project).toBeInstanceOf(HttpKbProvider);
  const provider = providers.project as HttpKbProvider;
  const fallback = (provider as unknown as { fallback: SqliteProvider }).fallback;
  const db = (fallback as unknown as { getDb(): { prepare(s: string): { get(): unknown } } }).getDb();
  const rows = () => (db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n;
  return { provider, fallback, rows };
}

beforeAll(async () => {
  token = loadTestToken();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-promote-http-'));
  backupAndResetRegistry();
  await startServer(0);
  const address = server!.address();
  if (address === null || typeof address === 'string') throw new Error('kb-promote-http: stand-in did not bind a TCP port');
  port = address.port;
});

afterEach(() => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
  requests.length = 0;
  serverIds.clear();
  refusalOverride = null;
  responseSpelling = 'previous_new';
});

afterAll(async () => {
  await stopServer();
  restoreRegistry();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('HttpKbProvider.promote', () => {
  it('1. posts {id, reason} once and maps both response spellings', async () => {
    const { provider } = await httpProject();
    for (const spelling of ['previous_new', 'before_after'] as const) {
      responseSpelling = spelling;
      requests.length = 0;
      const { id } = await provider.capture({
        type: 'knowledge', title: 'promote http', summary: 'Entry captured for promote over http.',
        content: 'promote http content', source_files: [], symbols: [], tags: [], content_hash: '',
        content_hash_type: 'sha256', flagged_for_review: false, author: 'doer', source: 'session',
        confidence: 'INFERRED',
      });
      requests.length = 0;
      const result = await provider.promote(id, REASON);
      expect(result).toEqual({ id, confidence_before: 'INFERRED', confidence_after: 'CONFIRMED' });
      expect(requests).toHaveLength(1);
      expect(requests[0].method).toBe('POST');
      expect(requests[0].url).toBe('/api/kb/promote');
      expect(requests[0].body).toEqual({ id, reason: REASON });
    }
  });

  it('2. promotes a server-only id and leaves the fallback store without a row', async () => {
    const { provider, rows } = await httpProject();
    serverIds.add('server-only-id');
    const before = rows();
    await expect(provider.promote('server-only-id', REASON)).resolves.toMatchObject({
      id: 'server-only-id', confidence_after: 'CONFIRMED',
    });
    expect(rows()).toBe(before);
  });

  it('3. surfaces status plus title/code for refusals; fallback unchanged', async () => {
    const { provider, rows } = await httpProject();
    const before = rows();
    await expect(provider.promote('unknown-id', REASON)).rejects.toThrow(/404.*Entry not found.*KB-NOT-FOUND/);

    refusalOverride = { status: 409, body: { title: 'Entry superseded', status: 409, code: 'KB-SUPERSEDED' } };
    await expect(provider.promote('any-id', REASON)).rejects.toThrow(/409.*Entry superseded.*KB-SUPERSEDED/);
    expect(rows()).toBe(before);
  });

  it('4. with the server stopped rejects naming the URL; no queue entry, fallback unchanged', async () => {
    const { provider, rows } = await httpProject();
    const before = rows();
    await stopServer();
    try {
      await expect(provider.promote('some-id', REASON)).rejects.toThrow(remoteUrlFor());
      expect(provider.offlineQueue).toHaveLength(0);
      expect(rows()).toBe(before);
    } finally {
      await startServer(port);
    }
  });

  it('7. identifies the caller only by Authorization: Bearer', async () => {
    const { provider } = await httpProject();
    serverIds.add('hdr-id');
    await provider.promote('hdr-id', REASON);
    const promote = requests.find(r => r.url === '/api/kb/promote');
    expect(promote).toBeDefined();
    expect(promote!.headers.authorization).toBe(`Bearer ${token}`);
    expect(Object.keys(promote!.headers).filter(h => h.toLowerCase().startsWith('x-caller'))).toEqual([]);
  });
});

describe('kb_promote in a MEMBER session', () => {
  it('5. over http reaches the server and returns the tool shape', async () => {
    const origin = `https://example.test/kb-promote-member-http-${RUN}.git`;
    const folder = makeCheckout('member-http', origin);
    const agent = makeTestLocalAgent({ friendlyName: `kb-promote-http-${RUN}`, workFolder: folder });
    addAgent(agent);
    await configureHttp(folder);
    serverIds.add('member-srv-id');

    const out = await runWithSessionMember(agent.id, () => kbPromote({ id: 'member-srv-id', reason: REASON }));
    expect(JSON.parse(out)).toEqual({
      id: 'member-srv-id', previous_confidence: 'INFERRED', new_confidence: 'CONFIRMED',
    });
    const promote = requests.filter(r => r.url === '/api/kb/promote');
    expect(promote).toHaveLength(1);
    expect(promote[0].body).toEqual({ id: 'member-srv-id', reason: REASON });
  });

  it('6. over SQLite keeps own-scope: own id promotes, another member id is not found', async () => {
    const origin = `https://example.test/kb-promote-member-sqlite-${RUN}.git`;
    const folderA = makeCheckout('member-a', origin);
    const folderB = makeCheckout('member-b', origin);
    const a = makeTestLocalAgent({ friendlyName: `kb-promote-a-${RUN}`, workFolder: folderA });
    const b = makeTestLocalAgent({ friendlyName: `kb-promote-b-${RUN}`, workFolder: folderB });
    addAgent(a);
    addAgent(b);

    const captured = JSON.parse(await runWithSessionMember(a.id, () => kbCapture({
      type: 'knowledge', title: 'member a own entry',
      summary: 'Entry captured by member a for the own-scope promote check.',
      content: 'member a own entry content for the own-scope check', source_files: ['src/widget.ts'],
      symbols: ['widgetOwnScope'],
    })));
    expect(typeof captured.id).toBe('string');

    await expect(runWithSessionMember(b.id, () => kbPromote({ id: captured.id, reason: REASON })))
      .rejects.toThrow(/not found/i);

    const own = JSON.parse(await runWithSessionMember(a.id, () => kbPromote({ id: captured.id, reason: REASON })));
    expect(own).toEqual({ id: captured.id, previous_confidence: 'INFERRED', new_confidence: 'CONFIRMED' });
    expect(requests).toHaveLength(0);
  });
});
