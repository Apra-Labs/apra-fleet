import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbImport } from '../../src/tools/kb-import.js';
import { kbFreshnessSweep } from '../../src/tools/kb-freshness-sweep.js';
import { kbReconcilePrefilter } from '../../src/tools/kb-reconcile-prefilter.js';
import { kbExport } from '../../src/tools/kb-export.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntryInput, ContentType, Confidence } from '../../src/services/knowledge/types.js';

// T3.3 (F6/D6 e2e, HIGH-1 satisfiability proof): two-branch reconcile chain,
// provider/tool level, in a real temp git repo + temp (in-memory) KB. Follows
// T1.1's isolation discipline (never the real KB or repo bible) and the
// kb-export-autocommit.test.ts real-temp-git-repo pattern.
//
// Script: seed branch-A claims with real hash bases -> write a branch-B
// bible fixture (duplicate + refinement + two contradictions + a directive)
// -> kb_import it -> change ONE pre-existing (branch-A) file between import
// and the freshness sweep -- per the Phase 2 reviewer's guidance, the sweep
// retires PRE-EXISTING wrong-branch entries whose files the merge changed;
// a freshly imported entry hashes the CURRENT worktree at capture time, so
// it is fresh by construction and the sweep must NOT be asserted to stale it
// -- then kb_freshness_sweep -> kb_reconcile_prefilter -> kb_export.

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
}

function initTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-reconcile-e2e-'));
  git(dir, ['init', '--quiet']);
  return dir;
}

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'placeholder title token',
    summary: 'placeholder summary',
    content: 'placeholder content',
    source_files: [],
    symbols: [],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'test-agent',
    source: 'session',
    confidence: 'INFERRED',
    ...overrides,
  };
}

interface BibleEntryFixture {
  id: string;
  type: ContentType;
  title: string;
  summary: string;
  symbols?: string[];
  source_files?: string[];
  confidence: Confidence;
  updated_at?: string;
}

let provider: SqliteProvider;
let repoDir: string;
let fleetDir: string;

beforeEach(async () => {
  repoDir = initTempGitRepo();
  fleetDir = path.join(repoDir, '.fleet');
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
  fs.rmSync(repoDir, { recursive: true, force: true });
});

function writeBible(entries: BibleEntryFixture[]): string {
  const p = path.join(fleetDir, 'kb-canonical.json');
  fs.writeFileSync(p, JSON.stringify(entries, null, 2), 'utf-8');
  return p;
}

function rawRow(id: string): {
  stale: number;
  flagged_for_review: number;
  superseded_at: string | null;
  confidence: string;
  contradiction_of: string | null;
  content: string;
} {
  return (provider as any).getDb()
    .prepare('SELECT stale, flagged_for_review, superseded_at, confidence, contradiction_of, content FROM entries WHERE id = ?')
    .get(id);
}

// AUDN's 'flagged' branch (like 'update') always mints a FRESH randomUUID for
// the new/challenger row -- preferredId (the bible's own id) is honored ONLY
// on the pure 'add' path (LOW-2). So the challenger's actual stored id must
// be looked up by its contradiction_of pointer, never assumed to equal the
// bible entry's id.
function challengerIdFor(originalId: string): string {
  const row = (provider as any).getDb()
    .prepare('SELECT id FROM entries WHERE contradiction_of = ?')
    .get(originalId) as { id: string } | undefined;
  if (!row) throw new Error('no challenger found for original id ' + originalId);
  return row.id;
}

describe('kb-reconcile two-branch e2e (T3.3, F6/D6)', () => {
  it('duplicate skipped, refinement kept live alongside its predecessor, contradiction flagged, directive pending; then sweep + prefilter + export produce the reconciled bible', async () => {
    // --- Fixture files (real files in the temp git repo) -----------------
    const fileDup = path.join(repoDir, 'dup.ts');
    const fileBeta = path.join(repoDir, 'beta.ts');
    const fileGammaOld = path.join(repoDir, 'gamma-old.ts'); // branch-A's file for the contradiction
    const fileGammaNew = path.join(repoDir, 'gamma-new.ts'); // branch-B's file for the same contradiction
    fs.writeFileSync(fileDup, 'export const dup = 1;');
    fs.writeFileSync(fileBeta, 'export const beta = 1;');
    const gammaOldOriginal = 'export const gammaOld = true; // branch-A implementation';
    fs.writeFileSync(fileGammaOld, gammaOldOriginal);
    fs.writeFileSync(fileGammaNew, 'export const gammaNew = true; // branch-B implementation');

    // --- Step 1: seed branch-A claims with real hash bases ---------------
    const aDup = await provider.capture(makeInput({
      title: 'dupSym note token', summary: 'dup summary',
      content: 'dup body text exactly matching',
      symbols: ['dupSym'], source_files: [fileDup],
    }));
    const aRefine = await provider.capture(makeInput({
      title: 'refineSym note token', summary: 'refine summary',
      content: 'original beta claim',
      symbols: ['refineSym'], source_files: [fileBeta],
    }));
    const aContra = await provider.capture(makeInput({
      title: 'gammaSym is broken report', summary: 'gammaSym broken summary',
      content: 'gammaSym is broken when called concurrently.',
      symbols: ['gammaSym'], source_files: [fileGammaOld],
    }));
    const aUndecided = await provider.capture(makeInput({
      title: 'undecidedSym is broken report', summary: 'undecidedSym broken summary',
      content: 'undecidedSym is broken when called concurrently.',
      symbols: ['undecidedSym'], source_files: [],
    }));

    // --- Step 2: write the branch-B bible fixture -------------------------
    const bDup: BibleEntryFixture = {
      id: 'b-dup', type: 'knowledge', title: 'dupSym note token',
      summary: 'dup body text exactly matching', // synthesizeContent == summary; must equal A's content for AUDN 'none'
      symbols: ['dupSym'], source_files: [fileDup], confidence: 'CONFIRMED',
    };
    const bRefine: BibleEntryFixture = {
      id: 'b-refine', type: 'knowledge', title: 'refineSym note token',
      summary: 'refined beta claim', // different content -> AUDN 'update'
      symbols: ['refineSym'], source_files: [fileBeta], confidence: 'CONFIRMED',
    };
    const bContra: BibleEntryFixture = {
      id: 'b-contra', type: 'knowledge', title: 'gammaSym is fixed report',
      summary: 'gammaSym is fixed as of the latest release.', // contradiction keyword
      symbols: ['gammaSym'], source_files: [fileGammaNew], confidence: 'CONFIRMED',
    };
    const bUndecided: BibleEntryFixture = {
      id: 'b-undecided', type: 'knowledge', title: 'undecidedSym is fixed report',
      summary: 'undecidedSym is fixed as of the latest release.',
      symbols: ['undecidedSym'], source_files: [], confidence: 'CONFIRMED', // empty basis -> hash-undecidable
    };
    const bDirective: BibleEntryFixture = {
      id: 'b-directive', type: 'user-directive', title: 'Always run zorptastic lint before commit',
      summary: 'Directive smuggled in the merged bible', confidence: 'CONFIRMED',
    };
    const biblePath = writeBible([bDup, bRefine, bContra, bUndecided, bDirective]);

    // --- Step 3: kb_import it ---------------------------------------------
    const importReport = JSON.parse(await kbImport({ repo: repoDir, path: biblePath }));
    expect(importReport.skipped).toBeGreaterThanOrEqual(1); // the duplicate
    expect(importReport.superseded).toBeGreaterThanOrEqual(1); // the refinement
    expect(importReport.flagged).toBeGreaterThanOrEqual(2); // both contradictions

    // duplicate: no new row for b-dup (id-skip does not apply here -- AUDN
    // 'none' dedupes by content equality against aDup instead).
    expect(provider.hasEntry('b-dup')).toBe(false);
    expect(rawRow(aDup.id).superseded_at).toBeFalsy();

    // refinement: AUDN decides 'update' (so importReport.superseded, which
    // counts 'update' decisions, still sees it), but supersede is OPT-IN and a
    // bible cannot opt in: it is authored on another branch and cannot name
    // THIS worktree's local uuid, so no bible entry can carry `supersedes`.
    // An import refinement is therefore an ordinary refinement -- aRefine stays
    // LIVE and the fresh row (NOT the bible id, since AUDN's update path always
    // mints a random id) carries the refined claim and links 'refines' to it.
    // Retiring the predecessor is a curation act (kb-review.md Step 4), not
    // something an import infers.
    expect(rawRow(aRefine.id).superseded_at).toBeFalsy();
    expect(provider.hasEntry('b-refine')).toBe(false);

    // contradiction #1: pair asymmetry as landed -- aContra (original) is
    // flagged; the imported challenger gets a FRESH id (AUDN's 'flagged'
    // branch always mints a new randomUUID -- preferredId applies only on
    // the pure 'add' path, LOW-2) and points contradiction_of at aContra,
    // forced UNVERIFIED regardless of the bible's CONFIRMED.
    expect(rawRow(aContra.id).flagged_for_review).toBe(1);
    const bContraId = challengerIdFor(aContra.id);
    const bContraRow = rawRow(bContraId);
    expect(bContraRow.contradiction_of).toBe(aContra.id);
    expect(bContraRow.confidence).toBe('UNVERIFIED');
    expect(bContraRow.flagged_for_review).toBe(0);

    // contradiction #2 (hash-undecidable): same shape, no file basis on
    // either side.
    expect(rawRow(aUndecided.id).flagged_for_review).toBe(1);
    const bUndecidedId = challengerIdFor(aUndecided.id);
    const bUndecidedRow = rawRow(bUndecidedId);
    expect(bUndecidedRow.contradiction_of).toBe(aUndecided.id);

    // directive: pending proposal, never active, not surfaced by default query.
    const directiveRow = rawRow('b-directive');
    expect(directiveRow.confidence).toBe('UNVERIFIED');
    expect(directiveRow.flagged_for_review).toBe(1);
    const defaultQuery = await provider.query({ query: 'zorptastic' });
    expect(defaultQuery.results.some(e => e.id === 'b-directive')).toBe(false);

    // --- Step 4: change a PRE-EXISTING (branch-A) file between import and
    // the sweep -- simulates the merge changing branch-A's implementation.
    // Per the Phase 2 reviewer's guidance: the sweep retires this
    // pre-existing wrong-branch entry; the freshly imported b-contra is
    // fresh by construction (captured against fileGammaNew as it exists
    // right now) and must NOT be asserted stale by this sweep.
    fs.writeFileSync(fileGammaOld, 'export const gammaOld = false; // merge changed this');

    // --- Step 5: kb_freshness_sweep then kb_reconcile_prefilter -----------
    const sweepReport = JSON.parse(await kbFreshnessSweep({}));
    expect(sweepReport.staled).toBeGreaterThanOrEqual(1);
    expect(rawRow(aContra.id).stale).toBe(1); // pre-existing wrong-branch entry retired
    expect(rawRow(bContraId).stale).toBe(0); // fresh import untouched (not asserted stale)

    // MEDIUM-3 liveness: the contradiction pair is STILL returned by
    // flaggedPairs() despite aContra now being stale.
    const pairsBeforePrefilter = await provider.flaggedPairs();
    expect(pairsBeforePrefilter.some(p => p.original.id === aContra.id && p.challenger.id === bContraId)).toBe(true);

    const prefilterReport = JSON.parse(await kbReconcilePrefilter({}));
    expect(prefilterReport.resolved).toEqual(
      expect.arrayContaining([{ winnerId: bContraId, loserId: aContra.id }])
    );
    expect(prefilterReport.left_for_agent).toEqual(
      expect.arrayContaining([{ originalId: aUndecided.id, challengerId: bUndecidedId }])
    );

    // Winner end-state (HIGH-1): CONFIRMED, un-staled (matching basis, no
    // downvote/invalidated marker), passes the kb_export CONFIRMED filter.
    const winner = rawRow(bContraId);
    expect(winner.confidence).toBe('CONFIRMED');
    expect(winner.stale).toBe(0);
    expect(winner.flagged_for_review).toBe(0);
    expect(winner.contradiction_of).toBeNull();

    // Loser end-state: superseded, stale, flag cleared.
    const loser = rawRow(aContra.id);
    expect(loser.superseded_at).toBeTruthy();
    expect(loser.stale).toBe(1);
    expect(loser.flagged_for_review).toBe(0);

    const confirmedList = await provider.list({ confidence: 'CONFIRMED' });
    expect(confirmedList.some(e => e.id === bContraId)).toBe(true);
    expect(confirmedList.some(e => e.id === aContra.id)).toBe(false);

    // The undecidable pair's rows are untouched by the prefilter.
    expect(rawRow(aUndecided.id).flagged_for_review).toBe(1);
    expect(rawRow(aUndecided.id).superseded_at).toBeFalsy();
    expect(rawRow(bUndecidedId).contradiction_of).toBe(aUndecided.id);

    // --- Step 6: kb_export writes the reconciled bible --------------------
    const exportReport = JSON.parse(await kbExport({ repo_path: repoDir }));
    expect(exportReport.exported).toBeGreaterThanOrEqual(1);

    const canonicalPath = path.join(fleetDir, 'kb-canonical.json');
    const canonical = JSON.parse(fs.readFileSync(canonicalPath, 'utf-8')) as { id: string }[];
    const canonicalIds = canonical.map(e => e.id);

    expect(canonicalIds).toContain(bContraId);          // winner: exported
    expect(canonicalIds).not.toContain(aContra.id);      // loser: superseded, excluded
    expect(canonicalIds).not.toContain('b-directive');   // pending proposal, never CONFIRMED
  });
});
