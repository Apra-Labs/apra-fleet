import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import { kbFeedback } from '../../src/tools/kb-feedback.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';

// T3.7 (F11): flagged-pipeline e2e proof. Exercises the kb-review flow
// end-to-end against a real (in-memory) sqlite KB, through the actual TOOL
// layer (kb_capture, kb_feedback, kb_query) plus the provider's promote()/
// capture() primitives directly for the resolution step -- the same
// primitives kb-review.md's Step 4 describes. Uses NON-directive entries
// throughout: after T1.1's H1 gate, kb_promote refuses user-directive rows,
// and directive-pending entries are a CLI-only resolution (out of scope for
// this agent-resolvable flagged flow -- see PLAN.md T3.7 note).

let provider: SqliteProvider;

beforeEach(async () => {
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
});

async function fetchEntry(id: string) {
  const res = await provider.query({ ids: [id] });
  return res.results[0];
}

describe('kb flagged-pipeline e2e (T3.7, F11)', () => {
  it('captures a contradiction, downvotes a third entry, sees both flagged, resolves one, and flags clear appropriately', async () => {
    // --- Stage 1: capture entry A, then a contradicting entry B ---------
    // Symbol overlap (['symbolFoo']) + a word-boundary polarity signal
    // ('is broken' vs 'is fixed', T1.5) is sufficient to flag -- no file
    // overlap required (D2's cross-type/cross-file contradiction rule).
    const aOut = JSON.parse(await kbCapture({
      type: 'knowledge',
      title: 'symbolFoo is broken in module Alpha',
      summary: 'symbolFoo throws under load in module Alpha',
      content: 'symbolFoo is broken when called concurrently.',
      symbols: ['symbolFoo'],
      source_files: ['src/symbolFoo.ts'],
    }));
    expect(aOut.audn_decision).toBe('add');
    const aId = aOut.id;

    const bOut = JSON.parse(await kbCapture({
      type: 'knowledge',
      title: 'symbolFoo is fixed in module Beta',
      summary: 'symbolFoo now works correctly in module Beta',
      content: 'symbolFoo is fixed as of the latest release.',
      symbols: ['symbolFoo'],
      source_files: ['src/symbolFoo-v2.ts'],
    }));
    expect(bOut.audn_decision).toBe('flagged');
    const bId = bOut.id;

    // The OLDER entry (A, the FTS-matched candidate) carries flagged_for_review;
    // the NEW entry (B) carries contradiction_of pointing at A. Neither's
    // confidence is touched by the flag itself.
    const aAfterFlag = await fetchEntry(aId);
    const bAfterFlag = await fetchEntry(bId);
    expect(aAfterFlag.flagged_for_review).toBe(true);
    expect(bAfterFlag.contradiction_of).toBe(aId);
    expect(bAfterFlag.flagged_for_review).toBe(false);

    // --- Stage 2: kb_feedback downvotes an unrelated third entry --------
    const cOut = JSON.parse(await kbCapture({
      type: 'knowledge',
      title: 'Unrelated retry-backoff note',
      summary: 'Describes the retry backoff algorithm',
      content: 'Retries use exponential backoff with jitter.',
      symbols: ['retryBackoff'],
    }));
    const cId = cOut.id;

    const feedbackOut = JSON.parse(await kbFeedback({ id: cId, reason: 'this no longer matches the real implementation', role: 'doer' }));
    expect(feedbackOut.stale).toBe(true);
    expect(feedbackOut.flagged_for_review).toBe(true);

    // --- Stage 3: kb_query({flagged_only:true}) sees BOTH flagged items -
    // (the contradiction pair AND the feedback-downvoted entry) with full
    // content -- the tool forces include_stale:true for flagged_only so the
    // stale+flagged feedback entry is not silently dropped.
    const beforeResolution = JSON.parse(await kbQuery({ flagged_only: true }));
    const beforeIds = beforeResolution.flagged_entries.map((e: { id: string }) => e.id);
    expect(beforeIds).toContain(aId);
    expect(beforeIds).toContain(bId);
    expect(beforeIds).toContain(cId);
    expect(beforeResolution.total).toBe(3);
    for (const e of beforeResolution.flagged_entries) {
      expect(typeof e.content).toBe('string');
      expect(e.content.length).toBeGreaterThan(0);
    }

    // --- Stage 4: resolve the A/B contradiction via kb_promote + supersede
    // Promote B (the correct, "fixed" claim) up the confidence ladder.
    await provider.promote(bId, 'contradiction resolved: challenger (fixed) confirmed correct');
    const bPromotedOnce = await fetchEntry(bId);
    expect(bPromotedOnce.confidence).toBe('INFERRED');
    await provider.promote(bId, 'contradiction resolved: challenger (fixed) confirmed correct');
    const bPromotedTwice = await fetchEntry(bId);
    expect(bPromotedTwice.confidence).toBe('CONFIRMED');

    // Supersede A (the loser) via a corrective capture that names A via
    // `supersedes` (supersede is opt-in) AND that AUDN independently treats as
    // an UPDATE against A specifically: same title/symbols/source_files as
    // A, but the corrective content carries NEITHER a contradiction keyword
    // nor a polarity word, so it does not re-flag -- it dedups/updates A
    // (kb-integrity promote-then-supersede semantics, per PLAN.md T3.7 item 4).
    const correctionOut = JSON.parse(await kbCapture({
      type: 'knowledge',
      title: 'symbolFoo is broken in module Alpha',
      summary: 'symbolFoo throws under load in module Alpha',
      content: 'See the symbolFoo-v2 entry for the current status of module Alpha.',
      symbols: ['symbolFoo'],
      source_files: ['src/symbolFoo.ts'],
      supersedes: aId,
    }));
    expect(correctionOut.audn_decision).toBe('update');

    // --- Stage 5: verify the flags clear appropriately (resolution 7) ---
    const aAfterResolution = await fetchEntry(aId);
    expect(aAfterResolution.superseded_at).toBeTruthy();
    expect(aAfterResolution.stale).toBe(true);
    // flagged_for_review is NOT reset by the supersede path -- the column
    // itself stays 1, but the entry drops out of flagged_only's default view
    // below because that view excludes superseded entries.
    expect(aAfterResolution.flagged_for_review).toBe(true);

    const bAfterResolution = await fetchEntry(bId);
    expect(bAfterResolution.confidence).toBe('CONFIRMED');
    // kb_promote never clears contradiction_of -- it is a permanent audit
    // marker, not a live "still contested" flag.
    expect(bAfterResolution.contradiction_of).toBe(aId);

    const afterResolution = JSON.parse(await kbQuery({ flagged_only: true }));
    const afterIds = afterResolution.flagged_entries.map((e: { id: string }) => e.id);

    // A (superseded loser) drops out of flagged_only -- the tool forces
    // include_superseded:false, which now excludes it.
    expect(afterIds).not.toContain(aId);
    // B (promoted winner) REMAINS listed: contradiction_of is never cleared
    // by kb_promote, and B is neither stale nor superseded, so the
    // `contradiction_of IS NOT NULL` branch of the flagged_only filter still
    // matches it. This is the real, surprising behavior kb-review.md must
    // document (a promoted/kept entry is not automatically delisted).
    expect(afterIds).toContain(bId);
    // C (feedback-flagged, never resolved in this test) also remains listed.
    expect(afterIds).toContain(cId);
    expect(afterResolution.total).toBe(2);
  });
});
