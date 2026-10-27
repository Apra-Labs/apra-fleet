import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { kbList } from '../../src/tools/kb-list.js';
import { kbSessionPrime } from '../../src/tools/kb-session-prime.js';
import { kbContext } from '../../src/tools/kb-context.js';
import { FLEET_DIR } from '../../src/paths.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

// A MEMBER mixed-tier read (confidence [CONFIRMED, INFERRED]) with the KB
// config selecting the http project provider. kb_query, kb_session_prime and
// kb_context pass serverRecall, so getMemberSplitRead steps aside and the KB
// server answers, with the member owner tag. kb_list does not, and keeps the
// typed non-sqlite refusal.
//
// The member's checkout bible is deliberately MALFORMED: loading the member
// bible view throws E-BIBLE-MALFORMED. Every assertion below therefore also
// proves the split read decides the http step-aside (and the kb_list refusal)
// BEFORE it loads the bible view -- on a remote member that load is an SSH
// round trip that fails when the member is unreachable.
//
// What is real: the tool handlers, kb-self routing, kb_setup, the KB config,
// HttpKbProvider, and a local http.Server stand-in for the KB server. No
// vi.mock. The token comes from an env var or a gitignored fixture, never
// source. Isolation: tests/setup.ts points APRA_FLEET_DATA_DIR at a per-run
// temp dir; the registry is backed up and restored; the checkout lives under
// one mkdtemp root removed in afterAll.

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
const MIXED = ['CONFIRMED', 'INFERRED'] as const;
const CITED_FILE = 'src/gear.ts';
const OTHER_TAG = 'member:00000000-0000-4000-8000-000000000000';
const REFUSAL = /: this operation is not supported when the KB is backed by a remote HTTP provider/;

interface RecordedRequest { method: string; path: string; params: URLSearchParams; body: Record<string, unknown> | null }
type ServerEntry = Record<string, unknown> & { id: string; confidence: string; tags: string[] };

let server: http.Server | null = null;
let token = '';
let root: string;
let memberId: string;
let ownTag: string;
const requests: RecordedRequest[] = [];
let entries: ServerEntry[] = [];

function entry(id: string, confidence: string, tags: string[]): ServerEntry {
  const now = new Date().toISOString();
  return {
    id, type: 'knowledge', title: `Gearbox fact ${id}`, summary: `Gearbox fact ${id}: the gearbox stage batches work.`,
    content: `Gearbox fact ${id}.`, source_files: [CITED_FILE], symbols: ['gearbox'], tags, confidence,
    stale: false, flagged_for_review: false, contradiction_of: null, created_at: now, updated_at: now,
  };
}

function tiersOf(raw: unknown): string[] {
  if (typeof raw === 'string' && raw.length > 0) return raw.split(',');
  if (Array.isArray(raw) && raw.length > 0) return raw.map(String);
  return ['CONFIRMED'];
}

function respond(method: string, pathname: string, params: URLSearchParams, body: Record<string, unknown> | null): [number, unknown] {
  const byTier = (raw: unknown) => entries.filter(e => tiersOf(raw).includes(e.confidence));
  const byTag = (list: ServerEntry[], tag: string | null) => list.filter(e => tag === null || e.tags.includes(tag));
  if (method === 'GET' && pathname === '/api/kb/list') {
    const results = byTag(byTier(params.get('confidence')), params.get('tag'));
    return [200, { results, total: results.length }];
  }
  if (method === 'GET' && pathname === '/api/kb/query') {
    const results = byTag(byTier(params.get('confidence')), params.get('tag'));
    return [200, { results, total: results.length, l1_only: params.get('l1_only') === 'true' }];
  }
  if (method === 'POST' && pathname === '/api/kb/prime') {
    return [200, {
      session_warm: true, stale_files: [], top_entries: byTier(body?.confidence), fresh_summaries: [],
      recommended_code_calls: [], token_estimate: 42,
    }];
  }
  if (method === 'GET' && pathname === '/api/kb/context') {
    const files = (params.get('files') ?? '').split(',').filter(Boolean);
    const tiered = byTier(params.get('confidence'));
    const results = files.map(file => {
      const hit = tiered.find(e => (e.source_files as string[]).includes(file));
      return hit ? { file, status: 'fresh', summary: hit.summary, entry_id: hit.id } : { file, status: 'missing' };
    });
    return [200, { results }];
  }
  return [404, { error: 'not found' }];
}

function startServer(): Promise<number> {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://stand-in');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      requests.push({ method: req.method ?? '', path: url.pathname, params: url.searchParams, body });
      const [status, payload] = req.headers.authorization === `Bearer ${token}`
        ? respond(req.method ?? '', url.pathname, url.searchParams, body)
        : [401, { error: 'Unauthorized' }];
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise<number>((resolve, reject) => {
    server!.listen(0, '127.0.0.1', () => {
      const address = server!.address();
      if (address === null || typeof address === 'string') reject(new Error('kb-member-mixed-tier-http: stand-in did not bind a TCP port'));
      else resolve(address.port);
    });
  });
}

const asMember = <T>(fn: () => Promise<T>): Promise<T> => runWithSessionMember(memberId, fn);
const ids = (list: { id: string }[]) => list.map(e => e.id).sort();

beforeAll(async () => {
  token = loadTestToken();
  backupAndResetRegistry();
  resetMemberBibleViews();
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();

  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-member-mixed-http-'));
  const repo = path.join(root, 'checkout');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(repo, CITED_FILE), 'export const gearbox = 1;\n');
  // Malformed on purpose: the bible view must never be loaded (see header).
  fs.writeFileSync(path.join(repo, '.fleet', 'kb-canonical.json'), '{ this is not json', 'utf-8');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', `https://example.test/kb-member-mixed-http-${RUN}.git`], { cwd: repo });

  const agent = makeTestLocalAgent({ friendlyName: `kb-mixed-http-${RUN}`, workFolder: repo });
  addAgent(agent);
  memberId = agent.id;
  ownTag = `member:${memberId}`;

  const port = await startServer();
  const setup = JSON.parse(await kbSetup({ provider: 'http', remote: `http://127.0.0.1:${port}`, token }, { folder: repo }));
  expect(setup.success).toBe(true);
});

beforeEach(() => {
  requests.length = 0;
  entries = [
    entry('own-confirmed', 'CONFIRMED', [ownTag]),
    entry('other-confirmed', 'CONFIRMED', [OTHER_TAG]),
    entry('own-inferred', 'INFERRED', [ownTag]),
    entry('other-inferred', 'INFERRED', [OTHER_TAG]),
  ];
});

afterAll(async () => {
  const current = server;
  server = null;
  if (current) await new Promise<void>(resolve => current.close(() => resolve()));
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
  resetMemberBibleViews();
  restoreRegistry();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('MEMBER mixed-tier read over the http project KB: the server answers, the bible view is never loaded', () => {
  it('kb_query reaches the server with both tiers and the member owner tag, and returns the full CONFIRMED set plus its own INFERRED rows', async () => {
    const out = JSON.parse(await asMember(() => kbQuery({ query: 'gearbox', confidence: [...MIXED] })));
    expect(ids(out.l1_results)).toEqual(['other-confirmed', 'own-confirmed', 'own-inferred']);
    const q = requests.find(r => r.method === 'GET' && r.path === '/api/kb/query');
    expect(q).toBeDefined();
    expect(q!.params.get('confidence')).toBe('CONFIRMED,INFERRED');
    // The owner tag is not sent: the server's full CONFIRMED set must come back.
    expect(q!.params.get('tag')).toBeNull();
    expect(ids(out.l1_results)).not.toContain('other-inferred');
  });

  it('kb_session_prime reaches the server with both tiers, and keeps all CONFIRMED rows plus its own INFERRED rows', async () => {
    const out = JSON.parse(await asMember(() => kbSessionPrime({ hint_symbols: ['gearbox'], confidence: [...MIXED] })));
    expect(ids(out.top_entries)).toEqual(['other-confirmed', 'own-confirmed', 'own-inferred']);
    expect(ids(out.top_entries)).not.toContain('other-inferred');
    const p = requests.find(r => r.method === 'POST' && r.path === '/api/kb/prime');
    expect(p).toBeDefined();
    expect(p!.body?.confidence).toEqual([...MIXED]);
    expect(p!.body).not.toHaveProperty('owner_tag');
    // Ownership is looked up on the server by the member owner tag.
    expect(requests.some(r => r.path === '/api/kb/list' && r.params.get('tag') === ownTag)).toBe(true);
  });

  it('kb_context reaches the server with both tiers and answers the file from the member own row', async () => {
    // Only the other member's INFERRED row and the member's own INFERRED row cite the file.
    entries = [entry('other-inferred', 'INFERRED', [OTHER_TAG]), entry('own-inferred', 'INFERRED', [ownTag])];
    const out = JSON.parse(await asMember(() => kbContext({ files: [CITED_FILE], confidence: [...MIXED] })));
    const c = requests.find(r => r.method === 'GET' && r.path === '/api/kb/context');
    expect(c).toBeDefined();
    expect(c!.params.get('confidence')).toBe('CONFIRMED,INFERRED');
    expect(requests.some(r => r.path === '/api/kb/list' && r.params.get('tag') === ownTag)).toBe(true);
    // The stand-in answers with the first matching row (another member's): owner
    // filtering drops it, so the file reads as missing rather than exposing it.
    expect(out.fresh).toEqual([]);
    expect(out.missing).toEqual([CITED_FILE]);

    // Another member's CONFIRMED row is visible, as on the SQLite split read.
    entries = [entry('other-confirmed', 'CONFIRMED', [OTHER_TAG])];
    const confirmed = JSON.parse(await asMember(() => kbContext({ files: [CITED_FILE], confidence: [...MIXED] })));
    expect(confirmed.fresh.map((r: { entry_id: string }) => r.entry_id)).toEqual(['other-confirmed']);

    entries = [entry('own-inferred', 'INFERRED', [ownTag])];
    const own =JSON.parse(await asMember(() => kbContext({ files: [CITED_FILE], confidence: [...MIXED] })));
    expect(own.fresh.map((r: { entry_id: string }) => r.entry_id)).toEqual(['own-inferred']);
  });

  it('kb_list keeps the typed refusal, naming the tool, without touching the server or the bible view', async () => {
    const err = await asMember(() => kbList({ confidence: [...MIXED] })).catch(e => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^kb_list/);
    expect(err.message).toMatch(REFUSAL);
    expect(err.message).not.toMatch(/E-BIBLE-MALFORMED/);
    expect(requests).toEqual([]);
  });
});
