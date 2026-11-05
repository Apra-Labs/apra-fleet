import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbBibleCommit } from '../../src/tools/kb-bible-commit.js';
import { kbImport } from '../../src/tools/kb-import.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';
import { commitWorkTree } from '../helpers/commit-work-tree.js';
import { mergeKbCanonical } from '../../packages/apra-fleet-se/scripts/merge-kb-canonical.mjs';

// Lane integration: removed bible entries stop serving on other hosts, and
// kb_import enriches poor rows.
//
// Two host DBs (A, the maintainer; B, another host) over two real temp git
// checkouts holding the same source files, one bible committed by A:
//
//   1. A commits a bible with P (written with no rich fields), S, I, K and D.
//   2. B imports it: B now holds P (a POOR row), S, I and K as CONFIRMED rows,
//      and B already held D under a DIFFERING claim (a local capture).
//   3. A supersedes S, invalidates I and enriches P, and commits again.
//   4. B imports the new bible.
//
// Observable acceptance, each asserted below:
//   - the committed bible records both removals in the existing v3 demotions
//     array (reasons superseded and invalidated), no new top-level field;
//   - B no longer returns S or I from a FULL-session read (kb_query);
//   - B's poor P row now carries the rich fields;
//   - B's differing D row is not overwritten;
//   - the bible validates against memory-contract/v1/bible/kb-canonical.schema.json
//     and merges with merge-kb-canonical.
//
// FALSIFICATION (verified by making the edit and re-running): dropping the
// `tombstones.set` of removalTombstones in src/tools/kb-bible-commit.ts makes
// the demotions assertion and the FULL-session read assertion fail (B keeps
// serving S and I).
//
// Real handlers; the only spy is getKbProviders, dispatching on the folder.
// All temp state lives under one root removed in afterEach.

const BASE = { baseBranch: 'main', baseCommit: 'd'.repeat(40) };
const SCHEMA = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'memory-contract', 'v1', 'bible', 'kb-canonical.schema.json'), 'utf-8'));
const RICH = 'Rich lesson body for the poor row: the import fills it in when the claim is the same and the row lacks it.';

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

function input(title: string, file: string, over: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge', title, summary: 'Summary of ' + title, content: 'Content of ' + title + ', beyond its summary.',
    source_files: [file], symbols: ['sym' + title], tags: [], content_hash: '', content_hash_type: 'sha256',
    flagged_for_review: false, author: 'test-agent', source: 'doer', confidence: 'INFERRED', ...over,
  };
}

function writeSrcBoth(rel: string): void {
  for (const clone of [cloneA, cloneB]) {
    fs.mkdirSync(path.dirname(path.join(clone, rel)), { recursive: true });
    fs.writeFileSync(path.join(clone, rel), 'export const v = ' + JSON.stringify(rel) + ';\n');
    commitWorkTree(clone);
  }
}

async function confirmed(provider: SqliteProvider, i: KBEntryInput, preferredId?: string): Promise<string> {
  const { id } = preferredId ? await provider.capture(i, { preferredId }) : await provider.capture(i);
  await provider.promote(id, 'test fixture: verified');
  await provider.promote(id, 'test fixture: verified');
  return id;
}

const biblePath = (clone: string) => path.join(clone, '.fleet', 'kb-canonical.json');
const readBible = (clone: string) => JSON.parse(fs.readFileSync(biblePath(clone), 'utf-8'));
const bibleAt = (rev: string) => JSON.parse(git(cloneA, ['show', rev + ':.fleet/kb-canonical.json']));

function copyBibleToB(): void {
  fs.mkdirSync(path.dirname(biblePath(cloneB)), { recursive: true });
  fs.copyFileSync(biblePath(cloneA), biblePath(cloneB));
}

async function fullReadIdsOnB(query: string): Promise<string[]> {
  const r = JSON.parse(await kbQuery({ query }, { folder: cloneB }));
  return (r.l1_results as Array<{ id: string }>).map(e => e.id);
}

function rowB(id: string): Record<string, unknown> {
  return (providerB as any).getDb()
    .prepare('SELECT title, summary, content, recall_cues, error_signatures, confidence, superseded_at FROM entries WHERE id = ?').get(id);
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-removal-enrich-e2e-'));
  cloneA = makeCheckout('host-a');
  cloneB = makeCheckout('host-b');
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

describe('removed bible entries stop serving on other hosts and kb_import enriches poor rows', () => {
  it('runs the two-host round trip end to end', async () => {
    for (const f of ['src/p.ts', 'src/s.ts', 'src/i.ts', 'src/k.ts', 'src/d.ts']) writeSrcBoth(f);

    // --- 1. A commits the first bible. P carries no rich fields (content = summary).
    const p = await confirmed(providerA, input('Papa', 'src/p.ts', { content: 'Summary of Papa' }));
    const s = await confirmed(providerA, input('Sierra', 'src/s.ts'));
    const i = await confirmed(providerA, input('India', 'src/i.ts'));
    const k = await confirmed(providerA, input('Kilo', 'src/k.ts'));
    const d = await confirmed(providerA, input('Delta', 'src/d.ts'));
    const first = JSON.parse(await kbBibleCommit({ ids: [p, s, i, k, d], ...BASE }, { folder: cloneA }));
    expect(first.committed).toBe(true);
    const firstRev = git(cloneA, ['rev-parse', 'HEAD']).trim();
    expect(readBible(cloneA).entries.find((e: { id: string }) => e.id === p).content).toBeUndefined();

    // --- 2. B holds D under a differing claim, then imports the first bible.
    await confirmed(providerB, input('Delta', 'src/d.ts', { summary: 'A different local claim about Delta on host B' }), d);
    const dBefore = rowB(d);
    copyBibleToB();
    const imp1 = JSON.parse(await kbImport({ skip_sweep: true }, { folder: cloneB }));
    expect(imp1.imported).toBe(4);
    expect(imp1.skipped).toBe(1);
    for (const id of [p, s, i, k]) expect(rowB(id).confidence).toBe('CONFIRMED');
    expect(rowB(p).content).toBe('Summary of Papa');
    expect(await fullReadIdsOnB('Sierra')).toContain(s);
    expect(await fullReadIdsOnB('India')).toContain(i);

    // --- 3. A supersedes S, invalidates I, enriches P, and commits again.
    const { audn_decision } = await providerA.capture(input('Sierra', 'src/s.ts', {
      summary: 'Summary of Sierra, replaced', content: 'Replacement content of Sierra, a different lesson.', supersedes: s,
    }));
    expect(audn_decision).toBe('update');
    expect((await providerA.discard([i])).discarded).toEqual([i]);
    const second = JSON.parse(await kbBibleCommit({
      ids: [], ...BASE, enrich: [{ id: p, content: RICH, recall_cues: ['poor row lacks content'], error_signatures: ['row stays poor'] }],
    }, { folder: cloneA }));
    expect(second.committed).toBe(true);
    expect(second.enriched).toEqual([p]);
    expect(second.removed).toEqual([{ id: i, reason: 'invalidated' }, { id: s, reason: 'superseded' }].sort((x, y) => (x.id < y.id ? -1 : 1)));

    // --- 4. B imports the new bible.
    copyBibleToB();
    const imp2 = JSON.parse(await kbImport({ skip_sweep: true }, { folder: cloneB }));

    // Neither removed entry serves a FULL-session read on B any more.
    expect(await fullReadIdsOnB('Sierra')).not.toContain(s);
    expect(await fullReadIdsOnB('India')).not.toContain(i);
    expect(await fullReadIdsOnB('Kilo')).toContain(k);

    expect(imp2.retired).toBe(2);
    expect(imp2.enriched).toBe(1);

    // The committed bible: both removals in the existing demotions array, no new top-level field.
    const bible = bibleAt('HEAD');
    expect(Object.keys(bible)).toEqual(['version', 'provenance', 'entries', 'demotions']);
    expect(bible.version).toBe(3);
    expect(Object.fromEntries(bible.demotions.map((t: { id: string; reason: string }) => [t.id, t.reason])))
      .toEqual({ [s]: 'superseded', [i]: 'invalidated' });
    expect(bible.entries.map((e: { id: string }) => e.id).sort()).toEqual([p, k, d].sort());
    expect(bible.provenance.entry_count).toBe(3);

    // It validates against the published schema.
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(SCHEMA);
    const ok = validate(bible);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);

    // It merges with merge-kb-canonical: a side still carrying S and I unchanged
    // resolves to the tombstones.
    const merged = mergeKbCanonical(bibleAt(firstRev), bible, bibleAt(firstRev));
    expect(merged.conflicts).toEqual([]);
    expect(merged.merged.entries.map((e: { id: string }) => e.id).sort()).toEqual([p, k, d].sort());
    expect(merged.merged.demotions).toEqual(bible.demotions);

    // B's poor row now carries the rich fields, at unchanged confidence.
    const pAfter = rowB(p);
    expect(pAfter.content).toBe(RICH);
    expect(JSON.parse(String(pAfter.recall_cues))).toEqual(['poor row lacks content']);
    expect(JSON.parse(String(pAfter.error_signatures))).toEqual(['row stays poor']);
    expect(pAfter.confidence).toBe('CONFIRMED');

    // B's differing claim is not overwritten.
    expect(rowB(d)).toEqual(dBefore);
  });
});
