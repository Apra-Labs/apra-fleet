import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbImport } from '../../src/tools/kb-import.js';
import { startKbServer } from '../../src/commands/kb-server.js';
import { getProjectSlug, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// A bible entry that AUDN routes on a fresh clone -- LINKED to a related local
// entry ('update') or DEDUPLICATED against a near-identical one ('none') -- must
// still be reachable by a later tombstone for its BIBLE id. Before the fix the
// linked entry was stored under a fresh random id and the deduplicated one left
// no trace of its bible id, so a merged withdrawn tombstone answered not_found
// on exactly those clones and the row stayed CONFIRMED.
//
// Both tombstone paths are exercised against one real SqliteProvider file over
// a real temp git checkout: the real kb_import handler (reading the merged base
// bible at refs/remotes/origin/main), and a real startKbServer instance serving
// the same sqlite file through POST /api/kb/withdraw. The only spy is
// getKbProviders, pointing the kb_import handler at this test's provider.
//
// FALSIFICATION: with src/services/knowledge/sqlite-provider.ts reverted to the
// previous commit (git stash), every test here fails -- the linked and
// deduplicated bible ids answer not_found and the rows stay CONFIRMED,
// reproducing the cross-clone finding.
//
// All temp state lives under one root removed in afterEach.

const NOTE = 'the cited guard was removed when the reader was rewritten';
const BIBLE_UPDATED_AT = '2020-01-01T00:00:00.000Z';
const TOMBSTONE_AT = '2021-06-01T00:00:00.000Z';
const TOKEN = 'kb-import-audn-ids-token';

const LINKED_ID = 'bible-linked-0001';
const DEDUP_ID = 'bible-dedup-0002';
const LOCAL_DUP_ID = 'local-dup-0003';
const DUP_SUMMARY = 'The widget reader caches the parsed header for the rest of the session.';

let root: string;
let repo: string;
let dbPath: string;
let provider: SqliteProvider | undefined;
let server: http.Server | undefined;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function db(): any {
  return (provider as any).getDb();
}

function rowOf(id: string): { confidence: string; content: string } | undefined {
  return db().prepare('SELECT confidence, content FROM entries WHERE id = ?').get(id);
}

function bibleEntry(id: string, title: string, summary: string, symbols: string[]) {
  return {
    id, type: 'knowledge', title, summary, symbols, source_files: ['src/y.ts'],
    confidence: 'CONFIRMED', updated_at: BIBLE_UPDATED_AT,
  };
}

function writeBible(entries: unknown[], demotions: unknown[]): void {
  const bible = {
    version: 3,
    provenance: { commit: 'b'.repeat(40), branch: 'main', entry_count: entries.length },
    entries,
    demotions,
  };
  fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.fleet', 'kb-canonical.json'), JSON.stringify(bible, null, 2) + '\n');
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'bible']);
}

async function importAt(ref?: string): Promise<any> {
  const input: Record<string, unknown> = { skip_sweep: true };
  if (ref !== undefined) input.ref = ref;
  return JSON.parse(await kbImport(input as any, { folder: repo }));
}

/**
 * The fresh clone's state before the bible carrying X and Y arrives: a related
 * CONFIRMED entry captured and promoted here (X will link to it), and a
 * CONFIRMED row holding exactly Y's text under another id (Y will dedupe into
 * it). Then the bible with X and Y is imported, and the AUDN routing asserted.
 */
async function seedCloneAndImportXY(): Promise<string> {
  const related: KBEntryInput = {
    type: 'knowledge', title: 'Widget reader parses headers lazily',
    summary: 'The widget reader parses the header only when first asked for it.',
    content: 'The widget reader parses the header only when first asked for it.',
    source_files: ['src/y.ts'], symbols: ['readWidgetHeader'], tags: [], content_hash: '',
    content_hash_type: 'sha256', flagged_for_review: false, author: 'test-agent', source: 'doer',
    confidence: 'INFERRED',
  };
  const { id: relatedId } = await provider!.capture(related);
  await provider!.promote(relatedId, 'test fixture: verified against src/y.ts');
  await provider!.promote(relatedId, 'test fixture: verified against src/y.ts');
  expect(rowOf(relatedId)?.confidence).toBe('CONFIRMED');

  // The near-duplicate arrives through an earlier bible, under its own id.
  writeBible([bibleEntry(LOCAL_DUP_ID, 'Widget header cache', DUP_SUMMARY, ['cacheWidgetHeader'])], []);
  const seed = await importAt();
  expect(seed.imported).toBe(1);
  expect(rowOf(LOCAL_DUP_ID)?.confidence).toBe('CONFIRMED');

  writeBible([
    bibleEntry(LINKED_ID, 'Widget reader header parse is deferred',
      'Header parsing in the widget reader is deferred until a caller reads a field.', ['readWidgetHeader']),
    bibleEntry(DEDUP_ID, 'Widget header cache', DUP_SUMMARY, ['cacheWidgetHeader']),
  ], []);
  const report = await importAt();
  expect(report.linked).toBe(1);
  expect(report.skipped).toBe(1);
  expect(report.imported).toBe(0);
  return relatedId;
}

function call(port: number, method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'X-KB-Project': getProjectSlug(repo),
    };
    if (data) headers['Content-Length'] = Buffer.byteLength(data).toString();
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers, agent: false }, res => {
      let raw = '';
      res.on('data', (c: Buffer) => { raw += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : undefined }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-import-audn-ids-'));
  repo = path.join(root, 'repo');
  dbPath = path.join(root, 'kb.sqlite');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'y.ts'), 'export const y = 1;\n');
  execFileSync('git', ['init', '--quiet', '-b', 'main', repo]);
  git(['config', 'user.name', 'test']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['remote', 'add', 'origin', 'https://example.test/kb-import-audn-ids.git']);
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'seed']);
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  provider = new SqliteProvider(dbPath, repo);
  await provider.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockImplementation(
    async () => ({ project: provider, global: provider, projectSlug: 'test' }) as any,
  );
});

afterEach(async () => {
  const s = server;
  server = undefined;
  if (s) await new Promise<void>(resolve => { s.close(() => resolve()); s.closeAllConnections(); });
  provider?.close();
  provider = undefined;
  resetMemberBibleViews();
  resetKbProviders();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('a merged tombstone reaches a bible entry a fresh clone imported as linked or duplicate', () => {
  it('kb_import at the merged base ref: withdrawn tombstones answer withdrawn and lower both rows', async () => {
    const relatedId = await seedCloneAndImportXY();

    writeBible([], [
      { id: LINKED_ID, at: TOMBSTONE_AT, reason: 'withdrawn', note: NOTE, evidence_files: ['src/y.ts'] },
      { id: DEDUP_ID, at: TOMBSTONE_AT, reason: 'withdrawn', note: NOTE, evidence_files: ['src/y.ts'] },
    ]);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const report = await importAt('refs/remotes/origin/main');

    expect(report.withdrawals.not_found).toEqual([]);
    expect([...report.withdrawals.withdrawn].sort()).toEqual([LINKED_ID, DEDUP_ID].sort());
    // The linked entry lives under its bible id; the deduplicated one is the
    // local row that absorbed it.
    expect(rowOf(LINKED_ID)?.confidence).toBe('INFERRED');
    expect(rowOf(LINKED_ID)?.content).toContain('withdrawn in the project bible: ' + NOTE);
    expect(rowOf(LOCAL_DUP_ID)?.confidence).toBe('INFERRED');
    expect(rowOf(DEDUP_ID)).toBeUndefined();
    // The related entry X merely linked to is not touched by X's tombstone.
    expect(rowOf(relatedId)?.confidence).toBe('CONFIRMED');
  });

  it('kb_import: demoted tombstones for the linked and deduplicated bible ids lower both rows', async () => {
    await seedCloneAndImportXY();

    writeBible([], [
      { id: LINKED_ID, at: TOMBSTONE_AT, reason: 'demoted' },
      { id: DEDUP_ID, at: TOMBSTONE_AT, reason: 'demoted' },
    ]);
    const report = await importAt();

    expect(report.demoted).toBe(2);
    expect(rowOf(LINKED_ID)?.confidence).toBe('INFERRED');
    expect(rowOf(LOCAL_DUP_ID)?.confidence).toBe('INFERRED');
  });

  it('POST /api/kb/withdraw on the KB server: the same tombstones answer withdrawn and lower both rows', async () => {
    await seedCloneAndImportXY();
    provider!.close();
    provider = undefined;

    const tokenFile = path.join(root, 'token');
    fs.writeFileSync(tokenFile, TOKEN);
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      server = await startKbServer(0, false, dbPath, tokenFile);
    } finally {
      process.chdir(cwd);
    }
    const port = (server.address() as AddressInfo).port;

    const res = await call(port, 'POST', '/api/kb/withdraw', {
      withdrawals: [
        { id: LINKED_ID, at: TOMBSTONE_AT, reason: 'withdrawn', note: NOTE },
        { id: DEDUP_ID, at: TOMBSTONE_AT, reason: 'withdrawn', note: NOTE },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      results: [{ id: LINKED_ID, outcome: 'withdrawn' }, { id: DEDUP_ID, outcome: 'withdrawn' }],
    });

    const ids = encodeURIComponent(JSON.stringify([LINKED_ID, LOCAL_DUP_ID]));
    const q = await call(port, 'GET', '/api/kb/query?ids=' + ids + '&confidence=CONFIRMED,INFERRED,UNVERIFIED&include_stale=true');
    expect(q.status).toBe(200);
    const byId = new Map((q.body.results as Array<{ id: string; confidence: string }>).map(r => [r.id, r.confidence]));
    expect(byId.get(LINKED_ID)).toBe('INFERRED');
    expect(byId.get(LOCAL_DUP_ID)).toBe('INFERRED');
  });
});
