import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbBibleCommit, bibleCommitMessage } from '../../src/tools/kb-bible-commit.js';
import { kbExport } from '../../src/tools/kb-export.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';
import { commitWorkTree } from '../helpers/commit-work-tree.js';

// kb_bible_commit removes bible entries the maintainer KB holds as superseded
// or invalidated, and lists each removal (id + reason) in the response and the
// commit message. It never removes an entry the KB does not know, one the KB
// holds as CONFIRMED and current, or a merely stale one. kb_export stays
// additive-only. Real temp git repo, real SqliteProvider, real handlers.
//
// FALSIFICATION: dropping the removal step in src/tools/kb-bible-commit.ts
// (getRetirementReasons / byId.delete) makes the superseded, invalidated and
// no-ids scenarios FAIL (entries stay in the bible, removed is empty, no
// commit is made).
//
// All temp state lives under one root removed in afterEach.

const BIBLE_REL = '.fleet/kb-canonical.json';
const BASE = { baseBranch: 'main', baseCommit: 'a'.repeat(40) };

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge', title: 'T', summary: 'Summary', content: 'Content body.',
    source_files: ['src/a.ts'], symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256',
    flagged_for_review: false, author: 'test-agent', source: 'doer', confidence: 'INFERRED',
    ...overrides,
  };
}

let root: string;
let clone: string;
let provider: SqliteProvider;

function writeSrc(rel: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(clone, rel)), { recursive: true });
  fs.writeFileSync(path.join(clone, rel), body);
}

async function confirmedCiting(title: string, file: string): Promise<string> {
  writeSrc(file, 'export const ' + title.toLowerCase() + ' = 1;\n');
  const { id } = await provider.capture(makeInput({
    title, summary: 'Summary of ' + title, content: 'Content of ' + title + '.',
    symbols: ['sym' + title], source_files: [file],
  }));
  await provider.promote(id, 'test fixture: verified');
  await provider.promote(id, 'test fixture: verified');
  return id;
}

function bibleIds(): string[] {
  const p = path.join(clone, BIBLE_REL);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf-8')).entries.map((e: { id: string }) => e.id).sort();
}

function lastCommit(): string {
  return git(clone, ['log', '-1', '--format=%B']);
}

function commitCount(): number {
  return Number(git(clone, ['rev-list', '--count', 'HEAD']).trim());
}

/** Commit three CONFIRMED entries to the bible; returns their ids. */
async function seedBible(): Promise<{ a: string; b: string; c: string }> {
  const a = await confirmedCiting('Alpha', 'src/alpha.ts');
  const b = await confirmedCiting('Beta', 'src/beta.ts');
  const c = await confirmedCiting('Gamma', 'src/gamma.ts');
  commitWorkTree(clone);
  const r = JSON.parse(await kbBibleCommit({ ids: [a, b, c], ...BASE }, { folder: clone }));
  expect(r.merged.sort()).toEqual([a, b, c].sort());
  expect(r.removed).toEqual([]);
  expect(bibleIds()).toEqual([a, b, c].sort());
  return { a, b, c };
}

/** Supersede `oldId` by capturing a replacement that names it in supersedes. */
async function supersede(oldId: string, title: string, file: string): Promise<string> {
  const { id, audn_decision } = await provider.capture(makeInput({
    title, summary: 'Summary of ' + title, content: 'Replacement content of ' + title + ', different from before.',
    symbols: ['sym' + title], source_files: [file], supersedes: oldId,
  }));
  expect(audn_decision).toBe('update');
  return id;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-removal-'));
  clone = path.join(root, 'clone');
  fs.mkdirSync(clone);
  git(clone, ['init', '--quiet', '-b', 'main']);
  git(clone, ['config', 'user.name', 'test']);
  git(clone, ['config', 'user.email', 'test@example.invalid']);
  git(clone, ['config', 'commit.gpgsign', 'false']);
  writeSrc('README.md', 'seed\n');
  commitWorkTree(clone, 'seed');

  provider = new SqliteProvider(path.join(root, 'kb.sqlite'), clone);
  await provider.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: provider, global: provider, projectSlug: 'test',
  } as any);
});

afterEach(() => {
  provider.close();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('kb_bible_commit removes superseded and invalidated entries', () => {
  it('removes a superseded and an invalidated entry at the next commit, listing id and reason in the response and the commit message', async () => {
    const { a, b, c } = await seedBible();
    await supersede(a, 'Alpha', 'src/alpha.ts');
    const discard = await provider.discard([b]);
    expect(discard.discarded).toEqual([b]);
    const d = await confirmedCiting('Delta', 'src/delta.ts');
    commitWorkTree(clone);

    const r = JSON.parse(await kbBibleCommit({ ids: [d], ...BASE }, { folder: clone }));

    expect(r.merged).toEqual([d]);
    expect(r.removed).toEqual(
      [{ id: a, reason: 'superseded' }, { id: b, reason: 'invalidated' }].sort((x, y) => (x.id < y.id ? -1 : 1)),
    );
    expect(r.committed).toBe(true);
    expect(r.entry_count).toBe(2);
    expect(bibleIds()).toEqual([c, d].sort());
    const msg = lastCommit();
    expect(msg).toMatch(/commit 1 confirmed entries to the knowledge bible, remove 2 superseded\/invalidated -- 2 total/);
    expect(msg).toContain('- ' + a + ' (superseded)');
    expect(msg).toContain('- ' + b + ' (invalidated)');
  });

  it('a contradiction loser is removed with reason superseded', async () => {
    const { a, b } = await seedBible();
    // Mark the pair the way capture's AUDN 'flagged' path does, then resolve it.
    (provider as any).getDb().prepare('UPDATE entries SET contradiction_of = ?, flagged_for_review = 1 WHERE id = ?').run(a, b);
    await provider.resolveContradiction(a, b, 'test fixture: a wins');

    const r = JSON.parse(await kbBibleCommit({ ids: [], ...BASE }, { folder: clone }));

    expect(r.removed).toEqual([{ id: b, reason: 'superseded' }]);
    expect(bibleIds()).not.toContain(b);
    expect(bibleIds()).toContain(a);
  });

  it('an entry invalidated by file (content_hash invalidated) is removed with reason invalidated', async () => {
    const { a } = await seedBible();
    (provider as any).getDb().prepare("UPDATE entries SET content_hash = 'invalidated', stale = 1 WHERE id = ?").run(a);

    const r = JSON.parse(await kbBibleCommit({ ids: [], ...BASE }, { folder: clone }));

    expect(r.removed).toEqual([{ id: a, reason: 'invalidated' }]);
    expect(bibleIds()).not.toContain(a);
  });

  it('with no requested ids but pending removals, commits the removals', async () => {
    const { a, b, c } = await seedBible();
    await provider.discard([c]);
    const before = commitCount();

    const r = JSON.parse(await kbBibleCommit({ ids: [], ...BASE }, { folder: clone }));

    expect(r.merged).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.removed).toEqual([{ id: c, reason: 'invalidated' }]);
    expect(r.committed).toBe(true);
    expect(commitCount()).toBe(before + 1);
    expect(bibleIds()).toEqual([a, b].sort());
    const msg = lastCommit();
    expect(msg).toMatch(/^chore\(kb\): remove 1 superseded\/invalidated entries from the knowledge bible -- 2 total/);
    expect(msg).toContain('- ' + c + ' (invalidated)');
  });

  it('never removes an entry absent from the maintainer DB', async () => {
    const { a, b, c } = await seedBible();
    // Another clone's entry, unknown to this KB, lands in the bible file.
    const biblePath = path.join(clone, BIBLE_REL);
    const bible = JSON.parse(fs.readFileSync(biblePath, 'utf-8'));
    const foreign = { ...bible.entries[0], id: 'foreign-entry-from-another-clone' };
    bible.entries.push(foreign);
    fs.writeFileSync(biblePath, JSON.stringify(bible, null, 2) + '\n');
    commitWorkTree(clone);
    await provider.discard([a]);

    const r = JSON.parse(await kbBibleCommit({ ids: [], ...BASE }, { folder: clone }));

    expect(r.removed).toEqual([{ id: a, reason: 'invalidated' }]);
    expect(bibleIds()).toEqual([b, c, 'foreign-entry-from-another-clone'].sort());
  });

  it('never removes an entry the KB holds as CONFIRMED and current, nor a merely stale one; nothing to do makes no commit', async () => {
    const { a, b, c } = await seedBible();
    // Freshness-sweep staleness only: stale = 1, not superseded, not invalidated.
    (provider as any).getDb().prepare('UPDATE entries SET stale = 1 WHERE id = ?').run(b);
    const before = commitCount();

    const r = JSON.parse(await kbBibleCommit({ ids: [], ...BASE }, { folder: clone }));

    expect(r.removed).toEqual([]);
    expect(r.committed).toBe(false);
    expect(commitCount()).toBe(before);
    expect(bibleIds()).toEqual([a, b, c].sort());
  });

  it('kb_export removes nothing, even when the KB holds bible entries as superseded or invalidated', async () => {
    const { a, b, c } = await seedBible();
    await supersede(a, 'Alpha', 'src/alpha.ts');
    await provider.discard([b]);
    commitWorkTree(clone);

    await kbExport({}, { folder: clone });

    expect(bibleIds()).toEqual(expect.arrayContaining([a, b, c]));
  });
});

describe('bibleCommitMessage', () => {
  it('keeps the single-line subject when nothing is removed', () => {
    expect(bibleCommitMessage(2, [], 5)).toBe('chore(kb): commit 2 confirmed entries to the knowledge bible -- 5 total');
  });

  it('lists each removal in the body', () => {
    expect(bibleCommitMessage(0, [{ id: 'x', reason: 'superseded' }, { id: 'y', reason: 'invalidated' }], 3)).toBe(
      'chore(kb): remove 2 superseded/invalidated entries from the knowledge bible -- 3 total\n\n'
        + 'Removed:\n- x (superseded)\n- y (invalidated)',
    );
  });
});
