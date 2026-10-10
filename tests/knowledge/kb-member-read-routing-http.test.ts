import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { requireSqliteProject } from '../../src/services/knowledge/require-sqlite-project.js';
import { importBibleEntries } from '../../src/services/knowledge/bible-import.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { memberBiblePath, resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { kbSessionPrime } from '../../src/tools/kb-session-prime.js';
import { kbContext } from '../../src/tools/kb-context.js';
import { kbList } from '../../src/tools/kb-list.js';
import { kbStats } from '../../src/tools/kb-stats.js';
import { FLEET_DIR } from '../../src/paths.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

// MEMBER-session recall under the http project provider. kb_query,
// kb_session_prime and kb_context must reach the KB server for every tier
// (the checkout bible is not fed from the server), while kb_list and kb_stats
// keep the bible view and a SQLite install keeps the bible view for all of
// them. Real member session (runWithSessionMember), real git checkout with an
// origin remote, real kb_setup, real HttpKbProvider and a real local
// http.Server stand-in that records every request. No mocks of code under test.
//
// Isolation: tests/setup.ts points APRA_FLEET_DATA_DIR at a per-run temp dir
// (KB config and every kb.sqlite land there); the registry is backed up and
// restored; the checkout lives under one mkdtemp scratch root removed in
// afterAll; the origin remote is unique per run so the per-repo DB is fresh.

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

interface RecordedRequest {
  method: string;
  path: string;
  params: URLSearchParams;
}

// ---- KB server stand-in -------------------------------------------------

function serverEntry(id: string, confidence: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, type: 'knowledge', confidence,
    title: `Gizmo server fact ${id}`,
    summary: `Gizmo server fact recorded only on the KB server as ${id}.`,
    content: `Gizmo server content for ${id}.`,
    source_files: ['src/gizmo.ts'], symbols: [], tags: [],
    flagged_for_review: false, contradiction_of: null, stale: false,
    ...over,
  };
}

const SERVER_CONFIRMED = [serverEntry('srv-c1', 'CONFIRMED'), serverEntry('srv-c2', 'CONFIRMED')];
const SERVER_INFERRED = [serverEntry('srv-i1', 'INFERRED')];
const SERVER_PRIME = [serverEntry('srv-p1', 'CONFIRMED'), serverEntry('srv-p2', 'CONFIRMED'), serverEntry('srv-p3', 'CONFIRMED')];
const SERVER_CTX_ID = 'srv-ctx';

let server: http.Server | null = null;
let port = 0;
const requests: RecordedRequest[] = [];

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://stand-in');
  requests.push({ method: req.method ?? '', path: url.pathname, params: url.searchParams });
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && url.pathname === '/api/kb/query') {
    const tiers = (url.searchParams.get('confidence') ?? 'CONFIRMED').split(',');
    const results = [...SERVER_CONFIRMED, ...SERVER_INFERRED].filter(e => tiers.includes(String(e.confidence)));
    json(200, { results, total: results.length, l1_only: url.searchParams.get('l1_only') === 'true' });
  } else if (req.method === 'POST' && url.pathname === '/api/kb/prime') {
    json(200, {
      session_warm: true, stale_files: [], top_entries: SERVER_PRIME, fresh_summaries: [],
      recommended_code_calls: [], token_estimate: 42,
    });
  } else if (req.method === 'GET' && url.pathname === '/api/kb/context') {
    const files = (url.searchParams.get('files') ?? '').split(',').filter(Boolean);
    json(200, {
      results: files.map(file => file === 'src/gizmo.ts'
        ? { file, status: 'fresh', entry_id: SERVER_CTX_ID, summary: 'Gizmo summary from the server.' }
        : { file, status: 'missing' }),
    });
  } else {
    json(404, { error: 'not found' });
  }
}

function startServer(listenPort: number): Promise<void> {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => handle(req, res));
  });
  return new Promise<void>(resolve => server!.listen(listenPort, '127.0.0.1', resolve));
}

function stopServer(): Promise<void> {
  const current = server;
  server = null;
  if (!current) return Promise.resolve();
  return new Promise<void>(resolve => current.close(() => resolve()));
}

const requestPaths = () => requests.map(r => `${r.method} ${r.path}`);

// ---- member checkout ----------------------------------------------------

function bibleEntry(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, type: 'knowledge',
    title: `Gizmo bible fact ${id}`,
    summary: `Gizmo bible fact recorded in the checkout bible as ${id}.`,
    symbols: [], source_files: ['src/gizmo.ts'],
    confidence: 'CONFIRMED', updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

const BIBLE = [
  bibleEntry('bible-1'),
  bibleEntry('bible-ctx', { type: 'context-cache' }),
];
const FALLBACK_ENTRY_ID = 'repo-fallback-1';

let scratch: string;
let repo: string;
let memberId: string;
let token: string;

const asMember = <T>(fn: () => Promise<T>): Promise<T> => runWithSessionMember(memberId, fn);
const ids = (rows: Array<{ id: string }>) => rows.map(r => r.id);

function writeBible(entries: unknown[] | null): void {
  const biblePath = memberBiblePath(repo);
  if (entries === null) {
    fs.rmSync(biblePath, { force: true });
  } else {
    fs.writeFileSync(biblePath, JSON.stringify({ version: 2, entries }), 'utf-8');
  }
  resetMemberBibleViews();
}

async function configureHttp(): Promise<void> {
  const result = JSON.parse(await kbSetup({ provider: 'http', remote: `http://127.0.0.1:${port}`, token }, { folder: repo }));
  expect(result.success).toBe(true);
  const providers = await getKbProviders(repo);
  expect(providers.project).toBeInstanceOf(HttpKbProvider);
}

beforeAll(async () => {
  token = loadTestToken();
  backupAndResetRegistry();
  resetMemberBibleViews();
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-member-read-http-'));
  repo = path.join(scratch, 'checkout');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'gizmo.ts'), 'export const gizmo = 1;\n');
  fs.writeFileSync(path.join(repo, 'src', 'other.ts'), 'export const other = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', `https://example.test/kb-member-read-http-${RUN}.git`], { cwd: repo });

  const agent = makeTestLocalAgent({ friendlyName: `kb-member-read-http-${RUN}`, workFolder: repo });
  addAgent(agent);
  memberId = agent.id;

  // Seed the per-repo SQLite DB, which is the http provider's local fallback store.
  const providers = await getKbProviders(repo);
  await importBibleEntries(requireSqliteProject(providers.project, 'test'), [
    bibleEntry(FALLBACK_ENTRY_ID, { title: 'Gizmo fallback store fact', summary: 'Gizmo fact held only in the per-repo fallback store.' }),
  ]);

  await startServer(0);
  const address = server!.address();
  if (address === null || typeof address === 'string') throw new Error('kb-member-read-routing-http: stand-in did not bind a TCP port');
  port = address.port;
});

beforeEach(() => {
  requests.length = 0;
  writeBible(BIBLE);
});

afterEach(async () => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
  resetMemberBibleViews();
  if (!server) await startServer(port);
});

afterAll(async () => {
  await stopServer();
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
  resetMemberBibleViews();
  restoreRegistry();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('MEMBER recall under the http provider reaches the KB server', () => {
  it('1. kb_query CONFIRMED returns the server entries, with the bible absent and with a different bible present', async () => {
    await configureHttp();
    for (const bible of [null, [bibleEntry('bible-other')]]) {
      writeBible(bible);
      requests.length = 0;
      const out = JSON.parse(await asMember(() => kbQuery({ query: 'gizmo', confidence: ['CONFIRMED'] })));
      expect(requestPaths()).toContain('GET /api/kb/query');
      expect(requests.find(r => r.path === '/api/kb/query')!.params.get('confidence')).toBe('CONFIRMED');
      expect(ids(out.l1_results)).toEqual(['srv-c1', 'srv-c2']);
      expect(ids(out.l1_results)).not.toContain('bible-other');
    }
  });

  it('2. kb_session_prime posts to /api/kb/prime and its top_entries come from the server', async () => {
    await configureHttp();
    const out = JSON.parse(await asMember(() => kbSessionPrime({ hint_modules: ['gizmo'] })));
    expect(requestPaths()).toContain('POST /api/kb/prime');
    expect(ids(out.top_entries)).toEqual(['srv-p1', 'srv-p2', 'srv-p3']);
    expect(out.token_estimate).toBe(42);
  });

  it('3. kb_context (default confidence) reads /api/kb/context and reflects the server status', async () => {
    await configureHttp();
    const out = JSON.parse(await asMember(() => kbContext({ files: ['src/gizmo.ts', 'src/other.ts'] })));
    const ctxRequests = requests.filter(r => r.path === '/api/kb/context');
    expect(ctxRequests).toHaveLength(1);
    expect(ctxRequests[0].params.get('confidence')).toBe('CONFIRMED,INFERRED');
    expect(out.fresh.map((r: { entry_id: string }) => r.entry_id)).toEqual([SERVER_CTX_ID]);
    expect(out.missing).toEqual(['src/other.ts']);
  });

  it('4. kb_query INFERRED reaches the server instead of throwing', async () => {
    await configureHttp();
    const out = JSON.parse(await asMember(() => kbQuery({ query: 'gizmo', confidence: ['INFERRED'] })));
    const queryRequest = requests.find(r => r.path === '/api/kb/query');
    expect(queryRequest?.params.get('confidence')).toBe('INFERRED');
    expect(ids(out.l1_results)).toEqual(['srv-i1']);
  });
});

describe('routing that must not change', () => {
  it('5. SQLite provider: MEMBER CONFIRMED kb_query returns the bible entry and the stand-in records nothing', async () => {
    const out = JSON.parse(await asMember(() => kbQuery({ query: 'gizmo', confidence: ['CONFIRMED'] })));
    expect(ids(out.l1_results).sort()).toEqual(['bible-1', 'bible-ctx']);
    expect(requests).toEqual([]);
  });

  it('6. kb_list and kb_stats under http keep the bible view and do not throw', async () => {
    await configureHttp();
    requests.length = 0;
    const list = JSON.parse(await asMember(() => kbList({})));
    expect(ids(list.results).sort()).toEqual(['bible-1', 'bible-ctx']);
    const stats = JSON.parse(await asMember(() => kbStats({})));
    expect(stats.totals.by_confidence.CONFIRMED).toBe(2);
    expect(stats.bible).toMatchObject({ present: true, entries: 2 });
    expect(requests).toEqual([]);
  });

  it('7. server stopped: MEMBER CONFIRMED kb_query under http resolves from the local fallback store', async () => {
    await configureHttp();
    await stopServer();
    const out = JSON.parse(await asMember(() => kbQuery({ query: 'gizmo', confidence: ['CONFIRMED'] })));
    expect(ids(out.l1_results)).toEqual([FALLBACK_ENTRY_ID]);
    expect(requests).toEqual([]);
  });
});
