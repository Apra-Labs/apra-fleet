import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import { kbResolveContradiction } from '../../src/tools/kb-resolve-contradiction.js';
import { kbReconcilePrefilter } from '../../src/tools/kb-reconcile-prefilter.js';

// T3.1 (F5 step 3, D4 HARDENED): flaggedPairs() + resolveContradiction() +
// reconcilePrefilter(). Provider-level tests, temp dirs for real file bases,
// following the kb-freshness.test.ts / kb-flagged-pipeline.test.ts pattern
// (no module-singleton mocking needed -- these operate on a direct
// SqliteProvider instance, not the getKbProviders() cache).

let provider: SqliteProvider;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-reconcile-test-'));
  provider = new SqliteProvider(':memory:');
  await provider.init();
});

afterEach(() => {
  provider.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

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

function rawRow(id: string): {
  stale: number;
  flagged_for_review: number;
  superseded_at: string | null;
  confidence: string;
  contradiction_of: string | null;
  content_hash: string;
  content: string;
} {
  return (provider as any).getDb()
    .prepare('SELECT stale, flagged_for_review, superseded_at, confidence, contradiction_of, content_hash, content FROM entries WHERE id = ?')
    .get(id);
}

// Captures a genuine AUDN contradiction pair: the ORIGINAL (older, FTS-matched
// candidate) ends up with flagged_for_review=1; the CHALLENGER (new entry)
// ends up with contradiction_of=original.id, confidence forced UNVERIFIED,
// flagged_for_review=false. Mirrors kb-flagged-pipeline.test.ts's proven shape.
// "is fixed" is a literal CONTRADICTION_KEYWORDS entry (audn.ts), so the
// challenger's content alone is sufficient to trigger the flagged decision.
async function captureContradictionPair(
  symbol: string,
  opts: { originalFiles?: string[]; challengerFiles?: string[] } = {}
): Promise<{ originalId: string; challengerId: string }> {
  const originalOut = await provider.capture(makeInput({
    title: symbol + ' is broken report',
    summary: symbol + ' fails under load',
    content: symbol + ' is broken when called concurrently.',
    symbols: [symbol],
    source_files: opts.originalFiles ?? [],
  }));
  const challengerOut = await provider.capture(makeInput({
    title: symbol + ' is fixed report',
    summary: symbol + ' now works correctly',
    content: symbol + ' is fixed as of the latest release.',
    symbols: [symbol],
    source_files: opts.challengerFiles ?? [],
  }));
  expect(challengerOut.audn_decision).toBe('flagged');
  return { originalId: originalOut.id, challengerId: challengerOut.id };
}

describe('SqliteProvider.flaggedPairs (T3.1, D4 HARDENED liveness contract)', () => {
  it('stale-member-included: a pair with one stale side is still returned', async () => {
    const { originalId, challengerId } = await captureContradictionPair('livenessStaleSym');
    // Simulate a post-import freshness sweep staling the challenger side.
    (provider as any).getDb()
      .prepare('UPDATE entries SET stale = 1 WHERE id = ?')
      .run(challengerId);

    const pairs = await provider.flaggedPairs();
    expect(pairs.some(p => p.original.id === originalId && p.challenger.id === challengerId)).toBe(true);
  });

  it('superseded-excluded: a pair with either side superseded is not returned', async () => {
    const { originalId, challengerId } = await captureContradictionPair('livenessSupersededSym');
    (provider as any).getDb()
      .prepare("UPDATE entries SET superseded_at = ? WHERE id = ?")
      .run(new Date().toISOString(), originalId);

    const pairs = await provider.flaggedPairs();
    expect(pairs.some(p => p.challenger.id === challengerId)).toBe(false);
  });

  it('lone-downvote-never-returned: a feedback-flagged entry with no contradiction_of counterpart is never a pair', async () => {
    const { id } = await provider.capture(makeInput({
      title: 'loneDownvoteSym entry',
      symbols: ['loneDownvoteSym'],
    }));
    await provider.feedback(id, 'no longer holds', 'doer'); // flagged_for_review=1, stale=1, no contradiction_of

    const pairs = await provider.flaggedPairs();
    expect(pairs.some(p => p.original.id === id || p.challenger.id === id)).toBe(false);
  });

  it('directive-pair-excluded: a pair where the original side is an ACTIVE user-directive is never returned', async () => {
    // The AUDN contradiction check runs BEFORE the active-directive supersede
    // guard (audn.ts), so an active directive CAN be flagged as the matched
    // candidate. flaggedPairs() must still exclude the pair.
    const directive = await provider.addDirective('directiveLivenessSym must always retry twice', ['directiveLivenessSym']);
    const challengerOut = await provider.capture(makeInput({
      title: 'directiveLivenessSym is fixed report',
      content: 'directiveLivenessSym is fixed as of the latest release.',
      symbols: ['directiveLivenessSym'],
    }));

    expect(rawRow(directive.id).flagged_for_review).toBe(1); // sanity: AUDN did flag it
    expect(rawRow(challengerOut.id).contradiction_of).toBe(directive.id);

    const pairs = await provider.flaggedPairs();
    expect(pairs.some(p => p.original.id === directive.id || p.challenger.id === directive.id)).toBe(false);
  });
});

describe('SqliteProvider.resolveContradiction (T3.1, D4 HARDENED, R7 linkage refusal)', () => {
  it('refuses two existing but UNLINKED entries -- nothing written on either row', async () => {
    const { id: aId } = await provider.capture(makeInput({ title: 'unlinkedA token', symbols: ['unlinkedASym'] }));
    const { id: bId } = await provider.capture(makeInput({ title: 'unlinkedB token', symbols: ['unlinkedBSym'] }));
    const beforeA = rawRow(aId);
    const beforeB = rawRow(bId);

    await expect(provider.resolveContradiction(aId, bId, 'no real link')).rejects.toThrow(/refused/);

    expect(rawRow(aId)).toEqual(beforeA);
    expect(rawRow(bId)).toEqual(beforeB);
  });

  it('refuses a missing id', async () => {
    const { id: realId } = await provider.capture(makeInput({ title: 'missingIdReal token', symbols: ['missingIdRealSym'] }));
    await expect(provider.resolveContradiction('does-not-exist', realId, 'evidence'))
      .rejects.toThrow(/refused/);
    await expect(provider.resolveContradiction(realId, 'does-not-exist', 'evidence'))
      .rejects.toThrow(/refused/);
  });

  it('refuses a linked-but-superseded member', async () => {
    const { originalId, challengerId } = await captureContradictionPair('supersededLinkSym');
    (provider as any).getDb()
      .prepare('UPDATE entries SET superseded_at = ? WHERE id = ?')
      .run(new Date().toISOString(), challengerId);
    const beforeOriginal = rawRow(originalId);

    await expect(provider.resolveContradiction(originalId, challengerId, 'evidence'))
      .rejects.toThrow(/refused/);

    expect(rawRow(originalId)).toEqual(beforeOriginal);
  });

  it('refuses a pair involving an ACTIVE user-directive, directly (not only via the prefilter)', async () => {
    const directive = await provider.addDirective('directiveRefusalSym must always retry twice', ['directiveRefusalSym']);
    const challengerOut = await provider.capture(makeInput({
      title: 'directiveRefusalSym is fixed report',
      content: 'directiveRefusalSym is fixed as of the latest release.',
      symbols: ['directiveRefusalSym'],
    }));
    const beforeDirective = rawRow(directive.id);
    const beforeChallenger = rawRow(challengerOut.id);

    await expect(provider.resolveContradiction(directive.id, challengerOut.id, 'evidence'))
      .rejects.toThrow(/refused/);
    await expect(provider.resolveContradiction(challengerOut.id, directive.id, 'evidence'))
      .rejects.toThrow(/refused/);

    expect(rawRow(directive.id)).toEqual(beforeDirective);
    expect(rawRow(challengerOut.id)).toEqual(beforeChallenger);
  });
});

describe('SqliteProvider.resolveContradiction (T3.1, D4 HARDENED, winner-path ordering)', () => {
  it('TEST 2: downvoted winner ends CONFIRMED + flag-cleared but STILL stale (marker blocks the un-stale)', async () => {
    const { id: winnerId } = await provider.capture(makeInput({
      title: 'downvotedWinnerSym entry',
      symbols: ['downvotedWinnerSym'],
    }));
    await provider.feedback(winnerId, 'downvoted before winning the contradiction', 'doer');
    expect(rawRow(winnerId).stale).toBe(1);
    expect(rawRow(winnerId).content).toMatch(/\n\n\[feedback \d{4}-/);

    // Now make it the ORIGINAL side of a genuine pair: a challenger contradicts it.
    const challengerOut = await provider.capture(makeInput({
      title: 'downvotedWinnerSym is fixed report',
      content: 'downvotedWinnerSym is fixed as of the latest release.',
      symbols: ['downvotedWinnerSym'],
    }));
    expect(rawRow(challengerOut.id).contradiction_of).toBe(winnerId);

    await provider.resolveContradiction(winnerId, challengerOut.id, 'downvoted entry still wins the contradiction');

    const after = rawRow(winnerId);
    expect(after.confidence).toBe('CONFIRMED');
    expect(after.flagged_for_review).toBe(0);
    expect(after.stale).toBe(1); // predicate blocked by the durable feedback marker
  });

  it('TEST 3: invalidated winner stays stale after resolveContradiction', async () => {
    const filePath = path.join(tmpDir, 'invalid-winner.ts');
    fs.writeFileSync(filePath, 'export const iv = 1;');
    const { id: winnerId } = await provider.capture(makeInput({
      type: 'context-cache',
      title: 'invalidWinnerSym context entry',
      symbols: ['invalidWinnerSym'],
      source_files: [filePath],
    }));
    const inv = await provider.invalidate([filePath]);
    expect(inv.invalidated).toBeGreaterThanOrEqual(1);
    expect(rawRow(winnerId).content_hash).toBe('invalidated');

    const challengerOut = await provider.capture(makeInput({
      title: 'invalidWinnerSym is fixed report',
      content: 'invalidWinnerSym is fixed as of the latest release.',
      symbols: ['invalidWinnerSym'],
    }));
    expect(rawRow(challengerOut.id).contradiction_of).toBe(winnerId);

    await provider.resolveContradiction(winnerId, challengerOut.id, 'invalidated entry still wins the contradiction');

    const after = rawRow(winnerId);
    expect(after.confidence).toBe('CONFIRMED');
    expect(after.flagged_for_review).toBe(0);
    expect(after.stale).toBe(1); // predicate blocked by content_hash = 'invalidated'
  });

  it('TEST 7 (re-review MEDIUM-2): old-side flagged winner with matching basis ends CONFIRMED + unflagged + stale=0, and passes the list({confidence:CONFIRMED}) export filter', async () => {
    const filePath = path.join(tmpDir, 'old-side-winner.ts');
    const original = 'export const oldSide = true;';
    fs.writeFileSync(filePath, original);

    const { id: winnerId } = await provider.capture(makeInput({
      title: 'oldSideWinnerSym is broken report',
      content: 'oldSideWinnerSym is broken when called concurrently.',
      symbols: ['oldSideWinnerSym'],
      source_files: [filePath],
    }));

    // The contradiction flags the winner (flagged_for_review=1) via the
    // challenger capture below.
    const challengerOut = await provider.capture(makeInput({
      title: 'oldSideWinnerSym is fixed report',
      content: 'oldSideWinnerSym is fixed as of the latest release.',
      symbols: ['oldSideWinnerSym'],
    }));
    expect(rawRow(challengerOut.id).contradiction_of).toBe(winnerId);
    expect(rawRow(winnerId).flagged_for_review).toBe(1);

    // File changes, sweep stales the winner (flagged_for_review is already 1
    // at this point, so freshnessSweep's own un-stale direction cannot revive
    // it -- this is the state resolveContradiction must fix).
    fs.writeFileSync(filePath, 'export const oldSide = false; // changed');
    await provider.freshnessSweep();
    expect(rawRow(winnerId).stale).toBe(1);

    // File restored byte-identical: basis matches again, but the winner is
    // STILL flagged_for_review=1, so a plain freshnessSweep would not revive
    // it either -- only resolveContradiction's flag-clear-BEFORE-predicate
    // order can produce CONFIRMED + stale=0 together.
    fs.writeFileSync(filePath, original);
    await provider.freshnessSweep();
    expect(rawRow(winnerId).stale).toBe(1); // still stale: flag standing blocks plain sweep revival

    await provider.resolveContradiction(winnerId, challengerOut.id, 'oldSideWinnerSym citing the restored implementation');

    const after = rawRow(winnerId);
    expect(after.confidence).toBe('CONFIRMED');
    expect(after.flagged_for_review).toBe(0);
    expect(after.stale).toBe(0); // proves the flag-clear-before-predicate order

    const confirmedList = await provider.list({ confidence: 'CONFIRMED' });
    expect(confirmedList.some(e => e.id === winnerId)).toBe(true);

    const loser = rawRow(challengerOut.id);
    expect(loser.superseded_at).toBeTruthy();
    expect(loser.stale).toBe(1);
    expect(loser.flagged_for_review).toBe(0);
  });
});

describe('SqliteProvider.reconcilePrefilter (T3.1, D4 HARDENED, resolution R1)', () => {
  it('TEST 1 (HIGH-1): win path end-state -- mechanical hash-basis resolution promotes the matching side to CONFIRMED+stale=0, retires the other, and the winner passes the kb_export filter', async () => {
    const originalFile = path.join(tmpDir, 'prefilter-original.ts');
    const challengerFile = path.join(tmpDir, 'prefilter-challenger.ts');
    fs.writeFileSync(originalFile, 'export const original = true;');
    fs.writeFileSync(challengerFile, 'export const challenger = true;');

    const { originalId, challengerId } = await captureContradictionPair('prefilterWinSym', {
      originalFiles: [originalFile],
      challengerFiles: [challengerFile],
    });
    expect(rawRow(challengerId).confidence).toBe('UNVERIFIED'); // AUDN's contradiction-born entry

    // The merge changed the original's file (it no longer matches) while the
    // challenger's file is untouched -- the challenger (the "imported" side,
    // simulated here at provider level) is the mechanical winner.
    fs.writeFileSync(originalFile, 'export const original = false; // merged away');
    // Simulate the post-import sweep having already staled the challenger for
    // some unrelated reason (D4 liveness: stale members must still be
    // resolvable) -- prefilter must revive it as part of the winner path.
    (provider as any).getDb().prepare('UPDATE entries SET stale = 1 WHERE id = ?').run(challengerId);

    const report = await provider.reconcilePrefilter();
    expect(report.pairs).toBe(1);
    expect(report.resolved).toEqual([{ winnerId: challengerId, loserId: originalId }]);
    expect(report.left_for_agent).toHaveLength(0);
    expect(report.skipped_directive).toBe(0);

    const winner = rawRow(challengerId);
    expect(winner.confidence).toBe('CONFIRMED');
    expect(winner.flagged_for_review).toBe(0);
    expect(winner.contradiction_of).toBeNull();
    expect(winner.stale).toBe(0);
    expect(winner.content).toContain('hash-basis match on merged worktree');

    const loser = rawRow(originalId);
    expect(loser.superseded_at).toBeTruthy();
    expect(loser.stale).toBe(1);
    expect(loser.flagged_for_review).toBe(0);

    const confirmedList = await provider.list({ confidence: 'CONFIRMED' });
    expect(confirmedList.some(e => e.id === challengerId)).toBe(true);
    expect(confirmedList.some(e => e.id === originalId)).toBe(false);
  });

  it('leaves a pair alone when BOTH sides match', async () => {
    const fileA = path.join(tmpDir, 'both-match-a.ts');
    const fileB = path.join(tmpDir, 'both-match-b.ts');
    fs.writeFileSync(fileA, 'export const a = 1;');
    fs.writeFileSync(fileB, 'export const b = 1;');
    const { originalId, challengerId } = await captureContradictionPair('bothMatchSym', {
      originalFiles: [fileA],
      challengerFiles: [fileB],
    });

    const report = await provider.reconcilePrefilter();
    expect(report.resolved).toHaveLength(0);
    expect(report.left_for_agent).toEqual([{ originalId, challengerId }]);
  });

  it('leaves a pair alone when BOTH sides mismatch', async () => {
    const fileA = path.join(tmpDir, 'both-mismatch-a.ts');
    const fileB = path.join(tmpDir, 'both-mismatch-b.ts');
    fs.writeFileSync(fileA, 'export const a = 1;');
    fs.writeFileSync(fileB, 'export const b = 1;');
    const { originalId, challengerId } = await captureContradictionPair('bothMismatchSym', {
      originalFiles: [fileA],
      challengerFiles: [fileB],
    });
    fs.writeFileSync(fileA, 'export const a = 2; // changed');
    fs.writeFileSync(fileB, 'export const b = 2; // changed');

    const report = await provider.reconcilePrefilter();
    expect(report.resolved).toHaveLength(0);
    expect(report.left_for_agent).toEqual([{ originalId, challengerId }]);
  });

  it('leaves a pair alone when either side has an empty basis', async () => {
    const { originalId, challengerId } = await captureContradictionPair('emptyBasisPrefilterSym');
    // Neither side carries source_files -- both bases are empty.

    const report = await provider.reconcilePrefilter();
    expect(report.resolved).toHaveLength(0);
    expect(report.left_for_agent).toEqual([{ originalId, challengerId }]);
  });

  it('TEST 6: a directive pair is untouched by the prefilter even when the hash favors the non-directive side', async () => {
    const challengerFile = path.join(tmpDir, 'directive-prefilter.ts');
    fs.writeFileSync(challengerFile, 'export const directivePrefilter = true;');

    const directive = await provider.addDirective('directivePrefilterSym must always retry twice', ['directivePrefilterSym']);
    const challengerOut = await provider.capture(makeInput({
      title: 'directivePrefilterSym is fixed report',
      content: 'directivePrefilterSym is fixed as of the latest release.',
      symbols: ['directivePrefilterSym'],
      source_files: [challengerFile], // matches -- would "win" mechanically if touched
    }));
    expect(rawRow(challengerOut.id).contradiction_of).toBe(directive.id);

    const beforeDirective = rawRow(directive.id);
    const beforeChallenger = rawRow(challengerOut.id);

    const report = await provider.reconcilePrefilter();

    // flaggedPairs() already excludes directive pairs, so the prefilter never
    // even sees this one -- "untouched" holds trivially and completely.
    expect(report.pairs).toBe(0);
    expect(report.resolved).toHaveLength(0);
    expect(report.left_for_agent).toHaveLength(0);

    expect(rawRow(directive.id)).toEqual(beforeDirective);
    expect(rawRow(challengerOut.id)).toEqual(beforeChallenger);
  });
});

describe('kb_resolve_contradiction / kb_reconcile_prefilter tool wrappers (T3.1, R7)', () => {
  beforeEach(() => {
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
      project: provider,
      global: provider,
      projectSlug: 'test',
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('kb_resolve_contradiction round-trips a genuine pair through the provider write path', async () => {
    const { originalId, challengerId } = await captureContradictionPair('toolWrapperSym');

    const out = JSON.parse(await kbResolveContradiction({
      winnerId: originalId,
      loserId: challengerId,
      evidence: 'tool-level round trip',
    }));
    expect(out.winnerId).toBe(originalId);
    expect(out.loserId).toBe(challengerId);

    expect(rawRow(originalId).confidence).toBe('CONFIRMED');
    expect(rawRow(challengerId).superseded_at).toBeTruthy();
  });

  it('kb_resolve_contradiction propagates the linkage refusal for unlinked ids -- nothing written', async () => {
    const { id: aId } = await provider.capture(makeInput({ title: 'toolRefusalA token', symbols: ['toolRefusalASym'] }));
    const { id: bId } = await provider.capture(makeInput({ title: 'toolRefusalB token', symbols: ['toolRefusalBSym'] }));
    const before = rawRow(aId);

    await expect(kbResolveContradiction({ winnerId: aId, loserId: bId, evidence: 'no link' }))
      .rejects.toThrow(/refused/);

    expect(rawRow(aId)).toEqual(before);
  });

  it('kb_reconcile_prefilter tool returns the {pairs, resolved, left_for_agent, skipped_directive} report shape', async () => {
    await captureContradictionPair('toolPrefilterSym'); // no files -> empty basis -> left for agent

    const out = JSON.parse(await kbReconcilePrefilter({}));
    expect(out).toEqual(
      expect.objectContaining({
        pairs: expect.any(Number),
        resolved: expect.any(Array),
        left_for_agent: expect.any(Array),
        skipped_directive: expect.any(Number),
      })
    );
    expect(out.pairs).toBeGreaterThanOrEqual(1);
    expect(out.left_for_agent).toHaveLength(out.pairs);
  });
});
