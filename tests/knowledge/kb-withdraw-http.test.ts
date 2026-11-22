import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resetKbProviders, getKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { HttpKbProvider, KbHttpUnsupportedError } from '../../src/services/knowledge/http-provider.js';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { FLEET_DIR } from '../../src/paths.js';

// HttpKbProvider.withdraw against a KB server that may or may not serve the
// OPTIONAL withdraw route. The server is a real in-process node:http server
// whose capabilities and answers each test sets; every request is recorded.
// Real git checkout with an origin remote, real kb_setup, real provider
// selection. No mocks.
//
// FALSIFICATION: without HttpKbProvider.withdraw (and withdraw in
// KB_OPTIONAL_ROUTES) every test fails -- the method does not exist, and a
// 404/501 from an unknown route would not be mapped to E-KB-HTTP-UNSUPPORTED.

const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const TOKEN = 'NOT_A_REAL_KEY-kb-withdraw-http-test';
const WITHOUT_WITHDRAW = ['capture', 'query', 'promote', 'context', 'prime', 'invalidate', 'feedback', 'list', 'demote'];
const AT = '2026-01-02T00:00:00.000Z';

interface Seen { method: string; path: string; body: unknown }
type Answer = { status: number; body: unknown };

let server: http.Server;
let port = 0;
let seen: Seen[] = [];
let answers: Map<string, Answer> = new Map();
let scratch: string;
let repo: string;

const sent = () => seen.filter(r => r.path !== '/api/kb/capabilities').map(r => `${r.method} ${r.path}`);

function capabilities(routes: string[]): Answer {
  return { status: 200, body: { contract: 'v1', routes, branch_aware: false } };
}

async function provider(): Promise<HttpKbProvider> {
  const p = (await getKbProviders(repo)).project;
  expect(p).toBeInstanceOf(HttpKbProvider);
  return p as HttpKbProvider;
}

async function errorOf(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(() => null, (e: unknown) => e);
}

beforeAll(async () => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-withdraw-http-'));
  repo = path.join(scratch, 'checkout');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'sprocket.ts'), 'export const ratio = 3;\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', `https://example.test/kb-withdraw-http-${RUN}.git`], { cwd: repo });

  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString(); });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://kb-test');
      seen.push({ method: req.method ?? '', path: url.pathname, body: raw ? JSON.parse(raw) : undefined });
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
    ['/api/kb/withdraw', { status: 200, body: { results: [{ id: 'kb-1', outcome: 'withdrawn' }] } }],
  ]);
  resetKbProviders();
  const result = JSON.parse(await kbSetup({ provider: 'http', remote: `http://127.0.0.1:${port}`, token: TOKEN }, { folder: repo }));
  expect(result.success).toBe(true);
  seen = [];
});

afterEach(() => {
  resetKbProviders();
});

afterAll(async () => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('HttpKbProvider.withdraw', () => {
  it('a server that lists withdraw: POST /api/kb/withdraw with the tombstones, outcomes passed back', async () => {
    answers.set('/api/kb/capabilities', capabilities([...WITHOUT_WITHDRAW, 'withdraw']));
    const out = await (await provider()).withdraw([
      { id: 'kb-1', at: AT, reason: 'withdrawn', note: 'the cited guard was removed', evidence_files: ['src/sprocket.ts'] },
    ]);
    expect(out).toEqual([{ id: 'kb-1', outcome: 'withdrawn' }]);
    expect(sent()).toEqual(['POST /api/kb/withdraw']);
    expect(seen.find(r => r.path === '/api/kb/withdraw')!.body).toEqual({
      withdrawals: [{ id: 'kb-1', at: AT, reason: 'withdrawn', note: 'the cited guard was removed', evidence_files: ['src/sprocket.ts'] }],
    });
  });

  it('a server that does not list withdraw: E-KB-HTTP-UNSUPPORTED naming the route, nothing sent', async () => {
    answers.set('/api/kb/capabilities', capabilities(WITHOUT_WITHDRAW));
    const err = await errorOf(async () => (await provider()).withdraw([{ id: 'kb-1', at: AT, reason: 'withdrawn' }]));
    expect(err).toBeInstanceOf(KbHttpUnsupportedError);
    expect((err as Error).message).toContain('withdraw route');
    expect(sent()).toEqual([]);
  });

  it('a server with no capabilities route never gets the withdraw request (the default route set lacks it)', async () => {
    answers.delete('/api/kb/capabilities');
    const err = await errorOf(async () => (await provider()).withdraw([{ id: 'kb-1', at: AT, reason: 'withdrawn' }]));
    expect(err).toBeInstanceOf(KbHttpUnsupportedError);
    expect(sent()).toEqual([]);
  });

  for (const status of [404, 501]) {
    it(`a ${status} from a server that lists withdraw becomes E-KB-HTTP-UNSUPPORTED, never a raw HTTP error`, async () => {
      answers.set('/api/kb/capabilities', capabilities([...WITHOUT_WITHDRAW, 'withdraw']));
      answers.set('/api/kb/withdraw', { status, body: { error: 'no such route' } });
      const err = await errorOf(async () => (await provider()).withdraw([{ id: 'kb-1', at: AT, reason: 'withdrawn' }]));
      expect(err).toBeInstanceOf(KbHttpUnsupportedError);
      expect((err as { code?: string }).code).toBe('E-KB-HTTP-UNSUPPORTED');
      expect((err as Error).message).toContain(`HTTP ${status}`);
    });
  }

  it('refuses absolute or \'..\' evidence before sending anything; an empty list sends nothing', async () => {
    answers.set('/api/kb/capabilities', capabilities([...WITHOUT_WITHDRAW, 'withdraw']));
    const p = await provider();
    for (const bad of ['/etc/passwd', '../outside.ts', 'C:\\x.ts']) {
      const err = await errorOf(() => p.withdraw([{ id: 'kb-1', at: AT, reason: 'withdrawn', evidence_files: [bad] }]));
      expect((err as Error).message, bad).toMatch(/^E-DEMOTE-EVIDENCE-UNRESOLVED: /);
    }
    expect(await p.withdraw([])).toEqual([]);
    expect(sent()).toEqual([]);
  });

  it('a response without results [{id, outcome}] is an error, not a silent success', async () => {
    answers.set('/api/kb/capabilities', capabilities([...WITHOUT_WITHDRAW, 'withdraw']));
    answers.set('/api/kb/withdraw', { status: 200, body: { results: [{ id: 'kb-1', outcome: 'maybe' }] } });
    const err = await errorOf(async () => (await provider()).withdraw([{ id: 'kb-1', at: AT, reason: 'withdrawn' }]));
    expect((err as Error).message).toMatch(/without results/);
  });
});
