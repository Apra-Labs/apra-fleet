import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  checkBibleFile, exporterSerialization, formatProblems, validateBibleText, DEFAULT_BIBLE,
} from '../scripts/check-kb-canonical.mjs';

// The CI check that rejects a malformed knowledge bible. Each malformed case
// must fail with a message naming the problem (and the id where there is one);
// the bible committed in this repository must pass.

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'check-kb-canonical.mjs');
const AT = '2026-01-01T00:00:00.000Z';

function entry(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, type: 'knowledge', title: 'Title ' + id, summary: 'Summary ' + id, symbols: [],
    source_files: ['src/a.ts'], confidence: 'CONFIRMED', updated_at: AT, ...extra,
  };
}

function valid(): Record<string, any> {
  return {
    version: 3,
    provenance: { branch: 'main' },
    entries: [entry('a-1'), entry('b-2'), entry('c-3')],
    demotions: [
      { id: 'd-4', at: AT, reason: 'demoted' },
      { id: 'e-5', at: AT, reason: 'withdrawn', note: 'the cited guard no longer exists', evidence_files: ['src/a.ts'] },
    ],
  };
}

function problemsOf(doc: unknown): { code: string; message: string; id?: string }[] {
  return validateBibleText(exporterSerialization(doc));
}

function expectProblem(doc: unknown, code: string, pattern: RegExp, id?: string): void {
  const problems = problemsOf(doc);
  const hit = problems.find(p => p.code === code && pattern.test(p.message));
  expect(hit, 'expected a ' + code + ' problem matching ' + pattern + ', got ' + JSON.stringify(problems)).toBeDefined();
  if (id !== undefined) {
    expect(hit!.id).toBe(id);
    expect(hit!.message).toContain(JSON.stringify(id));
  }
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('check-kb-canonical: valid bibles', () => {
  it('the bible committed in this repository passes', () => {
    const { exists, problems } = checkBibleFile(DEFAULT_BIBLE);
    expect(exists).toBe(true);
    expect(problems, formatProblems(DEFAULT_BIBLE, problems)).toEqual([]);
  });

  it('a well-formed bible passes, with or without tombstones', () => {
    expect(problemsOf(valid())).toEqual([]);
    const noTombstones = valid();
    delete noTombstones.demotions;
    expect(problemsOf(noTombstones)).toEqual([]);
  });

  it('accepts the legacy provenance keys without validating their values', () => {
    const doc = valid();
    doc.provenance = { commit: 'f'.repeat(40), branch: 'main', entry_count: 3 };
    expect(problemsOf(doc)).toEqual([]);
    doc.provenance = { commit: 'not-a-sha', branch: 'main', entry_count: 7 };
    expect(problemsOf(doc)).toEqual([]);
    doc.provenance = { commit: 12, branch: 'main', entry_count: 'x' };
    expect(problemsOf(doc)).toEqual([]);
  });

  it('passes after a plain git merge leaves a stale legacy entry_count', () => {
    const git = (cwd: string, ...args: string[]) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
      if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
      return r.stdout;
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-merge-'));
    tmpDirs.push(dir);
    const rel = '.fleet/kb-canonical.json';
    const write = (doc: unknown) => {
      fs.mkdirSync(path.join(dir, '.fleet'), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), exporterSerialization(doc));
    };
    const base = valid();
    delete base.demotions;
    base.entries = [entry('a-1'), entry('c-3')];
    base.provenance = { commit: 'f'.repeat(40), branch: 'feat/x', entry_count: 2 };
    git(dir, 'init', '-q', '-b', 'main');
    write(base);
    git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base');
    git(dir, 'checkout', '-q', '-b', 'feat/x');
    const branchDoc = { ...base, entries: [entry('a-1'), entry('b-2'), entry('c-3')] };
    write(branchDoc);
    git(dir, 'commit', '-q', '-am', 'branch adds b-2');
    git(dir, 'checkout', '-q', 'main');
    const mainDoc = { ...base, entries: [entry('a-1'), entry('c-3'), entry('e-5')] };
    write(mainDoc);
    git(dir, 'commit', '-q', '-am', 'main adds e-5');
    git(dir, 'checkout', '-q', 'feat/x');
    git(dir, 'merge', '-q', '--no-edit', 'main');
    const merged = JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
    expect(merged.entries).toHaveLength(4);
    expect(merged.provenance.entry_count).toBe(2);
    expect(checkBibleFile(path.join(dir, rel))).toMatchObject({ exists: true, problems: [] });
  });

  it('a missing file is not a failure (nothing to check)', () => {
    const r = checkBibleFile(path.join(os.tmpdir(), 'no-such-dir-' + process.pid, 'kb-canonical.json'));
    expect(r).toMatchObject({ exists: false, problems: [] });
  });
});

describe('check-kb-canonical: each malformed case names the problem', () => {
  it('invalid JSON', () => {
    const problems = validateBibleText('{"version": 3,');
    expect(problems.map(p => p.code)).toEqual(['invalid-json']);
  });

  it('not an envelope (a bare array)', () => {
    expectProblem([entry('a-1')], 'envelope', /envelope/);
  });

  it('an unexpected or missing envelope key', () => {
    const extra = { ...valid(), stray: 1 };
    expectProblem(extra, 'envelope-key', /unexpected top-level key "stray"/);
    const missing = valid();
    delete missing.provenance;
    expectProblem(missing, 'envelope-key', /missing top-level key "provenance"/);
  });

  it('a version other than the current format', () => {
    expectProblem({ ...valid(), version: 2 }, 'version', /version is 2, expected 3/);
  });

  it('provenance without branch, or with an unknown key', () => {
    expectProblem({ ...valid(), provenance: {} }, 'provenance-key', /no branch/);
    expectProblem({ ...valid(), provenance: { branch: 'main', merged_by: 'x' } }, 'provenance-key', /"merged_by"/);
  });

  it('a duplicate entry id', () => {
    const doc = valid();
    doc.entries = [entry('a-1'), entry('b-2'), entry('b-2')];
    expectProblem(doc, 'duplicate-entry-id', /appears more than once/, 'b-2');
  });

  it('entries out of id order', () => {
    const doc = valid();
    doc.entries = [entry('b-2'), entry('a-1')];
    expectProblem(doc, 'entry-order', /out of id order/, 'a-1');
  });

  it('an entry with no id, or an invalid field', () => {
    const doc = valid();
    doc.entries = [entry('a-1'), { type: 'knowledge' }];
    expectProblem(doc, 'entry', /entry #1 has no non-empty string id/);
    const badType = valid();
    badType.entries = [entry('a-1', { type: 'opinion' })];
    expectProblem(badType, 'entry', /unknown type "opinion"/, 'a-1');
  });

  it('a duplicate tombstone id', () => {
    const doc = valid();
    doc.demotions = [{ id: 'd-4', at: AT, reason: 'demoted' }, { id: 'd-4', at: AT, reason: 'demoted' }];
    expectProblem(doc, 'duplicate-tombstone-id', /appears more than once/, 'd-4');
  });

  it('tombstones out of id order', () => {
    const doc = valid();
    doc.demotions = [{ id: 'z-9', at: AT, reason: 'demoted' }, { id: 'd-4', at: AT, reason: 'demoted' }];
    expectProblem(doc, 'tombstone-order', /out of id order/, 'd-4');
  });

  it('an id that is both an entry and a tombstone', () => {
    const doc = valid();
    doc.demotions = [{ id: 'b-2', at: AT, reason: 'demoted' }];
    expectProblem(doc, 'entry-and-tombstone', /both an entry and a tombstone/, 'b-2');
  });

  it('a tombstone with an unknown reason', () => {
    const doc = valid();
    doc.demotions = [{ id: 'd-4', at: AT, reason: 'forgotten' }];
    expectProblem(doc, 'tombstone-reason', /unknown reason "forgotten"/, 'd-4');
  });

  it('a tombstone whose keys do not fit its reason', () => {
    const missingNote = valid();
    missingNote.demotions = [{ id: 'e-5', at: AT, reason: 'withdrawn', evidence_files: ['src/a.ts'] }];
    expectProblem(missingNote, 'tombstone-shape', /reason withdrawn\) is missing "note"/, 'e-5');
    const extraKey = valid();
    extraKey.demotions = [{ id: 'd-4', at: AT, reason: 'demoted', note: 'x' }];
    expectProblem(extraKey, 'tombstone-shape', /unexpected key "note"/, 'd-4');
    const badEvidence = valid();
    badEvidence.demotions = [{ id: 'e-5', at: AT, reason: 'withdrawn', note: 'n', evidence_files: ['../outside.ts'] }];
    expectProblem(badEvidence, 'tombstone-shape', /evidence_files/, 'e-5');
    const badAt = valid();
    badAt.demotions = [{ id: 'd-4', at: 'yesterday', reason: 'demoted' }];
    expectProblem(badAt, 'tombstone', /no valid "at" timestamp/, 'd-4');
  });

  it('an empty demotions list', () => {
    expectProblem({ ...valid(), demotions: [] }, 'demotions', /empty/);
  });

  it('a file not in exporter format', () => {
    const doc = valid();
    const compact = JSON.stringify(doc) + '\n';
    expect(validateBibleText(compact).map(p => p.code)).toEqual(['format']);
    const noNewline = exporterSerialization(doc).slice(0, -1);
    expect(validateBibleText(noNewline).map(p => p.code)).toEqual(['format']);
    const literalNonAscii = exporterSerialization({ ...doc, entries: [entry('a-1', { title: 'caf\u00e9' })] })
      .replace('\\u00e9', '\u00e9');
    const problems = validateBibleText(literalNonAscii);
    expect(problems.map(p => p.code)).toEqual(['format']);
    expect(problems[0].message).toMatch(/first difference at line \d+/);
  });
});

describe('check-kb-canonical: CLI', () => {
  function tmpFile(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-kb-canonical-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'kb-canonical.json');
    fs.writeFileSync(file, content);
    return file;
  }

  it('exits 1 and names the problem and id for a malformed bible', () => {
    const doc = valid();
    doc.demotions = [{ id: 'b-2', at: AT, reason: 'demoted' }];
    const r = spawnSync(process.execPath, [SCRIPT, tmpFile(exporterSerialization(doc))], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[entry-and-tombstone]');
    expect(r.stderr).toContain('"b-2"');
  });

  it('exits 0 for a well-formed bible', () => {
    const r = spawnSync(process.execPath, [SCRIPT, tmpFile(exporterSerialization(valid()))], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
