import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbBibleCommit, kbBibleCommitSchema } from '../../src/tools/kb-bible-commit.js';
import { kbDemote } from '../../src/tools/kb-demote.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';
import { commitWorkTree } from '../helpers/commit-work-tree.js';

// kb_bible_commit WITHDRAWALS and RESTORES, end to end against a REAL temp git
// repository (bare origin + clone), a REAL SqliteProvider and the REAL handler.
// The only vi.spyOn points getKbProviders at this test's provider (the same
// seam tests/knowledge/kb-bible-tombstones.test.ts uses). Every assertion about
// the bible reads the committed file back from disk.
//
// FALSIFICATION: on a tree without withdrawal support the handler ignores
// withdrawals/restore_ids, so every scenario below fails at its first
// assertion on withdrawn/restored or on the tombstone in the file. Checked by
// running this file against the previous commit's src/tools/kb-bible-commit.ts.
//
// All temp repos live under one root removed in afterEach. ASCII only.

const BIBLE_REL = '.fleet/kb-canonical.json';
const NOTE = 'the cited guard was removed\n  when the reader was rewritten';
const NOTE_COLLAPSED = 'the cited guard was removed when the reader was rewritten';
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

function base(commit = 'a'.repeat(40)) {
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

function biblePath(): string {
  return path.join(clone, BIBLE_REL);
}

function readBible(): BibleFile {
  return JSON.parse(fs.readFileSync(biblePath(), 'utf-8')) as BibleFile;
}

function row(id: string): { confidence: string; demoted_at: string | null } {
  return (provider as any).getDb().prepare('SELECT confidence, demoted_at FROM entries WHERE id = ?').get(id);
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-withdrawals-'));
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

describe('kb_bible_commit withdrawals input validation', () => {
  it('refuses a note shorter than 20 characters after whitespace collapse', () => {
    const r = kbBibleCommitSchema.safeParse({
      ids: [], ...base(), withdrawals: [{ id: 'x', note: '  too   \n short   note ', evidence_files: EVIDENCE }],
    });
    expect(r.success).toBe(false);
  });

  it('refuses empty, absolute and escaping evidence_files', () => {
    for (const evidence_files of [[], ['/etc/passwd'], ['../outside.ts'], ['C:\\x.ts'], ['a/../../b']]) {
      const r = kbBibleCommitSchema.safeParse({ ids: [], ...base(), withdrawals: [{ id: 'x', note: NOTE, evidence_files }] });
      expect(r.success).toBe(false);
    }
    const ok = kbBibleCommitSchema.safeParse({ ids: [], ...base(), withdrawals: [{ id: 'x', note: NOTE, evidence_files: ['src/a.ts'] }] });
    expect(ok.success).toBe(true);
  });
});

describe('kb_bible_commit withdrawals (sqlite)', () => {
  it('admits a bible entry with no local demoted_at, tombstones it, and leaves the local row CONFIRMED', async () => {
    const id = await confirmedCiting('Alpha', 'src/alpha.ts');
    const keep = await confirmedCiting('Beta', 'src/beta.ts');
    await kbBibleCommit({ ids: [id, keep], ...base() }, { folder: clone });
    expect(row(id).demoted_at).toBeNull();
    const before = Date.now();

    const r = JSON.parse(await kbBibleCommit(
      { ids: [], withdrawals: [{ id, note: NOTE, evidence_files: EVIDENCE }], ...base() }, { folder: clone },
    ));

    expect(r.withdrawn).toEqual([id]);
    expect(r.restored).toEqual([]);
    expect(r.demoted).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.committed).toBe(true);
    const onDisk = readBible();
    expect(onDisk.entries.map(e => e.id)).toEqual([keep]);
    expect(onDisk.provenance?.entry_count).toBe(1);
    expect(onDisk.demotions).toHaveLength(1);
    const t = onDisk.demotions![0];
    expect(t).toEqual({ id, at: t.at, reason: 'withdrawn', note: NOTE_COLLAPSED, evidence_files: EVIDENCE });
    expect(Date.parse(t.at)).toBeGreaterThanOrEqual(before - 1000);
    expect(git(clone, ['log', '-1', '--format=%s'])).toMatch(/1 withdrawn/);
    // The local row is NOT changed.
    expect(row(id)).toEqual({ confidence: 'CONFIRMED', demoted_at: null });
  });

  it('admits a local CONFIRMED id that is not in the bible as a tombstone only', async () => {
    const id = await confirmedCiting('Alpha', 'src/alpha.ts');
    const r = JSON.parse(await kbBibleCommit(
      { ids: [], withdrawals: [{ id, note: NOTE, evidence_files: EVIDENCE }], ...base() }, { folder: clone },
    ));
    expect(r.withdrawn).toEqual([id]);
    expect(r.committed).toBe(true);
    expect(readBible().entries).toEqual([]);
    expect(readBible().demotions!.map(d => d.id)).toEqual([id]);
  });

  it('skips an unknown, an INFERRED and a superseded id with not_withdrawable, writing nothing', async () => {
    const kept = await confirmedCiting('Alpha', 'src/alpha.ts');
    await kbBibleCommit({ ids: [kept], ...base() }, { folder: clone });
    const { id: inferred } = await provider.capture(makeInput({ title: 'Inferred', summary: 'Inferred only', symbols: ['symInf'], source_files: ['README.md'] }));
    const superseded = await confirmedCiting('Gamma', 'src/gamma.ts');
    (provider as any).getDb().prepare('UPDATE entries SET superseded_at = ? WHERE id = ?').run(new Date().toISOString(), superseded);
    const bytes = fs.readFileSync(biblePath());
    const sha = head();

    const r = JSON.parse(await kbBibleCommit({
      ids: [], ...base(),
      withdrawals: ['kb-unknown', inferred, superseded].map(id => ({ id, note: NOTE, evidence_files: EVIDENCE })),
    }, { folder: clone }));

    expect(r.withdrawn).toEqual([]);
    expect(r.skipped).toEqual([
      { id: 'kb-unknown', reason: 'not_withdrawable' },
      { id: inferred, reason: 'not_withdrawable' },
      { id: superseded, reason: 'not_withdrawable' },
    ]);
    expect(r.committed).toBe(false);
    expect(fs.readFileSync(biblePath()).equals(bytes)).toBe(true);
    expect(head()).toBe(sha);
  });

  it('an id merged through ids in the same call is not withdrawn', async () => {
    const id = await confirmedCiting('Alpha', 'src/alpha.ts');
    const r = JSON.parse(await kbBibleCommit(
      { ids: [id], withdrawals: [{ id, note: NOTE, evidence_files: EVIDENCE }], ...base() }, { folder: clone },
    ));
    expect(r.merged).toEqual([id]);
    expect(r.withdrawn).toEqual([]);
    expect(r.skipped).toEqual([{ id, reason: 'not_withdrawable' }]);
    expect(readBible().demotions).toBeUndefined();
  });

  it('note and evidence_files survive a later unrelated re-commit on the same branch', async () => {
    const id = await confirmedCiting('Alpha', 'src/alpha.ts');
    await kbBibleCommit({ ids: [id], ...base() }, { folder: clone });
    await kbBibleCommit({ ids: [], withdrawals: [{ id, note: NOTE, evidence_files: ['README.md', 'src/alpha.ts'] }], ...base() }, { folder: clone });
    const tombstone = readBible().demotions!;

    const unrelated = await confirmedCiting('Beta', 'src/beta.ts');
    const r = JSON.parse(await kbBibleCommit({ ids: [unrelated], ...base() }, { folder: clone }));

    expect(r.committed).toBe(true);
    expect(r.withdrawn).toEqual([]);
    expect(r.demoted).toEqual([]);
    expect(readBible().entries.map(e => e.id)).toEqual([unrelated]);
    expect(readBible().demotions).toEqual(tombstone);
    expect(tombstone[0].note).toBe(NOTE_COLLAPSED);
    expect(tombstone[0].evidence_files).toEqual(['README.md', 'src/alpha.ts']);
  });

  it('leak regression: a later unrelated commit on a branch that still carries the entry does not tombstone it', async () => {
    const id = await confirmedCiting('Alpha', 'src/alpha.ts');
    await kbBibleCommit({ ids: [id], ...base() }, { folder: clone });
    const mainSha = head();

    // The withdrawal lives on a feature branch only (unmerged).
    git(clone, ['checkout', '--quiet', '-b', 'feat/withdraw']);
    await kbBibleCommit({ ids: [], withdrawals: [{ id, note: NOTE, evidence_files: EVIDENCE }], ...base(mainSha) }, { folder: clone });
    expect(readBible().demotions!.map(d => d.id)).toEqual([id]);

    // Back on main: the entry is still there. An unrelated commit must keep it
    // and add no tombstone of any reason.
    git(clone, ['checkout', '--quiet', 'main']);
    expect(readBible().entries.map(e => e.id)).toEqual([id]);
    const unrelated = await confirmedCiting('Beta', 'src/beta.ts');
    const r = JSON.parse(await kbBibleCommit({ ids: [unrelated], ...base(mainSha) }, { folder: clone }));

    expect(r.demoted).toEqual([]);
    expect(r.withdrawn).toEqual([]);
    expect(readBible().entries.map(e => e.id).sort()).toEqual([id, unrelated].sort());
    expect(readBible().demotions).toBeUndefined();
    expect(row(id)).toEqual({ confidence: 'CONFIRMED', demoted_at: null });
  });
});

describe('kb_bible_commit restore_ids (sqlite)', () => {
  it('removes a branch-added tombstone and re-adds the base entry byte-identical', async () => {
    const id = await confirmedCiting('Alpha', 'src/alpha.ts');
    await kbBibleCommit({ ids: [id], ...base() }, { folder: clone });
    const baseSha = head();
    const baseEntryText = JSON.stringify(readBible().entries.find(e => e.id === id));

    git(clone, ['checkout', '--quiet', '-b', 'feat/restore']);
    await kbBibleCommit({ ids: [], withdrawals: [{ id, note: NOTE, evidence_files: EVIDENCE }], ...base(baseSha) }, { folder: clone });
    expect(readBible().entries).toEqual([]);

    const r = JSON.parse(await kbBibleCommit({ ids: [], restore_ids: [id], ...base(baseSha) }, { folder: clone }));

    expect(r.restored).toEqual([id]);
    expect(r.committed).toBe(true);
    const onDisk = readBible();
    expect(onDisk.demotions).toBeUndefined();
    expect(onDisk.entries.map(e => JSON.stringify(e))).toEqual([baseEntryText]);
    expect(git(clone, ['log', '-1', '--format=%s'])).toMatch(/1 restored/);
  });

  it('removes a branch-added tombstone with no base entry as a tombstone-only change', async () => {
    const id = await confirmedCiting('Alpha', 'src/alpha.ts');
    const baseSha = head();
    await kbBibleCommit({ ids: [], withdrawals: [{ id, note: NOTE, evidence_files: EVIDENCE }], ...base(baseSha) }, { folder: clone });

    const r = JSON.parse(await kbBibleCommit({ ids: [], restore_ids: [id], ...base(baseSha) }, { folder: clone }));

    expect(r.restored).toEqual([id]);
    expect(readBible().entries).toEqual([]);
    expect(readBible().demotions).toBeUndefined();
  });

  it('is a no-op for a tombstone the base already carries, for an id with no tombstone, and for an unresolvable base', async () => {
    const id = await confirmedCiting('Alpha', 'src/alpha.ts');
    const other = await confirmedCiting('Beta', 'src/beta.ts');
    await kbBibleCommit({ ids: [id, other], ...base() }, { folder: clone });
    await kbDemote({ id, reason: DEMOTE_REASON, evidence_files: EVIDENCE }, { folder: clone });
    await kbBibleCommit({ ids: [], demoted_ids: [id], ...base(head()) }, { folder: clone });
    // The tombstone is part of the base now.
    const baseSha = head();
    const bytes = fs.readFileSync(biblePath());

    const r = JSON.parse(await kbBibleCommit({ ids: [], restore_ids: [id, other, 'kb-unknown'], ...base(baseSha) }, { folder: clone }));
    expect(r.restored).toEqual([]);
    expect(r.committed).toBe(false);
    expect(fs.readFileSync(biblePath()).equals(bytes)).toBe(true);

    // A branch-added withdrawal, but a baseCommit that does not resolve.
    await kbBibleCommit({ ids: [], withdrawals: [{ id: other, note: NOTE, evidence_files: EVIDENCE }], ...base(baseSha) }, { folder: clone });
    const bytes2 = fs.readFileSync(biblePath());
    const r2 = JSON.parse(await kbBibleCommit({ ids: [], restore_ids: [other], ...base('f'.repeat(40)) }, { folder: clone }));
    expect(r2.restored).toEqual([]);
    expect(fs.readFileSync(biblePath()).equals(bytes2)).toBe(true);
    expect(head()).not.toBe(baseSha);
  });
});

// A withdrawal never lowers the local row, so a withdrawn id stays CONFIRMED on
// this host (and on any host that has not imported the merged base bible). An
// ids merge must not clear its withdrawn tombstone -- branch-added or merged
// from the base. FALSIFICATION: with the withdrawn_tombstone block removed from
// src/tools/kb-bible-commit.ts the first two tests fail (the id is merged, the
// entry comes back and the tombstone is cleared).
describe('kb_bible_commit ids never clears a withdrawn tombstone (sqlite)', () => {
  it('a branch-added withdrawn tombstone blocks an ids merge: skipped withdrawn_tombstone, tombstone kept', async () => {
    const id = await confirmedCiting('Alpha', 'src/alpha.ts');
    await kbBibleCommit({ ids: [id], ...base() }, { folder: clone });
    const baseSha = head();
    git(clone, ['checkout', '--quiet', '-b', 'feat/withdraw']);
    await kbBibleCommit({ ids: [], withdrawals: [{ id, note: NOTE, evidence_files: EVIDENCE }], ...base(baseSha) }, { folder: clone });
    const tombstones = readBible().demotions;
    const bytes = fs.readFileSync(biblePath());
    const sha = head();
    expect(row(id).confidence).toBe('CONFIRMED');

    const r = JSON.parse(await kbBibleCommit({ ids: [id], ...base(baseSha) }, { folder: clone }));

    expect(r.merged).toEqual([]);
    expect(r.skipped).toEqual([{ id, reason: 'withdrawn_tombstone' }]);
    expect(r.committed).toBe(false);
    expect(fs.readFileSync(biblePath()).equals(bytes)).toBe(true);
    expect(readBible().entries).toEqual([]);
    expect(readBible().demotions).toEqual(tombstones);
    expect(head()).toBe(sha);
  });

  it('a withdrawn tombstone merged from the base blocks an ids merge on a host whose row is still CONFIRMED', async () => {
    const id = await confirmedCiting('Alpha', 'src/alpha.ts');
    const other = await confirmedCiting('Beta', 'src/beta.ts');
    await kbBibleCommit({ ids: [id, other], ...base() }, { folder: clone });
    // The withdrawal is merged history: it is part of the base the next branch starts from.
    await kbBibleCommit({ ids: [], withdrawals: [{ id, note: NOTE, evidence_files: EVIDENCE }], ...base() }, { folder: clone });
    const baseSha = head();
    git(clone, ['checkout', '--quiet', '-b', 'feat/next']);
    // This host never imported the merged base bible: its row is still CONFIRMED.
    expect(row(id)).toEqual({ confidence: 'CONFIRMED', demoted_at: null });
    const tombstones = readBible().demotions;

    const unrelated = await confirmedCiting('Gamma', 'src/gamma.ts');
    const r = JSON.parse(await kbBibleCommit({ ids: [id, unrelated], ...base(baseSha) }, { folder: clone }));

    expect(r.merged).toEqual([unrelated]);
    expect(r.skipped).toEqual([{ id, reason: 'withdrawn_tombstone' }]);
    expect(readBible().entries.map(e => e.id).sort()).toEqual([other, unrelated].sort());
    expect(readBible().demotions).toEqual(tombstones);

    // restore_ids cannot lift a merged one either: still blocked.
    const r2 = JSON.parse(await kbBibleCommit({ ids: [id], restore_ids: [id], ...base(baseSha) }, { folder: clone }));
    expect(r2.restored).toEqual([]);
    expect(r2.skipped).toEqual([{ id, reason: 'withdrawn_tombstone' }]);
    expect(readBible().demotions).toEqual(tombstones);
  });

  it('restore_ids still removes a branch-added withdrawn tombstone, and ids may merge it in the same call', async () => {
    const id = await confirmedCiting('Alpha', 'src/alpha.ts');
    await kbBibleCommit({ ids: [id], ...base() }, { folder: clone });
    const baseSha = head();
    git(clone, ['checkout', '--quiet', '-b', 'feat/withdraw']);
    await kbBibleCommit({ ids: [], withdrawals: [{ id, note: NOTE, evidence_files: EVIDENCE }], ...base(baseSha) }, { folder: clone });
    expect(readBible().demotions!.map(d => d.id)).toEqual([id]);

    const r = JSON.parse(await kbBibleCommit({ ids: [id], restore_ids: [id], ...base(baseSha) }, { folder: clone }));

    expect(r.restored).toEqual([id]);
    expect(r.merged).toEqual([id]);
    expect(r.skipped).toEqual([]);
    expect(readBible().entries.map(e => e.id)).toEqual([id]);
    expect(readBible().demotions).toBeUndefined();
  });
});
