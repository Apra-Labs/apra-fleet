import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { KbHttpUnsupportedError } from '../../src/services/knowledge/http-provider.js';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { kbDemote } from '../../src/tools/kb-demote.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { FLEET_DIR } from '../../src/paths.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

// kb_demote and a MEMBER kb_query own_scope read under the http project
// provider. demote is an OPTIONAL KB server route: fleet sends
// POST /api/kb/demote only when GET /api/kb/capabilities lists it. Without it
// kb_demote, and the own_scope read that exists to find what may be demoted,
// fail with E-KB-HTTP-UNSUPPORTED naming the route, and nothing is sent.
//
// The KB server is a real in-process node:http server whose capabilities each
// test sets; every request (with its body and query) is recorded. Real member
// session (runWithSessionMember), real git checkout with an origin remote,
// real kb_setup and the real tool handlers. No mocks.

const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const TOKEN = 'NOT_A_REAL_KEY-kb-demote-http-test';
const ENTRY_ID = 'srv-entry-1';
const REASON = 'the cited behaviour did not hold on the case checked this round';
const EVIDENCE = ['src/sprocket.ts'];
const WITHOUT_DEMOTE = ['capture', 'query', 'promote', 'context', 'prime', 'invalidate', 'feedback', 'list'];

interface Seen { method: string; path: string; query: string; body: unknown }
type Answer = { status: number; body: unknown };

let server: http.Server;
let port = 0;
let seen: Seen[] = [];
let answers: Map<string, Answer> = new Map();
let scratch: string;
let repo: string;
let memberId: string;

const asMember = <T>(fn: () => Promise<T>): Promise<T> => runWithSessionMember(memberId, fn);
const sent = () => seen.map(r => `${r.method} ${r.path}`);

function capabilities(routes: string[]): Answer {
  return { status: 200, body: { contract: 'v1', routes, branch_aware: false } };
}

function ownRow(): Record<string, unknown> {
  return {
    id: ENTRY_ID, type: 'knowledge', confidence: 'CONFIRMED',
    title: 'Sprocket ratio', summary: 'The sprocket ratio is fixed at build time.',
    content: 'The sprocket ratio is fixed at build time.',
    source_files: ['src/sprocket.ts'], symbols: [], tags: [`member:${memberId}`],
    flagged_for_review: false, contradiction_of: null, stale: false,
  };
}

async function configureHttp(): Promise<void> {
  resetKbProviders();
  const result = JSON.parse(await kbSetup({ provider: 'http', remote: `http://127.0.0.1:${port}`, token: TOKEN }, { folder: repo }));
  expect(result.success).toBe(true);
}

async function errorOf(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(() => null, (e: unknown) => e);
}

beforeAll(async () => {
  backupAndResetRegistry();
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();

  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-demote-http-'));
  repo = path.join(scratch, 'checkout');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'sprocket.ts'), 'export const ratio = 3;\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', `https://example.test/kb-demote-http-${RUN}.git`], { cwd: repo });

  const agent = makeTestLocalAgent({ friendlyName: `kb-demote-http-${RUN}`, workFolder: repo });
  addAgent(agent);
  memberId = agent.id;

  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString(); });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://kb-test');
      seen.push({ method: req.method ?? '', path: url.pathname, query: url.search, body: raw ? JSON.parse(raw) : undefined });
      const answer = answers.get(url.pathname) ?? { status: 404, body: { error: 'Not found', code: 'NOT_FOUND' } };
      res.writeHead(answer.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => {
    port = (server.address() as { port: number }).port;
    resolve();
  }));
});

beforeEach(async () => {
  seen = [];
  answers = new Map([
    ['/api/kb/demote', { status: 200, body: { id: ENTRY_ID, previous_confidence: 'CONFIRMED', new_confidence: 'INFERRED' } }],
    ['/api/kb/query', { status: 200, body: { results: [ownRow()], total: 1, l1_only: false } }],
  ]);
  await configureHttp();
});

afterEach(() => {
  resetKbProviders();
});

afterAll(async () => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
  restoreRegistry();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('kb_demote under the http provider', () => {
  it('a server that lists demote: POST /api/kb/demote by id with reason and evidence, answer passed back', async () => {
    answers.set('/api/kb/capabilities', capabilities([...WITHOUT_DEMOTE, 'demote']));
    const out = JSON.parse(await asMember(() => kbDemote({ id: ENTRY_ID, reason: REASON, evidence_files: EVIDENCE })));
    expect(out).toEqual({ id: ENTRY_ID, previous_confidence: 'CONFIRMED', new_confidence: 'INFERRED' });
    expect(sent()).toEqual(['GET /api/kb/capabilities', 'POST /api/kb/demote']);
    expect(seen[1].body).toEqual({ id: ENTRY_ID, reason: REASON, evidence_files: EVIDENCE });
  });

  it('a server that does not list demote: E-KB-HTTP-UNSUPPORTED naming the route, in MEMBER and FULL sessions, nothing sent', async () => {
    answers.set('/api/kb/capabilities', capabilities(WITHOUT_DEMOTE));
    const asMemberErr = await errorOf(() => asMember(() => kbDemote({ id: ENTRY_ID, reason: REASON, evidence_files: EVIDENCE })));
    const asFullErr = await errorOf(() => kbDemote({ id: ENTRY_ID, reason: REASON, evidence_files: EVIDENCE }, { folder: repo }));
    for (const err of [asMemberErr, asFullErr]) {
      expect(err).toBeInstanceOf(KbHttpUnsupportedError);
      expect((err as Error).message).toContain('the demote route');
    }
    expect(sent().filter(s => s !== 'GET /api/kb/capabilities')).toEqual([]);
  });

  it('a server with no capabilities route (pre-capabilities route set) is not sent a demote', async () => {
    const err = await errorOf(() => asMember(() => kbDemote({ id: ENTRY_ID, reason: REASON, evidence_files: EVIDENCE })));
    expect((err as { code?: string }).code).toBe('E-KB-HTTP-UNSUPPORTED');
    expect(sent()).toEqual(['GET /api/kb/capabilities']);
  });

  it('a listed demote route that answers 501 is E-KB-HTTP-UNSUPPORTED; a 404 naming an unknown entry is not found', async () => {
    answers.set('/api/kb/capabilities', capabilities([...WITHOUT_DEMOTE, 'demote']));
    answers.set('/api/kb/demote', { status: 501, body: { error: 'not implemented' } });
    const unsupported = await errorOf(() => asMember(() => kbDemote({ id: ENTRY_ID, reason: REASON, evidence_files: EVIDENCE })));
    expect((unsupported as { code?: string }).code).toBe('E-KB-HTTP-UNSUPPORTED');
    expect((unsupported as Error).message).toContain('the demote route');

    answers.set('/api/kb/demote', { status: 404, body: { error: 'no such entry', code: 'ENTRY_NOT_FOUND' } });
    const notFound = await errorOf(() => asMember(() => kbDemote({ id: 'unknown-id', reason: REASON, evidence_files: EVIDENCE })));
    expect((notFound as Error).message).toMatch(/^Entry not found: unknown-id/);
  });
});

describe('MEMBER kb_query own_scope under the http provider', () => {
  const ownScopeRead = () => kbQuery({ query: 'sprocket', confidence: ['CONFIRMED'], own_scope: true, include_stale: true });

  it('a server that does not list demote: E-KB-HTTP-UNSUPPORTED naming demote, no query sent', async () => {
    answers.set('/api/kb/capabilities', capabilities(WITHOUT_DEMOTE));
    const err = await errorOf(() => asMember(ownScopeRead));
    expect(err).toBeInstanceOf(KbHttpUnsupportedError);
    expect((err as Error).message).toContain('own_scope');
    expect((err as Error).message).toContain('demote route');
    expect(sent()).toEqual(['GET /api/kb/capabilities']);
  });

  it('a server that lists demote: answered by the server with the caller\'s own entries', async () => {
    answers.set('/api/kb/capabilities', capabilities([...WITHOUT_DEMOTE, 'demote']));
    const out = JSON.parse(await asMember(ownScopeRead));
    expect(out.l1_results.map((r: { id: string }) => r.id)).toEqual([ENTRY_ID]);
    expect(sent()).toContain('GET /api/kb/query');
  });

  it('a read without own_scope is not gated on demote', async () => {
    answers.set('/api/kb/capabilities', capabilities(WITHOUT_DEMOTE));
    await asMember(() => kbQuery({ query: 'sprocket', confidence: ['CONFIRMED'] }));
    expect(sent()).toContain('GET /api/kb/query');
  });
});
