import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { kbImport, KB_IMPORT_HTTP_SKIP_REASON } from '../../src/tools/kb-import.js';
import { FLEET_DIR } from '../../src/paths.js';
import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

// kb_import under an http project KB: no entry is imported, but the merged
// base bible's "withdrawn" tombstones are replayed in ONE POST /api/kb/withdraw
// when the bible was read at refs/remotes/origin/<provenance.branch>. Any
// other source reports them deferred and sends nothing; a server without the
// route reports them unsupported with an E-KB-HTTP-UNSUPPORTED warning.
// A real in-process node:http server records every request; real git
// checkout, real kb_setup, real provider selection. No mocks of the code
// under test (console.error is spied only to read the WARN line).
//
// FALSIFICATION: on a tree without the replay (kb_import returns all-zero
// counts over http and never reads the bible) no request is sent and the
// report has no withdrawals block, so every test here fails (checked by
// stashing src/tools/kb-import.ts and src/services/knowledge/bible-import.ts).

const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const TOKEN = 'NOT_A_REAL_KEY-kb-import-withdrawals-http-test';
const BASE_ROUTES = ['capture', 'query', 'promote', 'context', 'prime', 'invalidate', 'feedback', 'list', 'demote'];
const AT = '2026-01-02T00:00:00.000Z';
const NOTE = 'the cited guard was removed when the reader was rewritten';

interface Seen { method: string; path: string; body: unknown }
type Answer = { status: number; body: unknown };

let server: http.Server;
let port = 0;
let seen: Seen[] = [];
let answers: Map<string, Answer> = new Map();
let scratch: string;
let repo: string;
let savedConfig: string | null;
let memberId: string;

const sent = () => seen.filter(r => r.path !== '/api/kb/capabilities').map(r => `${r.method} ${r.path}`);
const capabilities = (routes: string[]): Answer => ({ status: 200, body: { contract: 'v1', routes, branch_aware: false } });

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function importAt(ref?: string): Promise<any> {
  return JSON.parse(await kbImport(ref === undefined ? {} : { ref }, { folder: repo }));
}

beforeAll(async () => {
  savedConfig = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH, 'utf-8') : null;
  backupAndResetRegistry();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-import-withdrawals-http-'));
  repo = path.join(scratch, 'checkout');
  fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(['config', 'user.name', 'test']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['remote', 'add', 'origin', `https://example.test/kb-import-withdrawals-http-${RUN}.git`]);
  // A tombstone-only bible, as kb_bible_commit writes it in an http repo.
  const bible = {
    version: 3, provenance: { commit: 'b'.repeat(40), branch: 'main', entry_count: 0 }, entries: [],
    demotions: [
      { id: 'kb-1', at: AT, reason: 'withdrawn', note: NOTE, evidence_files: ['src/a.ts'] },
      { id: 'kb-2', at: AT, reason: 'demoted' },
    ],
  };
  fs.writeFileSync(path.join(repo, '.fleet', 'kb-canonical.json'), JSON.stringify(bible, null, 2) + '\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'bible']);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(['update-ref', 'refs/remotes/origin/feat/x', 'HEAD']);
  // As git clone records it: the remote's default branch is main.
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  // A base ref whose tree holds no bible: the normal state of an http repo
  // until its first withdrawal merges.
  const emptyTree = execFileSync('git', ['mktree'], { cwd: repo, encoding: 'utf-8', input: '' }).trim();
  const noBible = git(['commit-tree', emptyTree, '-m', 'no bible']).trim();
  git(['update-ref', 'refs/remotes/origin/nobible', noBible]);

  const agent = makeTestLocalAgent({ friendlyName: `kb-import-withdrawals-http-${RUN}`, workFolder: repo });
  addAgent(agent);
  memberId = agent.id;

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
  answers = new Map([
    ['/api/kb/capabilities', capabilities([...BASE_ROUTES, 'withdraw'])],
    ['/api/kb/withdraw', { status: 200, body: { results: [{ id: 'kb-1', outcome: 'withdrawn' }] } }],
  ]);
  resetKbProviders();
  const result = JSON.parse(await kbSetup({ provider: 'http', remote: `http://127.0.0.1:${port}`, token: TOKEN }, { folder: repo }));
  expect(result.success).toBe(true);
  seen = [];
});

afterEach(() => {
  resetKbProviders();
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (savedConfig === null) fs.rmSync(KB_CONFIG_PATH, { force: true });
  else fs.writeFileSync(KB_CONFIG_PATH, savedConfig);
  resetKbProviders();
  restoreRegistry();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('kb_import replays merged withdrawals to the KB server (http)', () => {
  it('base ref: exactly one POST /api/kb/withdraw carrying the withdrawn tombstone only; outcomes reported', async () => {
    const report = await importAt('refs/remotes/origin/main');
    expect(sent()).toEqual(['POST /api/kb/withdraw']);
    expect(seen.find(r => r.path === '/api/kb/withdraw')!.body).toEqual({
      withdrawals: [{ id: 'kb-1', at: AT, reason: 'withdrawn', note: NOTE, evidence_files: ['src/a.ts'] }],
    });
    expect(report.bible_skipped).toBe(true);
    expect(report.imported).toBe(0);
    expect(report.bible_source).toBe('refs/remotes/origin/main');
    expect(report.withdrawals).toEqual({
      sent: 1, withdrawn: ['kb-1'], repromoted: [], already: [], not_found: [], unsupported: [], deferred: [],
    });
  });

  it('a repeat answered not_confirmed reports already; a re-promoted entry reports repromoted', async () => {
    answers.set('/api/kb/withdraw', { status: 200, body: { results: [{ id: 'kb-1', outcome: 'not_confirmed' }] } });
    expect((await importAt('refs/remotes/origin/main')).withdrawals.already).toEqual(['kb-1']);
    answers.set('/api/kb/withdraw', { status: 200, body: { results: [{ id: 'kb-1', outcome: 'repromoted' }] } });
    expect((await importAt('refs/remotes/origin/main')).withdrawals.repromoted).toEqual(['kb-1']);
  });

  it('work tree, HEAD or a feature ref: nothing is sent and the id is deferred', async () => {
    for (const ref of [undefined, 'HEAD', 'refs/remotes/origin/feat/x']) {
      const report = await importAt(ref);
      expect(report.withdrawals, String(ref)).toEqual({
        sent: 0, withdrawn: [], repromoted: [], already: [], not_found: [], unsupported: [], deferred: ['kb-1'],
      });
    }
    expect(sent()).toEqual([]);
  });

  it('a ref that holds no bible: the all-zero bible_skipped report with bible_source, nothing sent', async () => {
    const report = await importAt('refs/remotes/origin/nobible');
    expect(report).toEqual({
      imported: 0, skipped: 0, linked: 0, flagged: 0, rejected: 0, demoted: 0,
      sweep: { checked: 0, staled: 0, unstaled: 0 },
      bible_skipped: true, reason: KB_IMPORT_HTTP_SKIP_REASON, bible_source: 'refs/remotes/origin/nobible',
      withdrawals: { sent: 0, withdrawn: [], repromoted: [], already: [], not_found: [], unsupported: [], deferred: [] },
    });
    expect(sent()).toEqual([]);
  });

  it('a member session without the kb_maintainer grant: base ref read, nothing sent, the id is deferred', async () => {
    const member = JSON.parse(await runWithSessionMember(memberId, () => kbImport({ ref: 'refs/remotes/origin/main' })));
    expect(member.bible_source).toBe('refs/remotes/origin/main');
    expect(member.withdrawals).toEqual({
      sent: 0, withdrawn: [], repromoted: [], already: [], not_found: [], unsupported: [], deferred: ['kb-1'],
    });
    expect(sent()).toEqual([]);
    // Control: the same member session WITH the grant replays it.
    const maintainer = JSON.parse(await runWithSessionMember(
      memberId, () => kbImport({ ref: 'refs/remotes/origin/main' }), { kbMaintainer: true },
    ));
    expect(maintainer.withdrawals.sent).toBe(1);
    expect(sent()).toEqual(['POST /api/kb/withdraw']);
  });

  it('a server whose capabilities omit withdraw: nothing sent, unsupported plus a WARN naming the route', async () => {
    answers.set('/api/kb/capabilities', capabilities(BASE_ROUTES));
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
    const report = await importAt('refs/remotes/origin/main');
    expect(sent()).toEqual([]);
    expect(report.withdrawals.unsupported).toEqual(['kb-1']);
    expect(report.withdrawals.sent).toBe(0);
    expect(report.withdrawals.warning).toMatch(/^E-KB-HTTP-UNSUPPORTED: the withdraw route/);
    expect(errors.some(l => l.includes('[fleet:warn] kb_import E-KB-HTTP-UNSUPPORTED') && l.includes('withdraw route'))).toBe(true);
  });
});
