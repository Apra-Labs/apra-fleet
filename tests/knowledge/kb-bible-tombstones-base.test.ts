import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbBibleCommit } from '../../src/tools/kb-bible-commit.js';
import { kbDemote } from '../../src/tools/kb-demote.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';
import { commitWorkTree } from '../helpers/commit-work-tree.js';

// The BASE-BIBLE GATE on kb_bible_commit demoted tombstones, end to end against
// a REAL temp git repository, a REAL SqliteProvider and the REAL kb_demote /
// kb_bible_commit handlers. The only vi.spyOn is getKbProviders, which points
// the handlers at this test's own provider (same seam as
// tests/knowledge/kb-bible-tombstones.test.ts).
//
// A demoted tombstone is meaningful only for an id the bible at baseCommit
// carries. Scenarios:
//   1. demoted_ids names an id the base bible lacks and the branch file does
//      not carry -> no tombstone, skipped with not_in_base_bible.
//   2. the every-call rule meets a locally demoted entry the BRANCH added
//      (absent from the base) -> dropped from entries, no tombstone.
//   3. positive control: the base bible carries the id -> tombstoned as before.
//   4. baseCommit does not resolve -> no new demoted tombstone; tombstones
//      already in the file are kept byte-identical.
//
// FALSIFICATION: scenarios 1 and 2 fail with the gate in
// src/tools/kb-bible-commit.ts reverted (a tombstone is written for the id).
//
// EVERY assertion reads the bible back from disk. All temp repos live under one
// root removed in afterEach.
//
// ASCII only.

const BIBLE_REL = '.fleet/kb-canonical.json';
const DEMOTE_REASON = 'the cited behaviour did not hold on the case checked this round';
const DEMOTE_EVIDENCE = ['README.md'];

interface Tombstone { id: string; at: string; reason: string }
interface BibleFile { entries: { id: string }[]; demotions?: Tombstone[] }

let root: string;
let clone: string;
let provider: SqliteProvider;

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function head(): string {
  return git(clone, ['rev-parse', 'HEAD']).trim();
}

function base(commit: string): { baseBranch: string; baseCommit: string } {
  return { baseBranch: 'main', baseCommit: commit };
}

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge', title: 'T', summary: 'Summary', content: 'Content body.',
    source_files: ['src/a.ts'], symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256',
    flagged_for_review: false, author: 'test-agent', source: 'doer', confidence: 'INFERRED',
    ...overrides,
  };
}

/** A live CONFIRMED entry citing `file`, captured after the file is committed so its basis matches HEAD. */
async function confirmedCiting(title: string, file: string): Promise<string> {
  fs.mkdirSync(path.dirname(path.join(clone, file)), { recursive: true });
  fs.writeFileSync(path.join(clone, file), 'export const ' + title.toLowerCase() + ' = 1;\n');
  commitWorkTree(clone);
  const { id } = await provider.capture(makeInput({
    title, summary: 'Summary of ' + title, symbols: ['sym' + title], source_files: [file],
  }));
  await provider.promote(id, 'test fixture: verified');
  await provider.promote(id, 'test fixture: verified');
  return id;
}

async function demote(id: string): Promise<void> {
  await kbDemote({ id, reason: DEMOTE_REASON, evidence_files: DEMOTE_EVIDENCE }, { folder: clone });
}

function biblePath(): string {
  return path.join(clone, BIBLE_REL);
}

function readBibleFile(): BibleFile {
  return JSON.parse(fs.readFileSync(biblePath(), 'utf-8')) as BibleFile;
}

function bibleIds(): string[] {
  if (!fs.existsSync(biblePath())) return [];
  return readBibleFile().entries.map(e => e.id).sort();
}

function bibleTombstones(): Tombstone[] {
  if (!fs.existsSync(biblePath())) return [];
  return readBibleFile().demotions ?? [];
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-tombstones-base-'));
  clone = path.join(root, 'clone');
  fs.mkdirSync(clone);
  git(clone, ['init', '--quiet', '-b', 'main']);
  git(clone, ['config', 'user.name', 'test']);
  git(clone, ['config', 'user.email', 'test@example.invalid']);
  git(clone, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(clone, 'README.md'), 'seed\n');
  git(clone, ['add', '-A']);
  git(clone, ['commit', '--quiet', '-m', 'seed']);

  provider = new SqliteProvider(path.join(root, 'kb.sqlite'), clone);
  await provider.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: provider, global: provider, projectSlug: 'test',
  } as any);
});

afterEach(() => {
  provider.close();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('kb_bible_commit base-bible gate on demoted tombstones', () => {
  it('scenario 1: demoted_ids naming an id the base bible lacks writes no tombstone and reports not_in_base_bible', async () => {
    // The base bible carries only an unrelated entry; X was never in any bible
    // this branch builds on (it exists only in another branch's bible).
    const other = await confirmedCiting('Other', 'src/other.ts');
    await kbBibleCommit({ ids: [other], ...base(head()) }, { folder: clone });
    const baseSha = head();
    const x = await confirmedCiting('Xray', 'src/xray.ts');
    await demote(x);

    const r = JSON.parse(await kbBibleCommit({ ids: [], demoted_ids: [x], ...base(baseSha) }, { folder: clone }));

    expect(r.skipped).toEqual([{ id: x, reason: 'not_in_base_bible' }]);
    expect(r.demoted).toEqual([]);
    expect(bibleTombstones().map(t => t.id)).not.toContain(x);
    expect(bibleIds()).toEqual([other]);
  });

  it('scenario 2: a locally demoted entry the branch added is dropped by the every-call rule with no tombstone', async () => {
    // Base: a commit with no bible at all.
    const baseSha = head();
    const x = await confirmedCiting('Xray', 'src/xray.ts');
    await kbBibleCommit({ ids: [x], ...base(baseSha) }, { folder: clone });
    expect(bibleIds()).toEqual([x]);
    await demote(x);
    const unrelated = await confirmedCiting('Zulu', 'src/zulu.ts');

    const r = JSON.parse(await kbBibleCommit({ ids: [unrelated], ...base(baseSha) }, { folder: clone }));

    expect(r.merged).toEqual([unrelated]);
    expect(r.committed).toBe(true);
    expect(bibleTombstones().map(t => t.id)).not.toContain(x);
    expect(readBibleFile().demotions).toBeUndefined();
    // Still removed from entries: the branch's own entry is gone, quietly.
    expect(bibleIds()).toEqual([unrelated]);
    expect(r.demoted).toEqual([x]);
  });

  it('scenario 3 (positive control): an id the base bible carries is tombstoned {id, at, reason: demoted}', async () => {
    const x = await confirmedCiting('Xray', 'src/xray.ts');
    const other = await confirmedCiting('Other', 'src/other.ts');
    await kbBibleCommit({ ids: [x, other], ...base(head()) }, { folder: clone });
    const baseSha = head();
    await demote(x);

    const r = JSON.parse(await kbBibleCommit({ ids: [], demoted_ids: [x], ...base(baseSha) }, { folder: clone }));

    expect(r.demoted).toEqual([x]);
    expect(r.skipped).toEqual([]);
    const tombstones = bibleTombstones();
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({ id: x, reason: 'demoted' });
    expect(typeof tombstones[0].at).toBe('string');
    expect(bibleIds()).toEqual([other]);
  });

  it('scenario 4: an unresolvable baseCommit writes no new demoted tombstone and keeps existing ones byte-identical', async () => {
    // An existing tombstone, written against a real base.
    const old = await confirmedCiting('Old', 'src/old.ts');
    const w = await confirmedCiting('Whiskey', 'src/whiskey.ts');
    await kbBibleCommit({ ids: [old, w], ...base(head()) }, { folder: clone });
    await demote(old);
    await kbBibleCommit({ ids: [], demoted_ids: [old], ...base(head()) }, { folder: clone });
    const before = bibleTombstones();
    expect(before.map(t => t.id)).toEqual([old]);
    const beforeBytes = JSON.stringify(before);

    // W is in the bible and locally demoted, but the base cannot be read.
    await demote(w);
    const unrelated = await confirmedCiting('Zulu', 'src/zulu.ts');
    const r = JSON.parse(await kbBibleCommit(
      { ids: [unrelated], demoted_ids: [w], ...base('f'.repeat(40)) }, { folder: clone },
    ));

    expect(r.merged).toEqual([unrelated]);
    expect(r.skipped).toEqual([{ id: w, reason: 'not_in_base_bible' }]);
    expect(r.demoted).toEqual([]);
    expect(JSON.stringify(bibleTombstones())).toBe(beforeBytes);
    // Fail closed: W is neither tombstoned nor dropped.
    expect(bibleIds()).toEqual([unrelated, w].sort());
  });
});
