import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbExport } from '../../src/tools/kb-export.js';
import { kbBibleCommit } from '../../src/tools/kb-bible-commit.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// Bible format v3 WRITERS: kb_export (scope=project) and kb_bible_commit write
// version 3, each newly written entry carries source_file_hashes equal to the
// provider's STORED basis (getSourceFileBases), and both refuse to write a
// bible holding a duplicate id (file left untouched).

const BIBLE_REL = '.fleet/kb-canonical.json';
const REASON = 'confirmed for test: basis verified in fixture';

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.local', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'Default title',
    summary: 'Default summary',
    content: 'Default content body.',
    source_files: ['src/a.ts'],
    symbols: [],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'test-agent',
    source: 'doer',
    confidence: 'INFERRED',
    ...overrides,
  };
}

// A pre-existing v2 entry with no hashes and an extra human-edited field.
const OTHER = {
  id: '00-other-entry',
  type: 'knowledge',
  title: 'Other entry',
  summary: 'An entry already in the v2 bible.',
  symbols: [],
  source_files: ['src/a.ts'],
  confidence: 'CONFIRMED',
  updated_at: '2026-01-01T00:00:00.000Z',
  note: 'human edit',
};

let tmpDir: string;
let provider: SqliteProvider;

const biblePath = () => path.join(tmpDir, BIBLE_REL);
const readBible = () => JSON.parse(fs.readFileSync(biblePath(), 'utf-8'));
const commitCount = () => Number(git(tmpDir, ['rev-list', '--count', 'HEAD']).trim());

function writeSrc(rel: string, body = rel): void {
  fs.mkdirSync(path.dirname(path.join(tmpDir, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, rel), 'export const x = ' + JSON.stringify(body) + ';\n');
}

function writeV2Bible(entries: Array<Record<string, unknown>>): void {
  fs.writeFileSync(biblePath(), JSON.stringify({
    version: 2, provenance: { commit: null, branch: null, entry_count: entries.length }, entries,
  }, null, 2) + '\n');
}

async function confirmed(title: string, files: string[]): Promise<string> {
  const { id } = await provider.capture(makeInput({ title, summary: 'Summary of ' + title, source_files: files }));
  await provider.promote(id, REASON);
  return id;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-v3-writers-'));
  git(tmpDir, ['init', '--quiet']);
  fs.mkdirSync(path.join(tmpDir, '.fleet'), { recursive: true });
  // Two cited files; 'src/z.ts' sorts after 'src/b.ts' and is cited first so
  // the key-sorting of source_file_hashes is observable.
  writeSrc('src/a.ts');
  writeSrc('src/b.ts');
  writeSrc('src/z.ts');
  writeV2Bible([OTHER]);
  git(tmpDir, ['add', '-A']);
  git(tmpDir, ['commit', '-m', 'seed', '--quiet']);

  provider = new SqliteProvider(':memory:', tmpDir);
  await provider.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: provider, global: provider, projectSlug: 'test',
  } as any);
});

afterEach(() => {
  provider.close();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('kb_export (scope=project) writes bible v3', () => {
  it('writes version 3 and every exported entry carries the provider stored basis', async () => {
    const one = await confirmed('First knowledge claim', ['src/z.ts', 'src/b.ts']);
    const two = await confirmed('Second knowledge claim', ['src/a.ts']);

    await kbExport({ scope: 'project' }, { folder: tmpDir });

    const bible = readBible();
    expect(bible.version).toBe(3);
    const bases = provider.getSourceFileBases([one, two]);
    for (const id of [one, two]) {
      const written = bible.entries.find((e: { id: string }) => e.id === id);
      expect(written.source_file_hashes).toEqual(bases.get(id));
    }
    // Keys sorted for byte-stability.
    const firstWritten = bible.entries.find((e: { id: string }) => e.id === one);
    expect(Object.keys(firstWritten.source_file_hashes)).toEqual(['src/b.ts', 'src/z.ts']);
    // The pre-existing v2 entry is kept exactly as it was (no invented basis).
    expect(bible.entries.find((e: { id: string }) => e.id === OTHER.id)).toEqual(OTHER);
  });

  it('copies the STORED basis, never a re-hash at write time', async () => {
    const id = await confirmed('Stored basis claim', ['src/a.ts']);
    const stored = provider.getSourceFileBases([id]).get(id)!;
    await kbExport({ scope: 'project' }, { folder: tmpDir });
    const written = readBible().entries.find((e: { id: string }) => e.id === id);
    expect(written.source_file_hashes).toEqual(stored);
    expect(written.source_file_hashes['src/a.ts']).toMatch(/\S/);
  });

  it('a second export with unchanged inputs makes no new commit and leaves bytes identical', async () => {
    await confirmed('Stable claim', ['src/a.ts']);
    await kbExport({ scope: 'project' }, { folder: tmpDir });
    const bytes = fs.readFileSync(biblePath());
    const commits = commitCount();
    const res = JSON.parse(await kbExport({ scope: 'project' }, { folder: tmpDir }));
    expect(res.committed).toBe(false);
    expect(commitCount()).toBe(commits);
    expect(Buffer.compare(bytes, fs.readFileSync(biblePath()))).toBe(0);
  });

  it('refuses to write a bible holding a duplicate id and leaves the file untouched', async () => {
    writeV2Bible([OTHER, { ...OTHER, title: 'Same id, other title' }]);
    await confirmed('New claim to add', ['src/a.ts']);
    const before = fs.readFileSync(biblePath());
    await expect(kbExport({ scope: 'project' }, { folder: tmpDir }))
      .rejects.toThrow(/duplicate entry id "00-other-entry"/);
    expect(Buffer.compare(before, fs.readFileSync(biblePath()))).toBe(0);
  });
});

describe('kb_bible_commit writes bible v3', () => {
  it('writes version 3 with per-entry hashes for merged ids; a pre-existing v2 entry is preserved byte-for-byte', async () => {
    const id = await confirmed('Committed claim', ['src/z.ts', 'src/a.ts']);
    const head = git(tmpDir, ['rev-parse', 'HEAD']).trim();
    const otherBytesBefore = JSON.stringify(OTHER, null, 2);

    const res = JSON.parse(await kbBibleCommit({ ids: [id], baseBranch: 'main', baseCommit: head }, { folder: tmpDir }));
    expect(res.merged).toEqual([id]);
    expect(res.committed).toBe(true);

    const bible = readBible();
    expect(bible.version).toBe(3);
    const written = bible.entries.find((e: { id: string }) => e.id === id);
    expect(written.source_file_hashes).toEqual(provider.getSourceFileBases([id]).get(id));
    expect(Object.keys(written.source_file_hashes)).toEqual(['src/a.ts', 'src/z.ts']);
    const other = bible.entries.find((e: { id: string }) => e.id === OTHER.id);
    expect(other).toEqual(OTHER);
    expect(other.source_file_hashes).toBeUndefined();
    // Serialized form of the kept entry is unchanged (re-indented within the envelope).
    expect(JSON.stringify(other, null, 2)).toBe(otherBytesBefore);
  });

  it('re-running with unchanged inputs makes no new commit', async () => {
    const id = await confirmed('Idempotent claim', ['src/a.ts']);
    const head = git(tmpDir, ['rev-parse', 'HEAD']).trim();
    await kbBibleCommit({ ids: [id], baseBranch: 'main', baseCommit: head }, { folder: tmpDir });
    const commits = commitCount();
    const bytes = fs.readFileSync(biblePath());
    const res = JSON.parse(await kbBibleCommit({ ids: [id], baseBranch: 'main', baseCommit: head }, { folder: tmpDir }));
    expect(res.committed).toBe(false);
    expect(commitCount()).toBe(commits);
    expect(Buffer.compare(bytes, fs.readFileSync(biblePath()))).toBe(0);
  });

  it('refuses to write a bible holding a duplicate id and leaves the file untouched', async () => {
    writeV2Bible([OTHER, { ...OTHER, title: 'Same id, other title' }]);
    const id = await confirmed('Claim beside a corrupt bible', ['src/a.ts']);
    const before = fs.readFileSync(biblePath());
    const commits = commitCount();
    await expect(kbBibleCommit({ ids: [id], baseBranch: 'main', baseCommit: 'abc' }, { folder: tmpDir }))
      .rejects.toThrow(/duplicate entry id "00-other-entry"/);
    expect(Buffer.compare(before, fs.readFileSync(biblePath()))).toBe(0);
    expect(commitCount()).toBe(commits);
  });
});
