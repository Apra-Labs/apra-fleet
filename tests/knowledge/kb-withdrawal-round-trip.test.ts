import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { kbBibleCommit } from '../../src/tools/kb-bible-commit.js';
import { kbImport } from '../../src/tools/kb-import.js';
import { startKbServer } from '../../src/commands/kb-server.js';
import { importBibleEntries, readBibleDocument } from '../../src/services/knowledge/bible-import.js';
import { getMemberBibleView, resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import { encryptPassword } from '../../src/utils/crypto.js';
import { FLEET_DIR } from '../../src/paths.js';
import type { KBEntry, KBEntryInput } from '../../src/services/knowledge/types.js';
import { commitWorkTree } from '../helpers/commit-work-tree.js';

// The merge-carried withdrawal, end to end: a branch tombstone written by
// kb_bible_commit, the branch merged into the base and pushed, and kb_import
// of the merged base bible read at refs/remotes/origin/<base>. Both providers.
//
// Real everything: real git (a bare origin, clones, branches, merge, push,
// fetch), the real kb_bible_commit / kb_import handlers, real SqliteProviders,
// and for http the real bundled kb-server (startKbServer) behind a small
// recording proxy, reached through the real HttpKbProvider. The one seam is
// getKbProviders for the SQLite scenarios (it points the handlers at this
// test's providers, as kb-tombstone-import.test.ts does); the http scenario
// selects its provider from a real http KB config file.
//
// FALSIFICATION: on a tree without the feature (main before the withdrawal
// work) kb_bible_commit ignores withdrawals/restore_ids and kb_import reports
// no withdrawals block and replays nothing, so every scenario fails (checked by
// running this file against main's src/).
//
// All temp state lives under one root removed (and asserted removed) in
// afterEach; the KB config file is restored to what it was before.

const NOTE = 'Re-read the cited file: the guard the entry describes was removed.';
const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');
const TOKEN = 'NOT_A_REAL_KEY-kb-withdrawal-round-trip';
const PROMOTE_REASON = 'Checked against src/widget.ts: the widget is exported as described.';

let root: string;
let origin: string;
let cloneA: string;
let cloneB: string;
let providerA: SqliteProvider;
let providerB: SqliteProvider;
let savedConfig: string | null;

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function cloneOf(name: string): string {
  const dir = path.join(root, name);
  execFileSync('git', ['clone', '--quiet', origin, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

function makeInput(over: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge', title: 'T', summary: 'Summary', content: 'Content body.',
    source_files: ['src/y.ts'], symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256',
    flagged_for_review: false, author: 'test-agent', source: 'doer', confidence: 'INFERRED',
    ...over,
  };
}

function row(provider: SqliteProvider, id: string): { confidence: string } | undefined {
  return (provider as any).getDb().prepare('SELECT confidence FROM entries WHERE id = ?').get(id);
}

function bibleOf(dir: string): { entries: Array<Record<string, unknown>>; demotions?: Array<Record<string, unknown>> } {
  return JSON.parse(fs.readFileSync(path.join(dir, '.fleet', 'kb-canonical.json'), 'utf-8'));
}

async function importB(ref?: string): Promise<any> {
  return JSON.parse(await kbImport(ref === undefined ? { skip_sweep: true } : { ref, skip_sweep: true }, { folder: cloneB }));
}

/**
 * Clone A captures and confirms Y citing src/y.ts and publishes it in the base
 * bible on main (pushed); clone B fetches main and imports it, so B holds Y
 * CONFIRMED from the bible. Returns Y's id and the base commit.
 */
async function publishBaseEntry(): Promise<{ y: string; baseCommit: string }> {
  fs.mkdirSync(path.join(cloneA, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cloneA, 'src', 'y.ts'), 'export const y = 1;\n');
  commitWorkTree(cloneA, 'src/y.ts');
  const { id: y } = await providerA.capture(makeInput({ title: 'Ypsilon', summary: 'Summary of Ypsilon', symbols: ['symYpsilon'] }));
  await providerA.promote(y, 'test fixture: verified');
  await providerA.promote(y, 'test fixture: verified');
  const baseHead = git(cloneA, ['rev-parse', 'HEAD']).trim();
  const merged = JSON.parse(await kbBibleCommit({ ids: [y], baseBranch: 'main', baseCommit: baseHead }, { folder: cloneA }));
  expect(merged.merged).toEqual([y]);
  git(cloneA, ['push', '--quiet', 'origin', 'main']);

  git(cloneB, ['pull', '--quiet', 'origin', 'main']);
  const first = await importB('refs/remotes/origin/main');
  expect(first.imported).toBe(1);
  expect(row(providerB, y)!.confidence).toBe('CONFIRMED');
  return { y, baseCommit: git(cloneA, ['rev-parse', 'HEAD']).trim() };
}

/** Merge feat/w into main on clone A, push, and fetch on clone B. */
function mergeAndFetch(): void {
  git(cloneA, ['checkout', '--quiet', 'main']);
  git(cloneA, ['merge', '--quiet', '--no-ff', '-m', 'merge feat/w', 'feat/w']);
  git(cloneA, ['push', '--quiet', 'origin', 'main']);
  git(cloneB, ['fetch', '--quiet', 'origin']);
}

beforeEach(async () => {
  savedConfig = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH, 'utf-8') : null;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-withdrawal-round-trip-')));
  origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin]);
  const seed = cloneOf('seed');
  git(seed, ['checkout', '--quiet', '-B', 'main']);
  fs.writeFileSync(path.join(seed, 'README.md'), 'seed\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '--quiet', '-m', 'seed']);
  git(seed, ['push', '--quiet', 'origin', 'main']);
  cloneA = cloneOf('clone-a');
  cloneB = cloneOf('clone-b');

  providerA = new SqliteProvider(path.join(root, 'kb-a.sqlite'), cloneA);
  providerB = new SqliteProvider(path.join(root, 'kb-b.sqlite'), cloneB);
  await providerA.init();
  await providerB.init();
});

afterEach(() => {
  providerA.close();
  providerB.close();
  resetMemberBibleViews();
  kbProvidersModule.resetKbProviders();
  vi.restoreAllMocks();
  if (savedConfig === null) fs.rmSync(KB_CONFIG_PATH, { force: true });
  else fs.writeFileSync(KB_CONFIG_PATH, savedConfig);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  expect(fs.existsSync(root)).toBe(false);
});

/** Route the SQLite scenarios' handlers to the two clones' providers. */
function useSqliteProviders(): void {
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockImplementation(async (folder: string) => {
    const provider = path.resolve(folder) === path.resolve(cloneA) ? providerA : providerB;
    return { project: provider, global: provider, projectSlug: 'test' } as any;
  });
}

describe('merge-carried withdrawals, end to end', () => {
  it('scenario 1 (SQLite): branch tombstone, deferred before the merge, applied from the merged base ref', async () => {
    useSqliteProviders();
    const { y } = await publishBaseEntry();

    // --- clone A withdraws Y on a feature branch ---
    git(cloneA, ['checkout', '--quiet', '-b', 'feat/w']);
    const baseCommit = git(cloneA, ['rev-parse', 'main']).trim();
    const commit = JSON.parse(await kbBibleCommit({
      ids: [], withdrawals: [{ id: y, note: NOTE, evidence_files: ['src/y.ts'] }], baseBranch: 'main', baseCommit,
    }, { folder: cloneA }));
    expect(commit.withdrawn).toEqual([y]);
    expect(commit.committed).toBe(true);
    const branchBible = bibleOf(cloneA);
    expect(branchBible.entries.map(e => e.id)).not.toContain(y);
    expect(branchBible.demotions).toEqual([
      { id: y, at: expect.any(String), reason: 'withdrawn', note: NOTE, evidence_files: ['src/y.ts'] },
    ]);
    // The withdrawing clone's own row is NOT changed.
    expect(row(providerA, y)!.confidence).toBe('CONFIRMED');
    git(cloneA, ['push', '--quiet', 'origin', 'feat/w']);

    // --- clone B sees the branch before it merges: nothing lowered ---
    git(cloneB, ['fetch', '--quiet', 'origin']);
    git(cloneB, ['checkout', '--quiet', '-b', 'feat/w', 'refs/remotes/origin/feat/w']);
    for (const ref of [undefined, 'HEAD', 'refs/remotes/origin/feat/w']) {
      const report = await importB(ref);
      expect(report.withdrawals.deferred, String(ref)).toEqual([y]);
      expect(report.withdrawals.withdrawn, String(ref)).toEqual([]);
      expect(row(providerB, y)!.confidence, String(ref)).toBe('CONFIRMED');
    }
    const view = await getMemberBibleView({ folder: cloneB });
    expect((await view.list({})).map((e: KBEntry) => e.id)).not.toContain(y);

    // --- merge, push, fetch: the base-ref import applies it ---
    mergeAndFetch();
    const applied = await importB('refs/remotes/origin/main');
    expect(applied.bible_source).toBe('refs/remotes/origin/main');
    expect(applied.withdrawals).toEqual({
      sent: 1, withdrawn: [y], repromoted: [], already: [], not_found: [], unsupported: [], deferred: [],
    });
    expect(row(providerB, y)!.confidence).toBe('INFERRED');
  });

  it('scenario 2 (SQLite): restore_ids before the merge removes the tombstone and re-adds the base entry byte-identical', async () => {
    useSqliteProviders();
    const { y } = await publishBaseEntry();
    const baseEntry = bibleOf(cloneA).entries.find(e => e.id === y);
    expect(baseEntry).toBeDefined();

    git(cloneA, ['checkout', '--quiet', '-b', 'feat/w']);
    const baseCommit = git(cloneA, ['rev-parse', 'main']).trim();
    await kbBibleCommit({
      ids: [], withdrawals: [{ id: y, note: NOTE, evidence_files: ['src/y.ts'] }], baseBranch: 'main', baseCommit,
    }, { folder: cloneA });
    expect(bibleOf(cloneA).demotions?.map(d => d.id)).toEqual([y]);

    const restore = JSON.parse(await kbBibleCommit({ ids: [], restore_ids: [y], baseBranch: 'main', baseCommit }, { folder: cloneA }));
    expect(restore.restored).toEqual([y]);
    const restored = bibleOf(cloneA);
    expect(restored.demotions ?? []).toEqual([]);
    expect(JSON.stringify(restored.entries.find(e => e.id === y))).toBe(JSON.stringify(baseEntry));

    mergeAndFetch();
    const report = await importB('refs/remotes/origin/main');
    expect(report.withdrawals).toEqual({
      sent: 0, withdrawn: [], repromoted: [], already: [], not_found: [], unsupported: [], deferred: [],
    });
    expect(row(providerB, y)!.confidence).toBe('CONFIRMED');
  });

  it('scenario 3 (http): tombstone-only bible; one POST /api/kb/withdraw from the base ref; already on repeat; unsupported without the route', async () => {
    // The real kb-server serves clone A's project (its cwd decides the slug),
    // behind a proxy that records every request and can hide withdraw from
    // the capabilities answer.
    const dbPath = path.join(root, 'server.db');
    const tokenFile = path.join(root, 'token');
    fs.writeFileSync(tokenFile, TOKEN);
    fs.mkdirSync(path.join(cloneA, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cloneA, 'src', 'widget.ts'), 'export const widget = 1;\n');
    commitWorkTree(cloneA, 'src/widget.ts');
    git(cloneA, ['push', '--quiet', 'origin', 'main']);
    const cwd = process.cwd();
    process.chdir(cloneA);
    let server: http.Server;
    try {
      server = await startKbServer(0, false, dbPath, tokenFile);
    } finally {
      process.chdir(cwd);
    }
    const serverPort = (server.address() as AddressInfo).port;
    const seen: string[] = [];
    let hideWithdraw = false;
    const proxy = http.createServer((req, res) => {
      seen.push(`${req.method} ${new URL(req.url ?? '/', 'http://proxy').pathname}`);
      const upstream = http.request({
        hostname: '127.0.0.1', port: serverPort, path: req.url, method: req.method, headers: req.headers, agent: false,
      }, up => {
        let body = '';
        up.on('data', (c: Buffer) => { body += c.toString(); });
        up.on('end', () => {
          if (hideWithdraw && req.url?.startsWith('/api/kb/capabilities')) {
            const caps = JSON.parse(body);
            caps.routes = caps.routes.filter((r: string) => r !== 'withdraw');
            body = JSON.stringify(caps);
          }
          const headers = { ...up.headers, 'content-length': String(Buffer.byteLength(body)) };
          res.writeHead(up.statusCode ?? 500, headers);
          res.end(body);
        });
      });
      req.pipe(upstream);
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', () => resolve()));
    const proxyPort = (proxy.address() as AddressInfo).port;
    try {
      fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
      fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify(
        { provider: 'http', url: `http://127.0.0.1:${proxyPort}`, token_encrypted: encryptPassword(TOKEN) }, null, 2));
      kbProvidersModule.resetKbProviders();
      const provider = (await kbProvidersModule.getKbProviders(cloneA)).project;
      expect(provider).toBeInstanceOf(HttpKbProvider);
      const http_ = provider as HttpKbProvider;
      const { id } = await http_.capture(makeInput({
        title: 'Widget export', summary: 'src/widget.ts exports widget as a constant.', source_files: ['src/widget.ts'],
        symbols: ['widget'],
      }));
      await http_.promote(id, PROMOTE_REASON);

      // --- the branch writes a tombstone-only bible ---
      git(cloneA, ['checkout', '--quiet', '-b', 'feat/w']);
      const baseCommit = git(cloneA, ['rev-parse', 'main']).trim();
      const commit = JSON.parse(await kbBibleCommit({
        ids: [], withdrawals: [{ id, note: NOTE, evidence_files: ['src/widget.ts'] }], baseBranch: 'main', baseCommit,
      }, { folder: cloneA }));
      expect(commit.withdrawn).toEqual([id]);
      expect(commit.committed).toBe(true);
      const bible = bibleOf(cloneA);
      expect(bible.entries).toEqual([]);
      expect(bible.demotions!.map(d => [d.id, d.reason])).toEqual([[id, 'withdrawn']]);

      // Before the merge, nothing is sent.
      seen.length = 0;
      const early = JSON.parse(await kbImport({ ref: 'HEAD' }, { folder: cloneA }));
      expect(early.withdrawals.deferred).toEqual([id]);
      expect(seen.filter(s => s === 'POST /api/kb/withdraw')).toEqual([]);

      // --- merge into main, push, fetch; the base-ref import replays it ---
      git(cloneA, ['checkout', '--quiet', 'main']);
      git(cloneA, ['merge', '--quiet', '--no-ff', '-m', 'merge feat/w', 'feat/w']);
      git(cloneA, ['push', '--quiet', 'origin', 'main']);
      git(cloneA, ['fetch', '--quiet', 'origin']);
      seen.length = 0;
      const replay = JSON.parse(await kbImport({ ref: 'refs/remotes/origin/main' }, { folder: cloneA }));
      expect(seen.filter(s => s === 'POST /api/kb/withdraw')).toHaveLength(1);
      expect(replay.bible_skipped).toBe(true);
      expect(replay.bible_source).toBe('refs/remotes/origin/main');
      expect(replay.withdrawals).toEqual({
        sent: 1, withdrawn: [id], repromoted: [], already: [], not_found: [], unsupported: [], deferred: [],
      });
      // The server's entry is now INFERRED, no longer CONFIRMED.
      expect((await http_.list({ confidence: ['INFERRED'] })).map(e => e.id)).toContain(id);
      expect((await http_.list({ confidence: ['CONFIRMED'] })).map(e => e.id)).not.toContain(id);

      // A second import of the same merged bible: already.
      seen.length = 0;
      const again = JSON.parse(await kbImport({ ref: 'refs/remotes/origin/main' }, { folder: cloneA }));
      expect(seen.filter(s => s === 'POST /api/kb/withdraw')).toHaveLength(1);
      expect(again.withdrawals.already).toEqual([id]);

      // A server whose capabilities omit withdraw: nothing sent, unsupported plus a WARN naming the route.
      hideWithdraw = true;
      kbProvidersModule.resetKbProviders();
      const warns: string[] = [];
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { warns.push(args.join(' ')); });
      seen.length = 0;
      const unsupported = JSON.parse(await kbImport({ ref: 'refs/remotes/origin/main' }, { folder: cloneA }));
      expect(seen.filter(s => s === 'POST /api/kb/withdraw')).toEqual([]);
      expect(unsupported.withdrawals.unsupported).toEqual([id]);
      expect(unsupported.withdrawals.sent).toBe(0);
      expect(warns.some(w => w.includes('[fleet:warn] kb_import E-KB-HTTP-UNSUPPORTED') && w.includes('withdraw route'))).toBe(true);
    } finally {
      kbProvidersModule.resetKbProviders();
      proxy.closeAllConnections();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('scenario 4 (upgrade safety): the reader path that knows only "demoted" excludes a withdrawn entry from the view and lowers nothing', async () => {
    useSqliteProviders();
    const { y } = await publishBaseEntry();
    git(cloneA, ['checkout', '--quiet', '-b', 'feat/w']);
    await kbBibleCommit({
      ids: [], withdrawals: [{ id: y, note: NOTE, evidence_files: ['src/y.ts'] }],
      baseBranch: 'main', baseCommit: git(cloneA, ['rev-parse', 'main']).trim(),
    }, { folder: cloneA });

    // The bible as the new writer left it, read by the entry/tombstone reader
    // a 0.4.5 clone runs: importBibleEntries acts only on "demoted".
    const doc = readBibleDocument(path.join(cloneA, '.fleet', 'kb-canonical.json'), 'test');
    expect(doc.demotions.map(d => d.reason)).toEqual(['withdrawn']);
    const counts = await importBibleEntries(providerB, doc.entries, { demotions: doc.demotions });
    expect(counts.demoted).toBe(0);
    expect(row(providerB, y)!.confidence).toBe('CONFIRMED');

    // A hand-edited bible that still lists the entry next to the tombstone:
    // the unknown-to-the-reader reason is a view exclusion only.
    const both = { ...bibleOf(cloneA) };
    both.entries = [...both.entries, ...JSON.parse(git(cloneA, ['show', 'main:.fleet/kb-canonical.json'])).entries];
    fs.mkdirSync(path.join(cloneB, '.fleet'), { recursive: true });
    fs.writeFileSync(path.join(cloneB, '.fleet', 'kb-canonical.json'), JSON.stringify(both));
    const view = await getMemberBibleView({ folder: cloneB });
    expect((await view.list({})).map((e: KBEntry) => e.id)).not.toContain(y);
    const viaReader = await importBibleEntries(providerB, both.entries, { demotions: readBibleDocument(path.join(cloneB, '.fleet', 'kb-canonical.json'), 'test').demotions });
    expect(viaReader.demoted).toBe(0);
    expect(row(providerB, y)!.confidence).toBe('CONFIRMED');
  });
});
