import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember, memberToolScope, isToolInScope } from '../../src/services/tool-scope.js';
import { resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { getSelfKbProviders } from '../../src/services/knowledge/kb-self.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import { kbPromote } from '../../src/tools/kb-promote.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { kbSessionPrime } from '../../src/tools/kb-session-prime.js';
import { createKbWorkClient } from '../../packages/apra-fleet-se/fleet-sprint/kb.mjs';
import { selfMaintainer } from '../../packages/apra-fleet-se/test/helpers/kb-maintainer-fakes.mjs';
import { FLEET_DIR } from '../../src/paths.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

// End-to-end sprint KB path over the http project provider:
// capture -> promote -> recall, driven through the fleet-sprint engine's
// createKbWorkClient (packages/apra-fleet-se/fleet-sprint/kb.mjs).
//
// What is real: kb.mjs (apply, its per-repository queue and flush,
// promotionCandidates, knowledgeFor -> queryEntries / primeEntries), the
// kb_capture / kb_promote / kb_query / kb_session_prime tool handlers, the
// kb-self routing (getSelfReadKb serverRecall, memberOwnerTag), kb_setup, the
// KB config, HttpKbProvider and its SqliteProvider fallback store. No vi.mock.
//
// memberCall: runs the real handler inside runWithSessionMember(<maintainer
// id>, ..., { kbMaintainer }) so the handlers see a MEMBER session, exactly
// as the engine's origin=engine member session does. The tool must be in the
// member tool scope (memberToolScope + isToolInScope), so kb_promote is only
// served when the engine asked for the kb_maintainer grant
// (KB_MAINTAINER_CALL), as on the real transport.
//
// createKbWorkClient opts chosen here:
//   - maintainers: selfMaintainer (test helper) -- plain-data topology that
//     names the registered maintainer member as the kb_maintainer of the one
//     repository the doer and reviewer belong to. Topology input, not code
//     under test.
//   - gPull: a real `git pull --ff-only` in the maintainer's checkout against
//     its bare origin. The engine's own git-sync (git-sync.mjs pullGitBefore)
//     cannot be used in-process: it reaches the member through fleet MCP
//     member calls (execute_command), which needs a running fleet server.
//   - gPush / bibleBase / abortRebase / checkedOutBranch are not passed: the
//     flow only uses apply's queue flush, not the bible commit round (the
//     http bible skip is covered by kb-bible-commit-round in fleet-sprint).
//
// KB server: a real local http.Server stand-in, STATEFUL -- capture stores the
// entry and assigns an id, promote raises it to CONFIRMED, query and prime
// return the stored entries filtered by the confidence param. Every request
// and its response body is recorded.
//
// Falsification (run by hand once each, both made this test fail):
//   - HttpKbProvider.promote delegating to the fallback store instead of
//     POST /api/kb/promote: no promote request reaches the server.
//   - getSelfReadKb sending a member CONFIRMED read to the checkout bible view
//     instead of the http provider (the serverRecall branch limited to
//     INFERRED/UNVERIFIED): no CONFIRMED query reaches the server and the
//     engine recall returns nothing. Removing the serverRecall branch outright
//     fails even earlier, at the INFERRED promotion-candidate read.
//
// Isolation: tests/setup.ts points APRA_FLEET_DATA_DIR at a per-run temp dir
// (KB config and every kb.sqlite land there); the registry is backed up and
// restored; the repos live under one mkdtemp root removed in afterAll; the
// bare origin's name is unique per run so the per-repo DB is fresh. The token
// comes from loadTestToken (env var or gitignored fixture), never source.

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
const REASON = 'Verified by the reviewer against src/widget.ts at the sprint HEAD';
const CITED_FILE = 'src/widget.ts';
const ENTRY_TITLE = 'Widget registry is a frozen singleton';
const DOER = 'doer-1';
const REVIEWER = 'reviewer-1';

// ---- KB server stand-in -------------------------------------------------

interface RecordedRequest {
  method: string;
  path: string;
  params: URLSearchParams;
  body: Record<string, unknown> | null;
  response: unknown;
}

type StoredEntry = Record<string, unknown> & { id: string; confidence: string };

let server: http.Server | null = null;
let port = 0;
let token = '';
const requests: RecordedRequest[] = [];
const stored = new Map<string, StoredEntry>();

function tierFilter(raw: unknown): (e: StoredEntry) => boolean {
  const tiers = typeof raw === 'string' && raw.length > 0 ? raw.split(',')
    : Array.isArray(raw) && raw.length > 0 ? raw.map(String)
      : ['CONFIRMED'];
  return (e) => tiers.includes(e.confidence);
}

function respond(method: string, pathname: string, params: URLSearchParams, body: Record<string, unknown> | null): [number, unknown] {
  if (method === 'POST' && pathname === '/api/kb/capture') {
    const id = `srv-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    stored.set(id, {
      ...(body ?? {}), id, confidence: 'INFERRED',
      flagged_for_review: false, contradiction_of: null, stale: false, created_at: now, updated_at: now,
    });
    return [201, { id, audn_decision: 'add' }];
  }
  if (method === 'POST' && pathname === '/api/kb/promote') {
    const entry = stored.get(String(body?.id));
    if (!entry) return [404, { title: 'Not found', code: 'NOT-FOUND' }];
    const previous = entry.confidence;
    entry.confidence = 'CONFIRMED';
    return [200, { id: entry.id, previous_confidence: previous, new_confidence: 'CONFIRMED' }];
  }
  if (method === 'GET' && pathname === '/api/kb/query') {
    const results = [...stored.values()].filter(tierFilter(params.get('confidence')));
    return [200, { results, total: results.length, l1_only: params.get('l1_only') === 'true' }];
  }
  if (method === 'POST' && pathname === '/api/kb/prime') {
    const top = [...stored.values()].filter(tierFilter(body?.confidence));
    return [200, {
      session_warm: true, stale_files: [], top_entries: top, fresh_summaries: [],
      recommended_code_calls: [], token_estimate: 42,
    }];
  }
  return [404, { error: 'not found' }];
}

function startServer(): Promise<void> {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://stand-in');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      const [status, payload] = req.headers.authorization === `Bearer ${token}`
        ? respond(req.method ?? '', url.pathname, url.searchParams, body)
        : [401, { error: 'Unauthorized' }];
      requests.push({ method: req.method ?? '', path: url.pathname, params: url.searchParams, body, response: payload });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
}

// ---- maintainer checkout and member session -------------------------------

let root: string;
let origin: string;
let clone: string;
let maintainer: { id: string; name: string; type: string };

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.local', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

interface MemberCallRecord { tool: string; kbMaintainer: boolean }
const memberCalls: MemberCallRecord[] = [];

const HANDLERS: Record<string, (args: any) => Promise<string>> = {
  kb_capture: (args) => kbCapture(args),
  kb_promote: (args) => kbPromote(args),
  kb_query: (args) => kbQuery(args),
  kb_session_prime: (args) => kbSessionPrime(args),
};

/** The engine's memberCall, answered by the real handlers in the member's own session. */
async function memberCall(record: { id: string }, tool: string, args: unknown, callOpts: { kbMaintainer?: boolean } = {}): Promise<string> {
  const kbMaintainer = callOpts.kbMaintainer === true;
  const scope = memberToolScope(record.id, false, true, kbMaintainer);
  if (!isToolInScope(tool, scope)) {
    throw Object.assign(new Error(`tool ${tool} is not served to member session ${record.id} (kbMaintainer=${kbMaintainer})`), { code: 'E-TOOL' });
  }
  const handler = HANDLERS[tool];
  if (!handler) throw Object.assign(new Error(`sprint http e2e: no handler wired for ${tool}`), { code: 'E-TOOL' });
  memberCalls.push({ tool, kbMaintainer });
  return runWithSessionMember(record.id, () => handler(args), { kbMaintainer });
}

beforeAll(async () => {
  token = loadTestToken();
  backupAndResetRegistry();
  resetMemberBibleViews();
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();

  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-sprint-http-e2e-'));
  origin = path.join(root, `kb-sprint-http-${RUN}.git`);
  clone = path.join(root, 'maintainer-checkout');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '--quiet', origin, clone], { stdio: ['ignore', 'pipe', 'pipe'] });
  git(clone, ['checkout', '--quiet', '-B', 'main']);
  fs.mkdirSync(path.join(clone, 'src'), { recursive: true });
  fs.writeFileSync(path.join(clone, CITED_FILE), 'export const widget = Object.freeze({});\n');
  git(clone, ['add', '-A']);
  git(clone, ['commit', '--quiet', '--no-verify', '-m', 'seed']);
  git(clone, ['push', '--quiet', '-u', 'origin', 'main']);

  const agent = makeTestLocalAgent({ friendlyName: `kb-sprint-http-maintainer-${RUN}`, workFolder: clone });
  addAgent(agent);
  maintainer = { id: agent.id, name: agent.friendlyName, type: 'local' };

  await startServer();
  const address = server!.address();
  if (address === null || typeof address === 'string') throw new Error('kb-sprint-path-http-e2e: stand-in did not bind a TCP port');
  port = address.port;

  const setup = JSON.parse(await kbSetup({ provider: 'http', remote: `http://127.0.0.1:${port}`, token }, { folder: clone }));
  expect(setup.success).toBe(true);
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

describe('sprint KB path over http: capture, promote and recall all reach the KB server as the kb_maintainer member', () => {
  it('kbWork captures and promotes on the server, and the engine recall returns the promoted entry', async () => {
    const logs: string[] = [];
    const client = createKbWorkClient({
      memberCall,
      maintainers: selfMaintainer(maintainer, [maintainer.name, DOER, REVIEWER]),
      gPull: async () => { git(clone, ['pull', '--quiet', '--ff-only', 'origin', 'main']); },
      log: (m: string) => logs.push(m),
    });

    // 1a. A doer's result carries one capture; apply queues it for the
    // repository's maintainer and flushes it there.
    const captured = await client.apply('doer', DOER, {
      kb_captures: [{
        type: 'knowledge',
        title: ENTRY_TITLE,
        summary: 'The widget registry in src/widget.ts is created with Object.freeze and never mutated.',
        content: 'src/widget.ts exports widget as Object.freeze({}); callers must copy it before adding keys.',
        source_files: [CITED_FILE],
        symbols: ['widget'],
      }],
    });
    expect(captured).toMatchObject({ captured: 1, refused: 0 });
    const captureReq = requests.find(r => r.method === 'POST' && r.path === '/api/kb/capture');
    expect(captureReq).toBeDefined();
    const serverId = (captureReq!.response as { id: string }).id;
    expect(captureReq!.body?.title).toBe(ENTRY_TITLE);
    // Captured in the maintainer's MEMBER session: the handler stamped its own-scope tag.
    expect(captureReq!.body?.tags).toContain(`member:${maintainer.id}`);

    // 1b. The engine reads the reviewer's candidates from the maintainer, then
    // applies the reviewer's promotion of the server-assigned id.
    const candidates = await client.promotionCandidates(REVIEWER);
    expect(candidates.map((c: { id: string }) => c.id)).toEqual([serverId]);
    const promoted = await client.apply('reviewer', REVIEWER, { kb_promotions: [{ id: serverId, reason: REASON }] });
    expect(promoted).toMatchObject({ promoted: 1, refused: 0 });
    expect(memberCalls.filter(c => c.tool === 'kb_promote')).toEqual([{ tool: 'kb_promote', kbMaintainer: true }]);
    expect(client.pendingCount()).toBe(0);

    // 3. Recall through the engine's own read path (knowledgeFor ->
    // queryEntries, kb_query CONFIRMED) on the maintainer record.
    const recalled = await client.knowledgeFor(REVIEWER, ['widget', 'registry']);
    expect(recalled.source).toBe('query');
    expect(recalled.entries.map((e: { id: string }) => e.id)).toEqual([serverId]);
    expect(recalled.entries[0]).toMatchObject({ id: serverId, confidence: 'CONFIRMED', title: ENTRY_TITLE });

    // ... and the hint-driven prime path (knowledgeFor -> primeEntries, kb_session_prime CONFIRMED).
    const primed = await client.knowledgeFor(REVIEWER, { terms: [], hintSymbols: ['widget'], hintModules: [] });
    expect(primed.source).toBe('prime');
    expect(primed.entries.map((e: { id: string }) => e.id)).toContain(serverId);

    // 1. Order on the server: capture, promote of that id, then a CONFIRMED
    // query and prime whose responses include it.
    const order = requests.map(r => `${r.method} ${r.path}`);
    const captureAt = order.indexOf('POST /api/kb/capture');
    const promoteAt = requests.findIndex(r => r.path === '/api/kb/promote' && r.body?.id === serverId);
    const confirmedQueryAt = requests.findIndex(r => r.path === '/api/kb/query'
      && r.params.get('confidence') === 'CONFIRMED'
      && ((r.response as { results: { id: string }[] }).results ?? []).some(e => e.id === serverId));
    const confirmedPrimeAt = requests.findIndex(r => r.path === '/api/kb/prime'
      && JSON.stringify(r.body?.confidence) === JSON.stringify(['CONFIRMED'])
      && ((r.response as { top_entries: { id: string }[] }).top_entries ?? []).some(e => e.id === serverId));
    expect(captureAt).toBeGreaterThanOrEqual(0);
    expect(promoteAt).toBeGreaterThan(captureAt);
    expect(confirmedQueryAt).toBeGreaterThan(promoteAt);
    expect(confirmedPrimeAt).toBeGreaterThan(promoteAt);
    expect(requests.find(r => r.path === '/api/kb/promote')!.body?.reason).toBe(REASON);
    expect(requests.every(r => r.response && !(r.response as { error?: string }).error)).toBe(true);

    // 2. Nothing fell back to the local store: the per-repo SQLite DB holds no
    // row for the id or the title, and the provider's offline queue is empty.
    const providers = await runWithSessionMember(maintainer.id, () => getSelfKbProviders());
    expect(providers.project).toBeInstanceOf(HttpKbProvider);
    const httpProvider = providers.project as HttpKbProvider;
    expect(httpProvider.offlineQueue).toEqual([]);
    const fallback = (httpProvider as unknown as { fallback: SqliteProvider }).fallback;
    const localRows = await fallback.list({ limit: 1000 });
    expect(localRows.map(e => e.id)).not.toContain(serverId);
    expect(localRows.map(e => e.title)).not.toContain(ENTRY_TITLE);

    expect(logs.filter(l => /failed|rejected|WARN/.test(l))).toEqual([]);
  });
});
