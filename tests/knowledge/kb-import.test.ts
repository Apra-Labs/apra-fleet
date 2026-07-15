import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbImport } from '../../src/tools/kb-import.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';

// T2.1 (F4, D3 HARDENED): kb_import -- trusted-channel import with directive
// quarantine, source normalization, id-preservation idempotency, and a
// post-import freshness sweep. Provider + tool level, temp KB + temp bible.

let provider: SqliteProvider;
let tmpRepo: string;
let fleetDir: string;

beforeEach(async () => {
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-import-test-'));
  fleetDir = path.join(tmpRepo, '.fleet');
  fs.mkdirSync(fleetDir, { recursive: true });
  provider = new SqliteProvider(':memory:');
  await provider.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: provider,
    global: provider,
    projectSlug: 'test',
  } as any);
});

afterEach(() => {
  provider.close();
  vi.restoreAllMocks();
  fs.rmSync(tmpRepo, { recursive: true, force: true });
});

interface BibleEntryFixture {
  id: string;
  type: string;
  title: string;
  summary: string;
  symbols?: string[];
  source_files?: string[];
  confidence: string;
  updated_at?: string;
}

function writeBible(entries: unknown[]): string {
  const p = path.join(fleetDir, 'kb-canonical.json');
  fs.writeFileSync(p, JSON.stringify(entries, null, 2), 'utf-8');
  return p;
}

function bibleEntry(over: Partial<BibleEntryFixture> & { id: string }): BibleEntryFixture {
  return {
    type: 'learning',
    title: over.id + ' title token',
    summary: 'Summary for ' + over.id,
    symbols: [],
    source_files: [],
    confidence: 'CONFIRMED',
    updated_at: '2026-07-07T00:00:00.000Z',
    ...over,
  };
}

function rawRow(id: string): {
  stale: number;
  flagged_for_review: number;
  superseded_at: string | null;
  confidence: string;
  source: string;
  content: string;
  tags: string;
} {
  return (provider as any).getDb()
    .prepare('SELECT stale, flagged_for_review, superseded_at, confidence, source, content, tags FROM entries WHERE id = ?')
    .get(id);
}

function rowCount(): number {
  return ((provider as any).getDb().prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number }).c;
}

// A local (pre-existing) capture through the normal provider path -- INFERRED,
// non-import. Used to seed AUDN candidates.
function localInput(over: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'learning',
    title: 'local title',
    summary: 'local summary',
    content: 'local content',
    source_files: [],
    symbols: [],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'doer',
    source: 'session',
    confidence: 'INFERRED',
    ...over,
  };
}

async function fetchEntry(id: string) {
  const res = await provider.query({ ids: [id] });
  return res.results[0];
}

describe('kb_import trusted-channel import (T2.1, F4/D3)', () => {
  it('TEST 1: non-directive CONFIRMED bible entry imports as CONFIRMED with source=import; the same payload through plain capture() is clamped to INFERRED', async () => {
    const p = writeBible([
      bibleEntry({ id: 'conf-1', type: 'knowledge', symbols: ['confSym'], confidence: 'CONFIRMED' }),
    ]);

    const report = JSON.parse(await kbImport({ repo: tmpRepo, path: p }));
    expect(report.imported).toBe(1);

    const imported = rawRow('conf-1');
    expect(imported.confidence).toBe('CONFIRMED'); // clamp exemption in import mode
    expect(imported.source).toBe('import'); // trusted-channel provenance stamped

    // The SAME payload through plain capture() (one arg, no import mode -- the
    // HTTP route path) is still clamped to INFERRED.
    const { id } = await provider.capture(localInput({
      type: 'knowledge',
      title: 'plain confSym capture',
      symbols: ['plainConfSym'],
      confidence: 'CONFIRMED',
    }));
    const plain = await fetchEntry(id);
    expect(plain.confidence).toBe('INFERRED');
  });

  it('TEST 2: directive-in-bible becomes a pending proposal (UNVERIFIED + flagged + directive:pending), never active, and is not surfaced by default retrieval', async () => {
    const p = writeBible([
      bibleEntry({
        id: 'dir-1',
        type: 'user-directive',
        title: 'Always run zorptastic lint',
        summary: 'Directive smuggled in a bible',
        confidence: 'CONFIRMED',
      }),
    ]);

    await kbImport({ repo: tmpRepo, path: p });

    const row = rawRow('dir-1');
    expect(row.confidence).toBe('UNVERIFIED'); // forced by the directive gate
    expect(row.flagged_for_review).toBe(1);
    expect(JSON.parse(row.tags)).toContain('directive:pending');

    // Default retrieval must not surface a pending directive proposal.
    const q = await provider.query({ query: 'zorptastic' });
    expect(q.results.some(e => e.id === 'dir-1')).toBe(false);
  });

  it('TEST 3: idempotent -- re-import of the same bible adds nothing (id-skip carries idempotency even for a symbol-less/file-less entry)', async () => {
    const p = writeBible([
      bibleEntry({ id: 'idem-sym', symbols: ['idemSym'], source_files: ['src/idem.ts'] }),
      // Symbol-less AND file-less: AUDN can NEVER dedupe this (empty arrays), so
      // only the id-skip gate makes it idempotent (LOW-2).
      bibleEntry({ id: 'idem-bare', symbols: [], source_files: [] }),
    ]);

    const first = JSON.parse(await kbImport({ repo: tmpRepo, path: p }));
    expect(first.imported).toBe(2);
    const countAfterFirst = rowCount();

    const second = JSON.parse(await kbImport({ repo: tmpRepo, path: p }));
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(2);
    expect(rowCount()).toBe(countAfterFirst); // no new rows
  });

  it('TEST 4: AUDN routing -- duplicate skipped, refinement linked, contradiction flagged, each counted', async () => {
    // Seed pre-existing local entries the bible entries will match.
    await provider.capture(localInput({
      title: 'dupToken alpha', content: 'dup body text',
      symbols: ['dupSym'], source_files: ['src/dup.ts'],
    }));
    await provider.capture(localInput({
      title: 'refToken beta', content: 'ref original body',
      symbols: ['refSym'], source_files: ['src/ref.ts'],
    }));
    await provider.capture(localInput({
      title: 'contraToken gamma', content: 'the feature works fine',
      symbols: ['contraSym'], source_files: ['src/contra.ts'],
    }));

    const p = writeBible([
      // duplicate: same type + symbol + file overlap, synth content (=summary)
      // equals the local content -> AUDN 'none'.
      bibleEntry({ id: 'bib-dup', title: 'dupToken alpha', summary: 'dup body text', symbols: ['dupSym'], source_files: ['src/dup.ts'] }),
      // refinement: same type + symbol + file overlap, different content -> update.
      bibleEntry({ id: 'bib-ref', title: 'refToken beta', summary: 'ref refined body', symbols: ['refSym'], source_files: ['src/ref.ts'] }),
      // contradiction: symbol overlap + a contradiction keyword -> flagged.
      bibleEntry({ id: 'bib-contra', title: 'contraToken gamma', summary: 'this was wrong, the feature is broken', symbols: ['contraSym'], source_files: ['src/contra.ts'] }),
    ]);

    const report = JSON.parse(await kbImport({ repo: tmpRepo, path: p }));
    expect(report.skipped).toBe(1);     // the duplicate
    expect(report.linked).toBe(1);      // the refinement
    expect(report.flagged).toBe(1);     // the contradiction
    expect(report.imported).toBe(0);
  });

  it('TEST 5: id preservation -- a fresh bible id is preserved; an id whose content AUDN-matches an existing entry is resolved under a fresh id (never the bible id)', async () => {
    // (a) fresh entry: bible id preserved.
    // (b) content collision: bible entry AUDN-updates a seeded local; the new
    //     row gets a fresh random id, and the bible id is NOT used (preferredId
    //     applies only on the pure 'add' path).
    await provider.capture(localInput({
      title: 'collToken', content: 'coll original body',
      symbols: ['collSym'], source_files: ['src/coll.ts'],
    }));

    const p = writeBible([
      bibleEntry({ id: 'keep-me-1', symbols: ['keepSym'] }),
      bibleEntry({ id: 'bib-coll', title: 'collToken', summary: 'coll refined body', symbols: ['collSym'], source_files: ['src/coll.ts'] }),
    ]);

    const report = JSON.parse(await kbImport({ repo: tmpRepo, path: p }));

    expect(provider.hasEntry('keep-me-1')).toBe(true);   // fresh id preserved
    expect(provider.hasEntry('bib-coll')).toBe(false);   // update minted a fresh id
    expect(report.imported).toBe(1);   // keep-me-1
    expect(report.linked).toBe(1);     // the collision
  });

  it('TEST 6: post-import sweep stales entries whose basis no longer matches the merged worktree', async () => {
    // Recompute-at-capture semantics: a freshly imported entry hashes the CURRENT
    // worktree at capture, so it matches and stays fresh. The post-import sweep's
    // job (D3) is to retire "wrong-branch claims" -- pre-existing entries whose
    // files the merge changed. We prove that here.
    const fileX = path.join(tmpRepo, 'tracked.ts');
    fs.writeFileSync(fileX, 'export const v = 1; // branch A');

    // Pre-existing (branch A) entry with a basis over the branch-A file.
    const { id: aId } = await provider.capture(localInput({
      title: 'branchA tracked claim', content: 'A claim',
      symbols: ['branchASym'], source_files: [fileX],
    }));
    // Sanity: it starts fresh.
    expect(rawRow(aId).stale).toBe(0);

    // The merge changed the file.
    fs.writeFileSync(fileX, 'export const v = 2; // merged');

    // Import a branch-B bible entry over the same (now-merged) file.
    const p = writeBible([
      bibleEntry({ id: 'branchB-1', title: 'branchB tracked claim', summary: 'B claim', symbols: ['branchBSym'], source_files: [fileX] }),
    ]);
    const report = JSON.parse(await kbImport({ repo: tmpRepo, path: p }));

    expect(report.sweep.staled).toBeGreaterThanOrEqual(1);
    expect(rawRow(aId).stale).toBe(1);            // branch-A wrong-branch claim retired
    expect(rawRow('branchB-1').stale).toBe(0);    // imported entry matches the merged worktree
  });

  it('TEST 7 (MEDIUM-4): a plain one-arg capture() carrying source=import (or promotion) has its source normalized away AND its confidence clamped', async () => {
    // The HTTP route does provider.capture(JSON.parse(body)) with one argument.
    // Forged trusted-channel provenance must be scrubbed and CONFIRMED clamped.
    const { id: importForge } = await provider.capture(localInput({
      title: 'forged import provenance',
      symbols: ['forgeImportSym'],
      source: 'import',
      confidence: 'CONFIRMED',
    }));
    const a = await fetchEntry(importForge);
    expect(a.confidence).toBe('INFERRED');   // clamped
    expect(a.source).not.toBe('import');     // rewritten
    expect(a.source).toBe('unknown');

    const { id: promoForge } = await provider.capture(localInput({
      title: 'forged promotion provenance',
      symbols: ['forgePromoSym'],
      source: 'promotion',
      confidence: 'CONFIRMED',
    }));
    const b = await fetchEntry(promoForge);
    expect(b.confidence).toBe('INFERRED');
    expect(b.source).not.toBe('promotion');
    expect(b.source).toBe('unknown');
  });

  it('rejects a bible file that is not a JSON array', async () => {
    const p = path.join(fleetDir, 'kb-canonical.json');
    fs.writeFileSync(p, JSON.stringify({ not: 'an array' }), 'utf-8');
    await expect(kbImport({ repo: tmpRepo, path: p })).rejects.toThrow(/not a JSON array/);
  });

  it('rejects a missing bible file', async () => {
    await expect(kbImport({ repo: tmpRepo, path: path.join(fleetDir, 'nope.json') }))
      .rejects.toThrow(/not found/);
  });

  it('T3.1 (D4 fold-in, Phase 2 review MEDIUM yashr-d8b): the post-import sweep never mutates process-wide cwd via process.chdir', async () => {
    // Previously kb-import.ts's sweepAnchored() wrapped the sweep in
    // process.chdir(repoAnchor)/process.chdir(prevCwd) across an await -- a
    // global, process-wide mutation for the sweep's duration. freshnessSweep()
    // now takes an explicit `root` and threads it into computeFileHashBatch's
    // { cwd } option instead, so process.chdir must never be called at all,
    // even when tmpRepo (the --repo anchor) differs from the actual process
    // working directory (which it does here -- tmpRepo is a fresh mkdtemp
    // dir, unrelated to wherever the test runner's cwd happens to be).
    const chdirSpy = vi.spyOn(process, 'chdir');
    const p = writeBible([
      bibleEntry({ id: 'chdir-check-1', symbols: ['chdirCheckSym'] }),
    ]);

    await kbImport({ repo: tmpRepo, path: p });

    expect(chdirSpy).not.toHaveBeenCalled();
    chdirSpy.mockRestore();
  });

  it('tolerates and skips malformed entries individually', async () => {
    const p = writeBible([
      bibleEntry({ id: 'good-1', symbols: ['goodSym'] }),
      { id: 'bad-no-type', title: 'x', summary: 'y', confidence: 'CONFIRMED' }, // missing type
      { id: 'bad-conf', type: 'learning', title: 'x', summary: 'y', confidence: 'BOGUS' }, // bad confidence
      42, // not an object
    ]);
    const report = JSON.parse(await kbImport({ repo: tmpRepo, path: p }));
    expect(report.imported).toBe(1);
    expect(report.skipped).toBe(3);
    expect(provider.hasEntry('good-1')).toBe(true);
  });
});
