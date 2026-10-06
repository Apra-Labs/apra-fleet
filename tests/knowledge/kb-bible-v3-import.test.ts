import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbImport } from '../../src/tools/kb-import.js';
import { carriedBasisOf, parseBibleText } from '../../src/services/knowledge/bible-import.js';
import { filterProjectBibleCandidates } from '../../src/services/knowledge/bible-basis-filter.js';
import { computeFileHashBatch } from '../../src/services/knowledge/file-hash.js';
import { getMemberBibleView, resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// Bible format v3 READERS: kb_import (and the member bible view, which shares
// the loader) store the basis a v3 entry CARRIES -- never a re-hash of this
// clone's files -- and a v1/v2 entry (or an invalid carried map) imports
// basis-less, so the shared bible predicate excludes it from re-export.

const BIBLE_REL = '.fleet/kb-canonical.json';
// A hash no local file has: the basis branch A verified against.
const FOREIGN_HASH = 'f'.repeat(64);

let root: string;
let repo: string;
let provider: SqliteProvider;

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.local', ...args],
    { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function entry(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, type: 'knowledge', title: 'Title of ' + id, summary: 'Summary of ' + id,
    symbols: ['sym_' + id.replace(/-/g, '_')], source_files: ['src/a.ts'], confidence: 'CONFIRMED',
    updated_at: '2026-01-01T00:00:00.000Z', ...over,
  };
}

function writeBible(version: 2 | 3, entries: unknown[]): string {
  const p = path.join(repo, BIBLE_REL);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({
    version, provenance: { commit: null, branch: 'main', entry_count: entries.length }, entries,
  }, null, 2) + '\n');
  return p;
}

async function localHash(rel: string): Promise<string> {
  const r = await computeFileHashBatch([rel], { cwd: repo });
  return r[rel]!.hash;
}

async function admitted(id: string): Promise<boolean> {
  const e = (await provider.list({ confidence: ['CONFIRMED'] })).filter(x => x.id === id);
  const out = await filterProjectBibleCandidates(e, provider.getSourceFileBases([id]), repo);
  return out.some(x => x.id === id);
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-v3-import-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  git(root, ['init', '--quiet', repo]);
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  // Committed: bible admission reads cited files at HEAD.
  git(repo, ['add', 'src/a.ts']);
  git(repo, ['commit', '--quiet', '--no-verify', '-m', 'seed']);
  provider = new SqliteProvider(path.join(root, 'kb.sqlite'), repo);
  await provider.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: provider, global: provider, projectSlug: 'test',
  } as any);
});

afterEach(() => {
  provider.close();
  vi.restoreAllMocks();
  resetMemberBibleViews();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('kb_import of a v3 bible keeps the carried basis', () => {
  it('cited file differs locally: stores the CARRIED hash, not the local one, and the predicate does not admit it', async () => {
    writeBible(3, [entry('kb-v3-differs', { source_file_hashes: { 'src/a.ts': FOREIGN_HASH } })]);
    const report = JSON.parse(await kbImport({ skip_sweep: true }, { folder: repo }));
    expect(report.imported).toBe(1);

    const stored = provider.getSourceFileBases(['kb-v3-differs']).get('kb-v3-differs');
    expect(stored).toEqual({ 'src/a.ts': FOREIGN_HASH });
    expect(stored!['src/a.ts']).not.toBe(await localHash('src/a.ts'));
    expect(await admitted('kb-v3-differs')).toBe(false);
  });

  it('the post-import sweep stales an entry whose carried basis does not match this worktree', async () => {
    writeBible(3, [entry('kb-v3-swept', { source_file_hashes: { 'src/a.ts': FOREIGN_HASH } })]);
    const report = JSON.parse(await kbImport({}, { folder: repo }));
    expect(report.imported).toBe(1);
    expect(report.sweep.staled).toBe(1);
  });

  it('cited files match: stores the carried hashes and the entry is admitted', async () => {
    const hash = await localHash('src/a.ts');
    writeBible(3, [entry('kb-v3-matches', { source_file_hashes: { 'src/a.ts': hash } })]);
    const report = JSON.parse(await kbImport({}, { folder: repo }));
    expect(report.imported).toBe(1);
    expect(report.sweep.staled).toBe(0);
    expect(provider.getSourceFileBases(['kb-v3-matches']).get('kb-v3-matches')).toEqual({ 'src/a.ts': hash });
    expect(await admitted('kb-v3-matches')).toBe(true);
  });

  it('a v2 bible imports; its entries are stored with no basis and excluded by the predicate', async () => {
    writeBible(2, [entry('kb-v2-entry')]);
    const report = JSON.parse(await kbImport({}, { folder: repo }));
    expect(report.imported).toBe(1);
    expect(provider.getSourceFileBases(['kb-v2-entry']).get('kb-v2-entry')).toBeNull();
    expect(await admitted('kb-v2-entry')).toBe(false);
  });

  it('an invalid carried map (absolute key, or a cited file missing) imports basis-less', async () => {
    writeBible(3, [
      entry('kb-v3-abs', { source_file_hashes: { '/etc/passwd': FOREIGN_HASH, 'src/a.ts': FOREIGN_HASH } }),
      entry('kb-v3-partial', { source_files: ['src/a.ts', 'src/b.ts'], source_file_hashes: { 'src/a.ts': FOREIGN_HASH } }),
    ]);
    fs.writeFileSync(path.join(repo, 'src', 'b.ts'), 'export const b = 1;\n');
    const report = JSON.parse(await kbImport({ skip_sweep: true }, { folder: repo }));
    expect(report.imported).toBe(2);
    const bases = provider.getSourceFileBases(['kb-v3-abs', 'kb-v3-partial']);
    expect(bases.get('kb-v3-abs')).toBeNull();
    expect(bases.get('kb-v3-partial')).toBeNull();
  });
});

describe('normal (non-import) capture still hashes local files', () => {
  it('a kb_capture-style capture computes its basis from the local file', async () => {
    const input: KBEntryInput = {
      type: 'knowledge', title: 'Local capture claim', summary: 'Local summary', content: 'Local content.',
      source_files: ['src/a.ts'], symbols: ['localSym'], tags: [], content_hash: '', content_hash_type: 'sha256',
      flagged_for_review: false, author: 'test', source: 'doer', confidence: 'INFERRED',
    };
    const { id } = await provider.capture(input);
    expect(provider.getSourceFileBases([id]).get(id)).toEqual({ 'src/a.ts': await localHash('src/a.ts') });
  });

  it('carriedBasis is ignored without importMode', async () => {
    const input: KBEntryInput = {
      type: 'knowledge', title: 'Not an import claim', summary: 'Not import summary', content: 'Not import.',
      source_files: ['src/a.ts'], symbols: ['notImportSym'], tags: [], content_hash: '', content_hash_type: 'sha256',
      flagged_for_review: false, author: 'test', source: 'doer', confidence: 'INFERRED',
    };
    const { id } = await provider.capture(input, { carriedBasis: { 'src/a.ts': FOREIGN_HASH } });
    expect(provider.getSourceFileBases([id]).get(id)).toEqual({ 'src/a.ts': await localHash('src/a.ts') });
  });
});

describe('bible v3 parsing and the member bible view', () => {
  it('parseBibleText accepts v1, v2 and v3 shapes', () => {
    const e = entry('kb-parse');
    expect(parseBibleText(JSON.stringify([e]), 'x', 't')).toHaveLength(1);
    expect(parseBibleText(JSON.stringify({ version: 2, provenance: {}, entries: [e] }), 'x', 't')).toHaveLength(1);
    expect(parseBibleText(JSON.stringify({ version: 3, provenance: {}, entries: [e] }), 'x', 't')).toHaveLength(1);
  });

  it('carriedBasisOf returns a key-sorted copy of a valid map and null otherwise', () => {
    expect(carriedBasisOf({ source_files: ['b', 'a'], source_file_hashes: { b: 'h2', a: 'h1' } })).toEqual({ a: 'h1', b: 'h2' });
    expect(Object.keys(carriedBasisOf({ source_files: ['b', 'a'], source_file_hashes: { b: 'h2', a: 'h1' } })!)).toEqual(['a', 'b']);
    expect(carriedBasisOf({ source_files: ['a'] })).toBeNull();
    expect(carriedBasisOf({ source_files: ['a'], source_file_hashes: {} })).toBeNull();
    expect(carriedBasisOf({ source_files: ['a'], source_file_hashes: { a: '' } })).toBeNull();
    expect(carriedBasisOf({ source_files: ['a'], source_file_hashes: ['a'] })).toBeNull();
    expect(carriedBasisOf({ source_files: ['../a'], source_file_hashes: { '../a': 'h' } })).toBeNull();
  });

  it('member bible view loads a v3 file and keeps the carried basis', async () => {
    writeBible(3, [entry('kb-view-v3', { source_file_hashes: { 'src/a.ts': FOREIGN_HASH } })]);
    const view = await getMemberBibleView({ folder: repo });
    const listed = await view.list({ confidence: ['CONFIRMED'] });
    expect(listed.map(e => e.id)).toEqual(['kb-view-v3']);
    expect(view.getSourceFileBases(['kb-view-v3']).get('kb-view-v3')).toEqual({ 'src/a.ts': FOREIGN_HASH });
  });
});
