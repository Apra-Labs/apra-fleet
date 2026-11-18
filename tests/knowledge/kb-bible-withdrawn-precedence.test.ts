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

// kb_bible_commit: a WITHDRAWN tombstone outranks a demotion, and a base bible
// that cannot be read is REPORTED (base_bible_error), end to end against a REAL
// temp git repository (bare origin + clone), a REAL SqliteProvider and the REAL
// handler. The only vi.spyOn points getKbProviders at this test's provider (the
// seam tests/knowledge/kb-bible-withdrawals.test.ts uses). Every assertion about
// the bible reads the file back from disk.
//
// FALSIFICATION (checked): with the withdrawn-precedence change reverted in
// src/tools/kb-bible-commit.ts (no withdrawn_tombstone skip for demoted_ids, no
// withdrawnInFile guard in the every-call rule, demoted tombstones allowed to
// overwrite withdrawn ones), the first test fails -- the demotion is admitted
// and the withdrawn tombstone is replaced by a demoted one -- and the
// every-call test fails the same way. With base_bible_error removed, the
// unreadable-base test fails on its base_bible_error assertion.
//
// All temp repos live under one root removed in afterEach. ASCII only.

const BIBLE_REL = '.fleet/kb-canonical.json';
const NOTE = 'the cited guard was removed when the reader was rewritten';
const EVIDENCE = ['README.md'];
const DEMOTE_REASON = 'the cited behaviour did not hold on the case checked this round';

interface Tombstone { id: string; at: string; reason: string; note?: string; evidence_files?: string[] }
interface BibleFile {
  version?: number;
  provenance?: { commit: string | null; branch: string | null; entry_count: number };
  entries: Array<{ id: string } & Record<string, unknown>>;
  demotions?: Tombstone[];
}

let root: string;
let clone: string;
let provider: SqliteProvider;

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function head(): string {
  return git(clone, ['rev-parse', 'HEAD']).trim();
}

function base(commit: string) {
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

async function repromote(id: string): Promise<void> {
  while (row(id).confidence !== 'CONFIRMED') await provider.promote(id, 'test fixture: re-verified');
}

function biblePath(): string {
  return path.join(clone, BIBLE_REL);
}

function readBible(): BibleFile {
  return JSON.parse(fs.readFileSync(biblePath(), 'utf-8')) as BibleFile;
}

function writeBible(doc: BibleFile): void {
  fs.writeFileSync(biblePath(), JSON.stringify(doc, null, 2) + '\n');
}

function row(id: string): { confidence: string; demoted_at: string | null } {
  return (provider as any).getDb().prepare('SELECT confidence, demoted_at FROM entries WHERE id = ?').get(id);
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-withdrawn-precedence-'));
  const origin = path.join(root, 'origin.git');
  clone = path.join(root, 'clone');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '--quiet', origin, clone], { stdio: ['ignore', 'pipe', 'pipe'] });
  git(clone, ['config', 'user.name', 'test']);
  git(clone, ['config', 'user.email', 'test@example.invalid']);
  git(clone, ['config', 'commit.gpgsign', 'false']);
  git(clone, ['checkout', '--quiet', '-B', 'main']);
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

describe('kb_bible_commit: a withdrawn tombstone outranks a demotion (sqlite)', () => {
  it('demoted_ids never replaces a withdrawn tombstone, and a later ids re-promotion cannot clear it', async () => {
    const id = await confirmedCiting('Alpha', 'src/alpha.ts');
    const other = await confirmedCiting('Beta', 'src/beta.ts');
    const seed = head();
    await kbBibleCommit({ ids: [id, other], ...base(seed) }, { folder: clone });
    // The withdrawal is merged history: the base the next branch starts from carries it.
    await kbBibleCommit({ ids: [], withdrawals: [{ id, note: NOTE, evidence_files: EVIDENCE }], ...base(seed) }, { folder: clone });
    const baseSha = head();
    git(clone, ['checkout', '--quiet', '-b', 'feat/demote']);
    const withdrawn = readBible().demotions!.find(d => d.id === id)!;
    expect(withdrawn.reason).toBe('withdrawn');

    // This host demotes the id locally (it never imported the merged base bible).
    await kbDemote({ id, reason: DEMOTE_REASON, evidence_files: EVIDENCE }, { folder: clone });
    expect(row(id).demoted_at).not.toBeNull();
    expect(row(id).confidence).not.toBe('CONFIRMED');

    const r = JSON.parse(await kbBibleCommit({ ids: [], demoted_ids: [id], ...base(baseSha) }, { folder: clone }));
    expect(r.demoted).toEqual([]);
    expect(r.skipped).toEqual([{ id, reason: 'withdrawn_tombstone' }]);
    expect(r).not.toHaveProperty('base_bible_error');
    // Same at, note and evidence_files: the withdrawn tombstone is untouched.
    expect(readBible().demotions).toEqual([withdrawn]);

    // Re-promote locally, then try to merge it back through ids.
    await repromote(id);
    const r2 = JSON.parse(await kbBibleCommit({ ids: [id], ...base(baseSha) }, { folder: clone }));
    expect(r2.merged).toEqual([]);
    expect(r2.skipped).toEqual([{ id, reason: 'withdrawn_tombstone' }]);
    expect(readBible().demotions).toEqual([withdrawn]);
    expect(readBible().entries.map(e => e.id)).toEqual([other]);
  });

  it('the every-call demotion rule never turns a withdrawn tombstone into a demoted one', async () => {
    const id = await confirmedCiting('Alpha', 'src/alpha.ts');
    const seed = head();
    await kbBibleCommit({ ids: [id], ...base(seed) }, { folder: clone });
    const withEntry = head();
    await kbBibleCommit({ ids: [], withdrawals: [{ id, note: NOTE, evidence_files: EVIDENCE }], ...base(seed) }, { folder: clone });
    // A branch that still carries the entry next to the withdrawn tombstone
    // (e.g. a merge that kept both sides): the every-call rule sees the entry.
    const entryBible = git(clone, ['show', withEntry + ':' + BIBLE_REL]);
    const doc = readBible();
    doc.entries = (JSON.parse(entryBible) as BibleFile).entries;
    doc.provenance!.entry_count = doc.entries.length;
    writeBible(doc);
    git(clone, ['add', BIBLE_REL]);
    git(clone, ['commit', '--quiet', '-m', 'bible carries entry and withdrawn tombstone']);
    const baseSha = head();
    git(clone, ['checkout', '--quiet', '-b', 'feat/unrelated']);
    const withdrawn = readBible().demotions!.find(d => d.id === id)!;
    expect(readBible().entries.map(e => e.id)).toEqual([id]);

    await kbDemote({ id, reason: DEMOTE_REASON, evidence_files: EVIDENCE }, { folder: clone });
    const unrelated = await confirmedCiting('Gamma', 'src/gamma.ts');

    // id is NOT named: only the every-call rule could touch it.
    const r = JSON.parse(await kbBibleCommit({ ids: [unrelated], ...base(baseSha) }, { folder: clone }));
    expect(r.merged).toEqual([unrelated]);
    expect(r.demoted).toEqual([]);
    expect(readBible().demotions).toEqual([withdrawn]);
  });
});

describe('kb_bible_commit: an unreadable base bible is reported (sqlite)', () => {
  it('writes no demoted tombstone and reports base_bible_error when the bible at baseCommit does not parse', async () => {
    const y = await confirmedCiting('Yankee', 'src/yankee.ts');
    const z = await confirmedCiting('Zulu', 'src/zulu.ts');
    // The base commit carries a .fleet/kb-canonical.json that is not valid JSON.
    fs.mkdirSync(path.dirname(biblePath()), { recursive: true });
    fs.writeFileSync(biblePath(), '{ this is not json\n');
    git(clone, ['add', BIBLE_REL]);
    git(clone, ['commit', '--quiet', '-m', 'broken bible']);
    const brokenBase = head();

    // The branch carries a valid bible: entries y and z, and a withdrawn tombstone for z.
    git(clone, ['checkout', '--quiet', '-b', 'feat/broken-base']);
    fs.rmSync(biblePath());
    await kbBibleCommit({ ids: [y, z], ...base(brokenBase) }, { folder: clone });
    await kbBibleCommit({ ids: [], withdrawals: [{ id: z, note: NOTE, evidence_files: EVIDENCE }], ...base(brokenBase) }, { folder: clone });
    const tombstones = readBible().demotions;
    expect(tombstones!.map(d => d.id)).toEqual([z]);
    const bytes = fs.readFileSync(biblePath());
    const sha = head();

    await kbDemote({ id: y, reason: DEMOTE_REASON, evidence_files: EVIDENCE }, { folder: clone });

    // Every-call rule: y is in the bible and locally demoted, but the base cannot be read.
    const r = JSON.parse(await kbBibleCommit({ ids: [], ...base(brokenBase) }, { folder: clone }));
    expect(r.demoted).toEqual([]);
    expect(r.committed).toBe(false);
    expect(r.base_bible_error).toMatch(/not readable/);
    expect(readBible().demotions).toEqual(tombstones);
    expect(readBible().entries.map(e => e.id)).toEqual([y]);
    expect(fs.readFileSync(biblePath()).equals(bytes)).toBe(true);
    expect(head()).toBe(sha);

    // Named demotion: skipped not_in_base_bible, same error reported.
    const r2 = JSON.parse(await kbBibleCommit({ ids: [], demoted_ids: [y], ...base(brokenBase) }, { folder: clone }));
    expect(r2.skipped).toEqual([{ id: y, reason: 'not_in_base_bible' }]);
    expect(r2.base_bible_error).toMatch(/not readable/);
    expect(readBible().demotions).toEqual(tombstones);

    // An unresolvable baseCommit is reported too.
    const r3 = JSON.parse(await kbBibleCommit({ ids: [], demoted_ids: [y], ...base('f'.repeat(40)) }, { folder: clone }));
    expect(r3.base_bible_error).toMatch(/does not resolve/);
    expect(readBible().demotions).toEqual(tombstones);
  });

  it('a readable base yields no base_bible_error (positive control)', async () => {
    const y = await confirmedCiting('Yankee', 'src/yankee.ts');
    await kbBibleCommit({ ids: [y], ...base(head()) }, { folder: clone });
    const baseSha = head();
    git(clone, ['checkout', '--quiet', '-b', 'feat/readable-base']);
    await kbDemote({ id: y, reason: DEMOTE_REASON, evidence_files: EVIDENCE }, { folder: clone });

    const r = JSON.parse(await kbBibleCommit({ ids: [], demoted_ids: [y], ...base(baseSha) }, { folder: clone }));
    expect(r.demoted).toEqual([y]);
    expect(r).not.toHaveProperty('base_bible_error');
    expect(readBible().demotions!.map(d => [d.id, d.reason])).toEqual([[y, 'demoted']]);
  });

  it('a call that never needs the base yields no base_bible_error even when baseCommit does not resolve', async () => {
    const y = await confirmedCiting('Yankee', 'src/yankee.ts');
    const r = JSON.parse(await kbBibleCommit({ ids: [y], ...base('f'.repeat(40)) }, { folder: clone }));
    expect(r.merged).toEqual([y]);
    expect(r).not.toHaveProperty('base_bible_error');
  });
});
