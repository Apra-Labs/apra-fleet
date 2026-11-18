import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { kbBibleCommit, KB_BIBLE_COMMIT_HTTP_SKIP_REASON } from '../../src/tools/kb-bible-commit.js';
import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { FLEET_DIR } from '../../src/paths.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// kb_bible_commit under the http KB provider is a structured skip, not an
// error. Real kb_setup, real HttpKbProvider / SqliteProvider selected through
// getKbProviders, a real local node http server standing in for the KB
// endpoint, and a real temp git repo with an origin remote. No mocks.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIBLE_REL = '.fleet/kb-canonical.json';

// Same token source as kb-http-provider-e2e.test.ts: env var, else a committed
// deliberately-fake fixture file; fail fast naming the key otherwise.
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

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function entryInput(title: string): KBEntryInput {
  return {
    type: 'knowledge',
    title,
    summary: `Summary of ${title}`,
    content: `Content body of ${title}.`,
    source_files: ['src/a.ts'],
    symbols: [`sym${title}`],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'test-agent',
    source: 'doer',
    confidence: 'INFERRED',
  };
}

let server: http.Server;
let port: number;
let requestCount = 0;
let token: string;
let root: string;
let clone: string;
let remoteUrl: string;

beforeAll(async () => {
  token = loadTestToken();
  server = http.createServer((req, res) => {
    requestCount += 1;
    req.resume();
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('kb-bible-commit-http-skip: server did not bind a TCP port');
  port = address.port;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
  requestCount = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-http-skip-'));
  const origin = path.join(root, 'origin.git');
  clone = path.join(root, 'clone');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '--quiet', origin, clone], { stdio: ['ignore', 'pipe', 'pipe'] });
  git(clone, ['config', 'user.name', 'test']);
  git(clone, ['config', 'user.email', 'test@example.invalid']);
  git(clone, ['config', 'commit.gpgsign', 'false']);
  git(clone, ['checkout', '--quiet', '-B', 'main']);
  fs.mkdirSync(path.join(clone, 'src'), { recursive: true });
  fs.writeFileSync(path.join(clone, 'src', 'a.ts'), 'export const a = 1;\n');
  git(clone, ['add', '-A']);
  git(clone, ['commit', '--quiet', '-m', 'seed']);
  git(clone, ['push', '--quiet', 'origin', 'main']);
  remoteUrl = `https://example.invalid/kb-bible-http-skip-${crypto.randomUUID()}.git`;
});

afterEach(() => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('kb_bible_commit under the http KB provider', () => {
  it('resolves with bible_skipped, touches no file or commit, and makes no request', async () => {
    await kbSetup({ provider: 'http', remote: `http://127.0.0.1:${port}`, token }, { folder: clone });
    const providers = await getKbProviders(clone, remoteUrl);
    expect(providers.project).toBeInstanceOf(HttpKbProvider);

    const headBefore = git(clone, ['rev-parse', 'HEAD']).trim();
    const requestsBefore = requestCount;

    const raw = await kbBibleCommit(
      { ids: ['kb-some-id', 'kb-other-id'], baseBranch: 'main', baseCommit: headBefore },
      { folder: clone, remoteUrl },
    );
    const result = JSON.parse(raw);

    expect(result.bible_skipped).toBe(true);
    expect(result.committed).toBe(false);
    expect(result.reason).toBe(KB_BIBLE_COMMIT_HTTP_SKIP_REASON);
    expect(result.merged).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(fs.existsSync(path.join(clone, BIBLE_REL))).toBe(false);
    expect(git(clone, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(requestCount).toBe(requestsBefore);
  });
});

describe('kb_bible_commit under the sqlite KB provider is unchanged', () => {
  it('still merges and commits a CONFIRMED basis-qualifying entry, with no bible_skipped key', async () => {
    await kbSetup({ provider: 'sqlite' }, { folder: clone });
    const providers = await getKbProviders(clone, remoteUrl);
    expect(providers.project).toBeInstanceOf(SqliteProvider);
    const sqlite = providers.project as SqliteProvider;
    const { id } = await sqlite.capture(entryInput('SqliteStillMerges'));
    await sqlite.promote(id, 'test fixture: verified');
    await sqlite.promote(id, 'test fixture: verified');
    const head = git(clone, ['rev-parse', 'HEAD']).trim();

    const result = JSON.parse(await kbBibleCommit(
      { ids: [id], baseBranch: 'main', baseCommit: head },
      { folder: clone, remoteUrl },
    ));

    expect(result.merged).toEqual([id]);
    expect(result.committed).toBe(true);
    expect('bible_skipped' in result).toBe(false);
    expect('reason' in result).toBe(false);
    const bible = JSON.parse(fs.readFileSync(path.join(clone, BIBLE_REL), 'utf-8'));
    expect(bible.entries.map((e: { id: string }) => e.id)).toEqual([id]);
    expect(git(clone, ['rev-parse', 'HEAD']).trim()).not.toBe(head);
  });
});

describe('kb_bible_commit http skip and the existing bible file', () => {
  function writeBible(content: string): void {
    fs.mkdirSync(path.join(clone, '.fleet'), { recursive: true });
    fs.writeFileSync(path.join(clone, BIBLE_REL), content, 'utf-8');
  }

  it('reports entry_count as the size of the existing parseable bible', async () => {
    await kbSetup({ provider: 'http', remote: `http://127.0.0.1:${port}`, token }, { folder: clone });
    const entries = ['kb-one', 'kb-two', 'kb-three'].map(id => ({ id, title: id }));
    writeBible(JSON.stringify({ version: 3, provenance: {}, entries }));
    const head = git(clone, ['rev-parse', 'HEAD']).trim();

    const result = JSON.parse(await kbBibleCommit(
      { ids: ['kb-some-id'], baseBranch: 'main', baseCommit: head },
      { folder: clone, remoteUrl },
    ));

    expect(result.bible_skipped).toBe(true);
    expect(result.entry_count).toBe(3);
    expect(result.committed).toBe(false);
    expect(git(clone, ['rev-parse', 'HEAD']).trim()).toBe(head);
  });

  it('returns the structured skip, never throws, for a malformed bible over http', async () => {
    await kbSetup({ provider: 'http', remote: `http://127.0.0.1:${port}`, token }, { folder: clone });
    const malformed = '{ this is not json';
    writeBible(malformed);
    const head = git(clone, ['rev-parse', 'HEAD']).trim();

    const result = JSON.parse(await kbBibleCommit(
      { ids: ['kb-some-id'], baseBranch: 'main', baseCommit: head },
      { folder: clone, remoteUrl },
    ));

    expect(result.bible_skipped).toBe(true);
    expect(result.reason).toBe(KB_BIBLE_COMMIT_HTTP_SKIP_REASON);
    expect(result.entry_count).toBe(0);
    expect(fs.readFileSync(path.join(clone, BIBLE_REL), 'utf-8')).toBe(malformed);
  });

  it('still refuses a malformed bible under sqlite, leaving the file untouched', async () => {
    await kbSetup({ provider: 'sqlite' }, { folder: clone });
    const malformed = '{ this is not json';
    writeBible(malformed);
    const head = git(clone, ['rev-parse', 'HEAD']).trim();

    await expect(kbBibleCommit(
      { ids: ['kb-some-id'], baseBranch: 'main', baseCommit: head },
      { folder: clone, remoteUrl },
    )).rejects.toThrow(/refusing to overwrite it/);
    expect(fs.readFileSync(path.join(clone, BIBLE_REL), 'utf-8')).toBe(malformed);
  });
});

describe('kb_bible_commit withdrawals and restores under the http KB provider', () => {
  const NOTE = 'the cited guard was removed when the reader was rewritten';
  const readBible = () => JSON.parse(fs.readFileSync(path.join(clone, BIBLE_REL), 'utf-8'));

  it('writes a tombstone-only bible when none exists, commits it, and makes no KB request', async () => {
    await kbSetup({ provider: 'http', remote: `http://127.0.0.1:${port}`, token }, { folder: clone });
    const head = git(clone, ['rev-parse', 'HEAD']).trim();
    const requestsBefore = requestCount;

    const result = JSON.parse(await kbBibleCommit({
      ids: ['kb-some-id'], baseBranch: 'main', baseCommit: head,
      withdrawals: [{ id: 'kb-withdrawn', note: NOTE, evidence_files: ['src/a.ts'] }],
    }, { folder: clone, remoteUrl }));

    expect(result.bible_skipped).toBe(true);
    expect(result.reason).toBe(KB_BIBLE_COMMIT_HTTP_SKIP_REASON);
    expect(result.merged).toEqual([]);
    expect(result.withdrawn).toEqual(['kb-withdrawn']);
    expect(result.restored).toEqual([]);
    expect(result.committed).toBe(true);
    const bible = readBible();
    expect(bible.version).toBe(3);
    expect(bible.provenance).toEqual({ commit: head, branch: 'main', entry_count: 0 });
    expect(bible.entries).toEqual([]);
    expect(bible.demotions).toEqual([{
      id: 'kb-withdrawn', at: bible.demotions[0].at, reason: 'withdrawn', note: NOTE, evidence_files: ['src/a.ts'],
    }]);
    expect(git(clone, ['rev-parse', 'HEAD']).trim()).not.toBe(head);
    expect(git(clone, ['status', '--porcelain', '--', BIBLE_REL]).trim()).toBe('');
    expect(requestCount).toBe(requestsBefore);

    // A restore of that branch-added tombstone against the base removes it again.
    const restored = JSON.parse(await kbBibleCommit({
      ids: [], baseBranch: 'main', baseCommit: head, restore_ids: ['kb-withdrawn'],
    }, { folder: clone, remoteUrl }));
    expect(restored.restored).toEqual(['kb-withdrawn']);
    expect(restored.committed).toBe(true);
    expect(readBible().demotions).toBeUndefined();
    expect(readBible().entries).toEqual([]);
  });

  it('keeps existing entries byte-identical when adding a tombstone', async () => {
    await kbSetup({ provider: 'http', remote: `http://127.0.0.1:${port}`, token }, { folder: clone });
    const entries = [{ id: 'kb-one', title: 'one', extra: { z: 1, a: 2 } }, { id: 'kb-two', title: 'two' }];
    fs.mkdirSync(path.join(clone, '.fleet'), { recursive: true });
    fs.writeFileSync(path.join(clone, BIBLE_REL), JSON.stringify({
      version: 3, provenance: { commit: null, branch: null, entry_count: 2 }, entries,
    }, null, 2) + '\n');
    git(clone, ['add', '-A']);
    git(clone, ['commit', '--quiet', '-m', 'seed bible']);
    const head = git(clone, ['rev-parse', 'HEAD']).trim();

    const result = JSON.parse(await kbBibleCommit({
      ids: [], baseBranch: 'main', baseCommit: head,
      withdrawals: [{ id: 'kb-elsewhere', note: NOTE, evidence_files: ['src/a.ts'] }],
    }, { folder: clone, remoteUrl }));

    expect(result.withdrawn).toEqual(['kb-elsewhere']);
    expect(result.entry_count).toBe(2);
    expect(result.committed).toBe(true);
    const bible = readBible();
    expect(JSON.stringify(bible.entries)).toBe(JSON.stringify(entries));
    expect(bible.demotions.map((d: { id: string }) => d.id)).toEqual(['kb-elsewhere']);
  });

  it('never writes an id as both an entry and a tombstone', async () => {
    await kbSetup({ provider: 'http', remote: `http://127.0.0.1:${port}`, token }, { folder: clone });
    // kb-two already sits in both lists (merged history); kb-one is withdrawn now.
    const entries = [{ id: 'kb-one', title: 'one' }, { id: 'kb-three', title: 'three' }, { id: 'kb-two', title: 'two' }];
    const oldTombstone = { id: 'kb-two', at: '2026-01-01T00:00:00.000Z', reason: 'demoted' };
    fs.mkdirSync(path.join(clone, '.fleet'), { recursive: true });
    fs.writeFileSync(path.join(clone, BIBLE_REL), JSON.stringify({
      version: 3, provenance: { commit: null, branch: null, entry_count: 3 }, entries, demotions: [oldTombstone],
    }, null, 2) + '\n');
    git(clone, ['add', '-A']);
    git(clone, ['commit', '--quiet', '-m', 'seed bible']);
    const head = git(clone, ['rev-parse', 'HEAD']).trim();

    const result = JSON.parse(await kbBibleCommit({
      ids: [], baseBranch: 'main', baseCommit: head,
      withdrawals: [{ id: 'kb-one', note: NOTE, evidence_files: ['src/a.ts'] }],
    }, { folder: clone, remoteUrl }));

    const bible = readBible();
    expect(bible.entries.map((e: { id: string }) => e.id)).toEqual(['kb-three']);
    expect(result.committed).toBe(true);
    expect(result.withdrawn).toEqual(['kb-one']);
    expect(result.removed).toEqual([{ id: 'kb-two', reason: 'tombstoned' }]);
    expect(result.entry_count).toBe(1);
    expect(bible.provenance.entry_count).toBe(1);
    expect(bible.demotions.map((d: { id: string }) => d.id)).toEqual(['kb-one', 'kb-two']);
    expect(bible.demotions[1]).toEqual(oldTombstone);
    expect(git(clone, ['log', '-1', '--format=%B']).trim()).toContain('- kb-two (tombstoned)');
  });
});
