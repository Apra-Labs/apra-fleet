import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbFeedback } from '../../src/tools/kb-feedback.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import * as kbSelfModule from '../../src/services/knowledge/kb-self.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// T3.1 (F8, D7): kb_feedback downvote tool -- proves the never-deletes/
// never-touches-confidence contract, the active-directive flag-only
// exception, role validation, and the CONTENT_CAP truncation.

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'Feedback test entry',
    summary: 'An entry that will receive feedback',
    content: 'Some content that may later prove wrong.',
    source_files: ['src/fixture.ts'],
    symbols: ['feedbackSubject'],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'test-agent',
    source: 'doer',
    confidence: 'INFERRED',
    ...overrides,
  };
}

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

describe('SqliteProvider.feedback (T3.1, D7)', () => {
  it('normal entry: stale=1, flagged_for_review=1, note appended, confidence untouched', async () => {
    // R5 (T1.2): provider.capture() now clamps CONFIRMED -> INFERRED (the F3
    // enforcement choke point), so seed CONFIRMED via the real ladder (capture
    // INFERRED, then promote). This still proves the "downvoted CONFIRMED stays
    // CONFIRMED-but-stale-flagged" contract precisely.
    const { id } = await provider.capture(makeInput({ confidence: 'INFERRED' }));
    await provider.promote(id, 'test fixture: verified against the seeded tree');
    const before = await fetchEntry(id);
    expect(before.confidence).toBe('CONFIRMED');

    const entry = await provider.feedback(id, 'the described behavior no longer holds', 'doer');

    expect(entry.stale).toBe(true);
    expect(entry.flagged_for_review).toBe(true);
    expect(entry.confidence).toBe('CONFIRMED');
    expect(entry.content).toContain('[feedback ');
    expect(entry.content).toContain('doer: the described behavior no longer holds');
  });

  it('never deletes the entry -- it remains queryable by id', async () => {
    const { id } = await provider.capture(makeInput());
    await provider.feedback(id, 'wrong in practice', 'reviewer');
    const after = await fetchEntry(id);
    expect(after).toBeDefined();
    expect(after.id).toBe(id);
  });

  it('active user-directive: flagged only, stale left unchanged (not staled)', async () => {
    // Simulate an ACTIVE directive directly (bypassing capture()'s proposal
    // transform) via addDirective, matching how the CLI activates one.
    const active = await provider.addDirective('Always use the shared helper for X');
    expect(active.confidence).toBe('CONFIRMED');
    expect(active.stale).toBe(false);

    const entry = await provider.feedback(active.id, 'this directive conflicts with new guidance', 'doer');

    expect(entry.flagged_for_review).toBe(true);
    expect(entry.stale).toBe(false); // NOT staled -- directives outrank agent experience
    expect(entry.confidence).toBe('CONFIRMED'); // never touched
    expect(entry.content).toContain('[feedback ');
  });

  it('pending directive proposal (UNVERIFIED, not yet active): stales normally', async () => {
    const { id } = await provider.capture({
      type: 'user-directive',
      title: 'Proposed standing instruction',
      summary: 'A directive proposal, not yet approved',
      content: 'Always do X.',
      source_files: ['src/fixture.ts'],
      symbols: [],
      tags: [],
      content_hash: '',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      author: 'unknown',
      source: 'user-directive',
      confidence: 'UNVERIFIED',
    });
    const before = await provider.query({ ids: [id] });
    expect(before.results[0].confidence).toBe('UNVERIFIED'); // pending, not active

    const entry = await provider.feedback(id, 'this proposal is redundant', 'doer');

    expect(entry.stale).toBe(true); // pending proposals stale normally, unlike active directives
    expect(entry.flagged_for_review).toBe(true);
  });

  it('CONTENT_CAP is respected after appending the feedback note', async () => {
    const longContent = 'x'.repeat(3990);
    const { id } = await provider.capture(makeInput({ content: longContent }));

    const entry = await provider.feedback(id, 'this is now stale', 'doer');

    expect(entry.content.length).toBeLessThanOrEqual(4000 + '...[truncated]'.length);
  });

  it('unknown id raises an error', async () => {
    await expect(provider.feedback('does-not-exist', 'reason', 'doer')).rejects.toThrow('Entry not found');
  });
});

describe('kbFeedback tool (role validation)', () => {
  it('a valid role hint stamps the validated role in the note', async () => {
    const { id } = await provider.capture(makeInput());
    const out = JSON.parse(await kbFeedback({ id, reason: 'proved wrong', role: 'reviewer' }));
    expect(out.stale).toBe(true);
    expect(out.flagged_for_review).toBe(true);

    const entry = await fetchEntry(id);
    expect(entry.content).toContain('reviewer: proved wrong');
  });

  it('an invalid role hint stamps "unknown" in the note (never the free string)', async () => {
    const { id } = await provider.capture(makeInput());
    await kbFeedback({ id, reason: 'proved wrong', role: 'not-a-real-role' });

    const entry = await fetchEntry(id);
    expect(entry.content).toContain('unknown: proved wrong');
    expect(entry.content).not.toContain('not-a-real-role');
  });

  it('an absent role hint stamps "unknown"', async () => {
    const { id } = await provider.capture(makeInput());
    await kbFeedback({ id, reason: 'proved wrong' });

    const entry = await fetchEntry(id);
    expect(entry.content).toContain('unknown: proved wrong');
  });

  it('unknown id surfaces as a rejected promise from the tool layer too', async () => {
    await expect(kbFeedback({ id: 'nope', reason: 'x' })).rejects.toThrow('Entry not found');
  });
});

describe('kbFeedback tool (member sessions and the kb_maintainer grant)', () => {
  beforeEach(() => {
    // A member session resolves its registered work folder; stand in the per-repo DB.
    vi.spyOn(kbSelfModule, 'getSelfKbProviders').mockImplementation(async () =>
      ({ project: provider, global: provider, projectSlug: 'test' }) as any);
  });

  it('a member session WITH the kb_maintainer grant downvotes against the per-repo DB like a FULL session', async () => {
    const { id } = await provider.capture(makeInput());
    await provider.promote(id, 'test fixture: verified against the seeded tree');
    const out = JSON.parse(await runWithSessionMember('member-uuid-1', () =>
      kbFeedback({ id, reason: 'proved wrong in practice', role: 'kb-agent' }), { kbMaintainer: true }));
    expect(out.stale).toBe(true);
    expect(out.flagged_for_review).toBe(true);
    expect(out.confidence).toBe('CONFIRMED');

    const entry = await fetchEntry(id);
    expect(entry.stale).toBe(true);
    expect(entry.flagged_for_review).toBe(true);
    expect(entry.confidence).toBe('CONFIRMED');
    expect(entry.content).toContain('kb-agent: proved wrong in practice');
  });

  it('a member session WITHOUT the grant is still refused with E-MEMBER-VIEW-READ-ONLY and the row is unchanged', async () => {
    const { id } = await provider.capture(makeInput());
    const before = await fetchEntry(id);
    await expect(runWithSessionMember('member-uuid-1', () =>
      kbFeedback({ id, reason: 'proved wrong in practice' }))).rejects.toThrow('E-MEMBER-VIEW-READ-ONLY');
    const after = await fetchEntry(id);
    expect({ stale: after.stale, flagged: after.flagged_for_review, content: after.content, confidence: after.confidence })
      .toEqual({ stale: before.stale, flagged: before.flagged_for_review, content: before.content, confidence: before.confidence });
    expect(after.stale).toBe(false);
    expect(after.flagged_for_review).toBe(false);
  });
});
