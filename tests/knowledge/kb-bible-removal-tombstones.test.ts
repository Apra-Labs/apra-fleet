import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbBibleCommit } from '../../src/tools/kb-bible-commit.js';
import { kbImport } from '../../src/tools/kb-import.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';
import { commitWorkTree } from '../helpers/commit-work-tree.js';

// A bible REMOVAL crosses clones. kb_bible_commit removes an entry its KB holds
// as superseded or invalidated, and records the removal as a tombstone
// {id, at, reason: superseded | invalidated} in the EXISTING v3 demotions
// array (no new top-level field). kb_import on another clone that holds the id
// as CONFIRMED retires its row, so the entry stops serving FULL-session reads.
//
// Real everything: two SqliteProviders over two real temp git checkouts, the
// real kb_bible_commit / kb_import / kb_query handlers. The only spy is
// getKbProviders, dispatching on the folder the handler resolved.
//
// FALSIFICATION: dropping the removalTombstones upsert in
// src/tools/kb-bible-commit.ts makes the demotions assertions and the
// FULL-session read assertion fail (host B keeps serving the entry);
// dropping the superseded/invalidated branch in importBibleEntries makes the
// FULL-session read assertion fail.
//
// All temp state lives under one root removed in afterEach.

const BASE = { baseBranch: 'main', baseCommit: 'c'.repeat(40) };

let root: string;
let cloneA: string;
let cloneB: string;
let providerA: SqliteProvider;
let providerB: SqliteProvider;

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeCheckout(name: string): string {
  const clone = path.join(root, name);
  fs.mkdirSync(clone);
  git(clone, ['init', '--quiet', '-b', 'main']);
  git(clone, ['config', 'user.name', 'test']);
  git(clone, ['config', 'user.email', 'test@example.invalid']);
  git(clone, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(clone, 'README.md'), 'seed\n');
  commitWorkTree(clone, 'seed');
  return clone;
}

function makeInput(over: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge', title: 'T', summary: 'Summary', content: 'Content body.',
    source_files: ['src/a.ts'], symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256',
    flagged_for_review: false, author: 'test-agent', source: 'doer', confidence: 'INFERRED',
    ...over,
  };
}

function writeSrcBoth(rel: string, body: string): void {
  for (const clone of [cloneA, cloneB]) {
    fs.mkdirSync(path.dirname(path.join(clone, rel)), { recursive: true });
    fs.writeFileSync(path.join(clone, rel), body);
    commitWorkTree(clone);
  }
}

async function confirmedOnA(title: string, file: string): Promise<string> {
  writeSrcBoth(file, 'export const ' + title.toLowerCase() + ' = 1;\n');
  const { id } = await providerA.capture(makeInput({
    title, summary: 'Summary of ' + title, content: 'Content of ' + title + '.',
    symbols: ['sym' + title], source_files: [file],
  }));
  await providerA.promote(id, 'test fixture: verified');
  await providerA.promote(id, 'test fixture: verified');
  return id;
}

const biblePath = (clone: string) => path.join(clone, '.fleet', 'kb-canonical.json');
const readBible = (clone: string) => JSON.parse(fs.readFileSync(biblePath(clone), 'utf-8'));

function copyBibleToB(): void {
  fs.mkdirSync(path.dirname(biblePath(cloneB)), { recursive: true });
  fs.copyFileSync(biblePath(cloneA), biblePath(cloneB));
}

/** Ids a FULL session (no member anchor) gets back from kb_query on clone B. */
async function fullReadIdsOnB(query: string): Promise<string[]> {
  const r = JSON.parse(await kbQuery({ query }, { folder: cloneB }));
  return (r.l1_results as Array<{ id: string }>).map(e => e.id);
}

function retiredRow(provider: SqliteProvider, id: string): { superseded_at: string | null; retired_reason: string | null; stale: number } {
  return (provider as any).getDb()
    .prepare('SELECT superseded_at, retired_reason, stale FROM entries WHERE id = ?').get(id);
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-removal-tombstones-'));
  cloneA = makeCheckout('clone-a');
  cloneB = makeCheckout('clone-b');
  providerA = new SqliteProvider(path.join(root, 'kb-a.sqlite'), cloneA);
  providerB = new SqliteProvider(path.join(root, 'kb-b.sqlite'), cloneB);
  await providerA.init();
  await providerB.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockImplementation(async (folder: string) => {
    const provider = path.resolve(folder) === path.resolve(cloneA) ? providerA : providerB;
    return { project: provider, global: provider, projectSlug: 'test' } as any;
  });
});

afterEach(() => {
  providerA.close();
  providerB.close();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('kb_bible_commit records superseded and invalidated removals as tombstones', () => {
  it('a superseded removal adds {id, at, reason: superseded} to demotions and no new top-level field', async () => {
    const a = await confirmedOnA('Alpha', 'src/alpha.ts');
    const b = await confirmedOnA('Beta', 'src/beta.ts');
    await kbBibleCommit({ ids: [a, b], ...BASE }, { folder: cloneA });
    expect('demotions' in readBible(cloneA)).toBe(false);

    const { audn_decision } = await providerA.capture(makeInput({
      title: 'Alpha', summary: 'Summary of Alpha, replaced', content: 'Replacement content of Alpha, different.',
      symbols: ['symAlpha'], source_files: ['src/alpha.ts'], supersedes: a,
    }));
    expect(audn_decision).toBe('update');

    const r = JSON.parse(await kbBibleCommit({ ids: [], ...BASE }, { folder: cloneA }));
    expect(r.removed).toEqual([{ id: a, reason: 'superseded' }]);
    expect(r.committed).toBe(true);
    expect(r.entry_count).toBe(1);

    const bible = readBible(cloneA);
    expect(Object.keys(bible)).toEqual(['version', 'provenance', 'entries', 'demotions']);
    expect(bible.provenance.entry_count).toBe(1);
    expect(bible.entries.map((e: { id: string }) => e.id)).toEqual([b]);
    expect(bible.demotions).toEqual([{ id: a, at: retiredRow(providerA, a).superseded_at, reason: 'superseded' }]);
  });

  it('an invalidated removal adds reason invalidated, sorted with the other tombstones', async () => {
    const a = await confirmedOnA('Alpha', 'src/alpha.ts');
    const b = await confirmedOnA('Beta', 'src/beta.ts');
    const c = await confirmedOnA('Gamma', 'src/gamma.ts');
    await kbBibleCommit({ ids: [a, b, c], ...BASE }, { folder: cloneA });
    await providerA.discard([a, c]);

    const r = JSON.parse(await kbBibleCommit({ ids: [], ...BASE }, { folder: cloneA }));
    expect(r.removed.map((x: { reason: string }) => x.reason)).toEqual(['invalidated', 'invalidated']);
    const demotions = readBible(cloneA).demotions as Array<{ id: string; reason: string }>;
    expect(demotions.map(d => d.id)).toEqual([a, c].sort());
    expect(demotions.every(d => d.reason === 'invalidated')).toBe(true);
  });
});

describe('kb_import retires a CONFIRMED row a superseded or invalidated tombstone names', () => {
  it('host B stops returning the removed entry from a FULL-session read', async () => {
    const a = await confirmedOnA('Alpha', 'src/alpha.ts');
    const b = await confirmedOnA('Beta', 'src/beta.ts');
    await kbBibleCommit({ ids: [a, b], ...BASE }, { folder: cloneA });

    copyBibleToB();
    const first = JSON.parse(await kbImport({ skip_sweep: true }, { folder: cloneB }));
    expect(first.imported).toBe(2);
    expect(first.retired).toBe(0);
    expect(await fullReadIdsOnB('Alpha')).toContain(a);

    await providerA.discard([a]);
    await kbBibleCommit({ ids: [], ...BASE }, { folder: cloneA });
    copyBibleToB();

    const second = JSON.parse(await kbImport({ skip_sweep: true }, { folder: cloneB }));
    expect(second.retired).toBe(1);
    expect(second.demoted).toBe(0);
    expect(await fullReadIdsOnB('Alpha')).not.toContain(a);
    expect(retiredRow(providerB, a).retired_reason).toBe('invalidated');
    // The untouched entry still serves.
    expect(await fullReadIdsOnB('Beta')).toContain(b);

    // Idempotent: a re-import retires nothing more.
    const third = JSON.parse(await kbImport({ skip_sweep: true }, { folder: cloneB }));
    expect(third.retired).toBe(0);
  });

  it('a row promoted on host B after the tombstone is kept (the re-promotion rule)', async () => {
    const a = await confirmedOnA('Alpha', 'src/alpha.ts');
    await kbBibleCommit({ ids: [a], ...BASE }, { folder: cloneA });
    copyBibleToB();
    await kbImport({ skip_sweep: true }, { folder: cloneB });

    await providerA.discard([a]);
    await kbBibleCommit({ ids: [], ...BASE }, { folder: cloneA });
    const at = readBible(cloneA).demotions[0].at as string;
    // B promoted its copy strictly after the retirement on A.
    (providerB as any).getDb().prepare('UPDATE entries SET promoted_at = ? WHERE id = ?')
      .run(new Date(Date.parse(at) + 1000).toISOString(), a);
    copyBibleToB();

    const r = JSON.parse(await kbImport({ skip_sweep: true }, { folder: cloneB }));
    expect(r.retired).toBe(0);
    expect(retiredRow(providerB, a).superseded_at).toBeNull();
  });

  it('a tombstone naming an id host B does not hold creates no row, and unknown reasons are ignored', async () => {
    const a = await confirmedOnA('Alpha', 'src/alpha.ts');
    await kbBibleCommit({ ids: [a], ...BASE }, { folder: cloneA });
    copyBibleToB();
    await kbImport({ skip_sweep: true }, { folder: cloneB });

    const bible = readBible(cloneB);
    bible.demotions = [
      { id: a, at: '2030-01-01T00:00:00.000Z', reason: 'archived' },
      { id: 'ghost-id', at: '2020-01-01T00:00:00.000Z', reason: 'superseded' },
    ];
    fs.writeFileSync(biblePath(cloneB), JSON.stringify(bible));
    const r = JSON.parse(await kbImport({ skip_sweep: true }, { folder: cloneB }));
    expect(r.retired).toBe(0);
    expect(providerB.hasEntry('ghost-id')).toBe(false);
    expect(retiredRow(providerB, a).superseded_at).toBeNull();
  });
});
