import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbExport } from '../../src/tools/kb-export.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import {
  qualifiesForProjectBible,
  filterProjectBibleCandidates,
  isRepoRelativePath,
} from '../../src/services/knowledge/bible-basis-filter.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// kb_export project-scope basis filter + additive merge. Fixture: a temp git
// repo with a committed bible holding a curated entry that is NOT in the KB,
// and a project KB seeded with cases a-f (see seedCases).
//
// GUARDING ASSERTIONS (these fail if kbExport reverts to the pre-change body
// that dumped every CONFIRMED entry and overwrote the bible):
//   - criterion 1: "exports exactly the curated entries plus qualifying entry
//     a" (b-f leak and the curated entry is dropped by an overwrite).
//   - criterion 3: "nothing qualifies -> bytes identical and no new commit"
//     (the old body rewrote the bible and committed it).
// The qualifiesForProjectBible describe block pins each of cases a-f directly.

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.local', ...args],
    { cwd: dir, encoding: 'utf-8' });
}

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'Default title',
    summary: 'Default summary',
    content: 'Default content body.',
    source_files: ['src/default.ts'],
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

const CURATED = {
  id: 'curated-entry-0001',
  type: 'knowledge',
  title: 'Curated entry',
  summary: 'A hand-curated bible entry that is not in the KB.',
  symbols: ['curatedSym'],
  source_files: ['docs/curated.md'],
  confidence: 'CONFIRMED',
  updated_at: '2026-01-01T00:00:00.000Z',
};

let tmpDir: string;
let provider: SqliteProvider;
let globalProvider: SqliteProvider;
const ids: Record<string, string> = {};
const REASON = 'confirmed for test: basis verified in fixture';

function writeSrc(rel: string, body = rel): void {
  fs.mkdirSync(path.dirname(path.join(tmpDir, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, rel), 'export const x = ' + JSON.stringify(body) + ';');
}

async function captureConfirmed(key: string, files: string[]): Promise<void> {
  const e = await provider.capture(makeInput({
    title: 'Case ' + key + ' knowledge entry', summary: 'Summary for case ' + key, source_files: files,
  }));
  await provider.promote(e.id, REASON);
  ids[key] = e.id;
}

function db(): any {
  return (provider as any).getDb();
}

function setBasis(id: string, basis: Record<string, string>): void {
  db().prepare('UPDATE entries SET source_file_hashes = ? WHERE id = ?').run(JSON.stringify(basis), id);
}

function getBasis(id: string): Record<string, string> {
  const row = db().prepare('SELECT source_file_hashes FROM entries WHERE id = ?').get(id) as { source_file_hashes: string };
  return JSON.parse(row.source_file_hashes);
}

/** Seed cases a-f. Only `a` (when included) should qualify afterwards. */
async function seedCases(opts: { includeA: boolean }): Promise<void> {
  for (const f of ['a', 'b', 'c', 'd', 'e', 'f1', 'f2', 'f2-second', 'f1-second']) writeSrc('src/' + f + '.ts');
  if (opts.includeA) await captureConfirmed('a', ['src/a.ts']);
  await captureConfirmed('b', ['src/b.ts']);
  await captureConfirmed('c', ['src/c.ts']);
  await captureConfirmed('d', ['src/d.ts']);
  await captureConfirmed('e', ['src/e.ts']);
  await captureConfirmed('f1', ['src/f1.ts', 'src/f1-second.ts']);
  await captureConfirmed('f2', ['src/f2.ts', 'src/f2-second.ts']);

  // b: file edited after capture -> basis hash differs.
  writeSrc('src/b.ts', 'edited after capture');
  // c: cited file absent from the tree.
  fs.rmSync(path.join(tmpDir, 'src/c.ts'));
  // d: INFERRED with a matching basis (promote() only mints CONFIRMED, so demote directly).
  db().prepare("UPDATE entries SET confidence = 'INFERRED' WHERE id = ?").run(ids.d);
  // e: CONFIRMED with an empty basis.
  setBasis(ids.e, {});
  // f1: cites two files, basis lacks a key for one of them.
  const b1 = getBasis(ids.f1);
  setBasis(ids.f1, { 'src/f1.ts': b1['src/f1.ts'] });
  // f2: cites two files, basis matches only one (second file edited).
  writeSrc('src/f2-second.ts', 'edited after capture');
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-export-basis-filter-'));
  git(tmpDir, ['init', '--quiet']);
  fs.mkdirSync(path.join(tmpDir, '.fleet'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'docs/curated.md'), 'curated');
  // Hand-written bible with an extra human-edited field that a re-shape would lose.
  const bible = { version: 2, provenance: { commit: null, branch: null, entry_count: 1 }, entries: [{ ...CURATED, note: 'human edit' }] };
  fs.writeFileSync(path.join(tmpDir, '.fleet/kb-canonical.json'), JSON.stringify(bible, null, 2) + '\n');
  git(tmpDir, ['add', '.fleet/kb-canonical.json']);
  git(tmpDir, ['commit', '-m', 'seed bible', '--quiet']);

  provider = new SqliteProvider(':memory:', tmpDir);
  await provider.init();
  globalProvider = new SqliteProvider(':memory:', tmpDir);
  await globalProvider.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: provider, global: globalProvider, projectSlug: 'test',
  } as any);
});

afterEach(() => {
  provider.close();
  globalProvider.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const biblePath = () => path.join(tmpDir, '.fleet/kb-canonical.json');
const readEntries = () => JSON.parse(fs.readFileSync(biblePath(), 'utf-8')).entries as Array<Record<string, any>>;
const commitCount = () => Number(git(tmpDir, ['rev-list', '--count', 'HEAD']).trim());

describe('kb_export project basis filter + additive merge', () => {
  it('exports exactly the curated entries plus qualifying entry a; b-f are absent', async () => {
    await seedCases({ includeA: true });
    await kbExport({ repo_path: tmpDir, scope: 'project' } as any);
    const entries = readEntries();
    const idsOut = entries.map(e => e.id).sort();
    expect(idsOut).toEqual([CURATED.id, ids.a].sort());
    // curated entry deep-equals its prior JSON (including the human-edited field)
    expect(entries.find(e => e.id === CURATED.id)).toEqual({ ...CURATED, note: 'human edit' });
    for (const k of ['b', 'c', 'd', 'e', 'f1', 'f2']) expect(idsOut).not.toContain(ids[k]);
  });

  it('a pre-existing bible entry with the id of a qualifying KB entry is left unchanged (existing wins)', async () => {
    await seedCases({ includeA: true });
    const existing = { ...CURATED, id: ids.a, title: 'Human-edited title for a' };
    fs.writeFileSync(biblePath(), JSON.stringify({ version: 2, provenance: { commit: null, branch: null, entry_count: 1 }, entries: [existing] }, null, 2) + '\n');
    await kbExport({ repo_path: tmpDir, scope: 'project' } as any);
    expect(readEntries()).toEqual([existing]);
  });

  it('nothing qualifies -> bible bytes identical and no new commit', async () => {
    await seedCases({ includeA: false });
    const before = fs.readFileSync(biblePath());
    const commitsBefore = commitCount();
    const res = JSON.parse(await kbExport({ repo_path: tmpDir, scope: 'project' } as any));
    expect(res.committed).toBe(false);
    expect(Buffer.compare(before, fs.readFileSync(biblePath()))).toBe(0);
    expect(commitCount()).toBe(commitsBefore);
    expect(git(tmpDir, ['log', '--format=%an']).includes('pm-kb')).toBe(false);
  });

  it('scope global is unaffected by the project basis filter', async () => {
    // CONFIRMED, cited file edited after capture: fails the project rule.
    writeSrc('src/g.ts');
    const e = await globalProvider.capture(makeInput({ title: 'Global entry knowledge', summary: 'Global summary', source_files: ['src/g.ts'] }));
    await globalProvider.promote(e.id, REASON);
    writeSrc('src/g.ts', 'edited after capture');
    await kbExport({ repo_path: tmpDir, scope: 'global' } as any);
    const out = JSON.parse(fs.readFileSync(path.join(tmpDir, '.fleet/kb-canonical-global.json'), 'utf-8'));
    expect(out.entries.map((x: any) => x.id)).toEqual([e.id]);
  });
});

describe('qualifiesForProjectBible (cases a-f)', () => {
  const H = (h: string) => ({ hash: h });
  const entry = (files: string[], confidence = 'CONFIRMED') => ({ id: 'x', confidence, source_files: files });

  it('a: CONFIRMED, file present, basis matches -> qualifies', () => {
    expect(qualifiesForProjectBible(entry(['a.ts']), { 'a.ts': 'h1' }, { 'a.ts': H('h1') })).toBe(true);
  });
  it('b: basis hash differs from current file -> excluded', () => {
    expect(qualifiesForProjectBible(entry(['a.ts']), { 'a.ts': 'h1' }, { 'a.ts': H('h2') })).toBe(false);
  });
  it('c: cited file absent -> excluded', () => {
    expect(qualifiesForProjectBible(entry(['a.ts']), { 'a.ts': 'h1' }, { 'a.ts': null })).toBe(false);
    expect(qualifiesForProjectBible(entry(['a.ts']), { 'a.ts': 'h1' }, {})).toBe(false);
  });
  it('d: INFERRED with matching basis -> excluded', () => {
    expect(qualifiesForProjectBible(entry(['a.ts'], 'INFERRED'), { 'a.ts': 'h1' }, { 'a.ts': H('h1') })).toBe(false);
  });
  it('e: CONFIRMED with empty/null basis -> excluded', () => {
    expect(qualifiesForProjectBible(entry(['a.ts']), {}, { 'a.ts': H('h1') })).toBe(false);
    expect(qualifiesForProjectBible(entry(['a.ts']), null, { 'a.ts': H('h1') })).toBe(false);
  });
  it('f: two cited files, basis matches only one or lacks a key -> excluded', () => {
    const cur = { 'a.ts': H('h1'), 'b.ts': H('h2') };
    expect(qualifiesForProjectBible(entry(['a.ts', 'b.ts']), { 'a.ts': 'h1', 'b.ts': 'other' }, cur)).toBe(false);
    expect(qualifiesForProjectBible(entry(['a.ts', 'b.ts']), { 'a.ts': 'h1' }, cur)).toBe(false);
    expect(qualifiesForProjectBible(entry(['a.ts', 'b.ts']), { 'a.ts': 'h1', 'b.ts': 'h2' }, cur)).toBe(true);
  });
  it('g: a cited or basis path outside the repo (absolute, drive, UNC, ..) never qualifies, even with a matching hash', () => {
    for (const p of ['../outside.ts', 'src/../../x.ts', '/etc/passwd', 'C:\\x.ts', 'C:x.ts', '\\\\host\\share\\x.ts']) {
      expect(isRepoRelativePath(p)).toBe(false);
      expect(qualifiesForProjectBible(entry([p]), { [p]: 'h1' }, { [p]: H('h1') })).toBe(false);
      expect(qualifiesForProjectBible(entry(['a.ts']), { 'a.ts': 'h1', [p]: 'h1' }, { 'a.ts': H('h1'), [p]: H('h1') })).toBe(false);
    }
    expect(isRepoRelativePath('src/a.ts')).toBe(true);
    expect(isRepoRelativePath('src\\a.ts')).toBe(true);
    expect(isRepoRelativePath('a..b.ts')).toBe(true);
  });

  it('filterProjectBibleCandidates hashes the repo files and preserves order', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-basis-unit-'));
    try {
      fs.writeFileSync(path.join(dir, 'f.ts'), 'one');
      const p = new SqliteProvider(':memory:', dir);
      await p.init();
      const e = await p.capture(makeInput({ source_files: ['f.ts'] }));
      await p.promote(e.id, REASON);
      const confirmed = await p.list({ confidence: 'CONFIRMED' });
      const bases = p.getSourceFileBases(confirmed.map(c => c.id));
      expect((await filterProjectBibleCandidates(confirmed, bases, dir)).map(c => c.id)).toEqual([e.id]);
      fs.writeFileSync(path.join(dir, 'f.ts'), 'two');
      expect(await filterProjectBibleCandidates(confirmed, bases, dir)).toEqual([]);
      p.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
