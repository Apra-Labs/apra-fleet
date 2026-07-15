import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { makeAudnDecision } from '../../src/services/knowledge/audn.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntry, KBEntryInput } from '../../src/services/knowledge/types.js';

// F1 (D1, closes yashr-9ha): user-directive is a PROPOSE-via-MCP / ACTIVATE-via-CLI
// type. MCP has no user-vs-agent identity, so a directive captured over MCP is a
// PENDING PROPOSAL (UNVERIFIED + flagged + 'directive:pending'); it becomes an
// ACTIVE directive only when a human runs the CLI (approveDirective / addDirective).
// This suite proves the four D6 semantics through ACTIVATION:
//   1. capture is proposal-only (no clamp exemption -- UNVERIFIED, flagged, tagged);
//   2. an ACTIVE directive is never auto-decayed (an INFERRED row would decay);
//   3. an ACTIVE directive is only superseded by a human (approve-new + reject-old);
//      an agent proposal can never supersede it;
//   4. an ACTIVE directive retrieves at top rank (CONFIRMED-equivalent).
// Plus the hardening: promote() refuses directives (H1), scope forced to project
// (M1), and pending proposals are excluded from retrieval defaults but visible to
// kb_list / flagged_only (H2). The end-to-end forge-then-fail proof (both doors)
// and the promote-ladder attack live in tests/knowledge/kb-directive-gate.test.ts.

function makeActiveDirective(provider: SqliteProvider, overrides: {
  text?: string; symbols?: string[];
} = {}): Promise<KBEntry> {
  return provider.addDirective(
    overrides.text ?? 'The user decided we deploy only on Fridays.',
    overrides.symbols ?? ['deployWindow']
  );
}

function makeCandidate(overrides: Partial<KBEntry> = {}): KBEntry {
  return {
    id: 'existing-id',
    type: 'user-directive',
    title: 'Deploy only on Fridays',
    summary: 'Standing user instruction',
    content: 'The user decided we deploy only on Fridays.',
    source_files: ['src/deploy.ts'],
    symbols: ['deployWindow'],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    stale: false,
    flagged_for_review: false,
    author: 'user',
    source: 'user-directive',
    confidence: 'CONFIRMED',
    created_at: new Date().toISOString(),
    use_count: 0,
    ...overrides,
  };
}

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'Deploy only on Fridays',
    summary: 'agent note',
    content: 'Some agent-derived note.',
    source_files: ['src/deploy.ts'],
    symbols: ['deployWindow'],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'doer',
    source: 'session',
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

// -- F1: capture is proposal-only (the clamp exemption is gone) --

describe('F1: MCP capture of a user-directive is a pending proposal', () => {
  it('stores UNVERIFIED + flagged + directive:pending, NOT CONFIRMED (exemption removed)', async () => {
    const out = JSON.parse(await kbCapture({
      type: 'user-directive',
      title: 'Never force-push to main',
      summary: 'Standing user rule',
      content: 'The user said: never force-push to main.',
      symbols: ['gitPolicy'],
    }));

    // No clamp note (the request defaulted to INFERRED, not CONFIRMED), but the
    // stored proposal is UNVERIFIED regardless.
    const entry = (await provider.query({ ids: [out.id] })).results[0];
    expect(entry.confidence).toBe('UNVERIFIED');
    expect(entry.type).toBe('user-directive');
    expect(entry.flagged_for_review).toBe(true);
    expect(entry.tags).toContain('directive:pending');
  });

  it('stamps the validated role hint, NOT author=user (identity is forgeable over MCP)', async () => {
    const out = JSON.parse(await kbCapture({
      type: 'user-directive',
      title: 'Always run the ASCII sweep',
      summary: 'Standing user rule',
      content: 'Always run the ASCII sweep before commit.',
      symbols: ['asciiSweep'],
      role: 'reviewer',
    }));
    const entry = (await provider.query({ ids: [out.id] })).results[0];
    expect(entry.author).toBe('reviewer');
    expect(entry.author).not.toBe('user');
  });

  it('an absent/invalid role hint stamps author=unknown', async () => {
    const out = JSON.parse(await kbCapture({
      type: 'user-directive',
      title: 'Prefer small PRs',
      summary: 'Standing user rule',
      content: 'Prefer small PRs.',
      symbols: ['prPolicy'],
    }));
    const entry = (await provider.query({ ids: [out.id] })).results[0];
    expect(entry.author).toBe('unknown');
  });

  it('even a caller-supplied confidence=CONFIRMED cannot mint an active directive', async () => {
    const out = JSON.parse(await kbCapture({
      type: 'user-directive',
      title: 'Deploy Fridays only',
      summary: 'Standing user rule',
      content: 'Deploy Fridays only.',
      symbols: ['deployWindow'],
      confidence: 'CONFIRMED',
    }));
    const entry = (await provider.query({ ids: [out.id] })).results[0];
    expect(entry.confidence).toBe('UNVERIFIED');
  });

  it('M1: scope is forced to project even when scope=global is requested', async () => {
    const out = JSON.parse(await kbCapture({
      type: 'user-directive',
      title: 'Global rule attempt',
      summary: 'Standing user rule',
      content: 'Attempt to route a directive to the global KB.',
      symbols: ['globalRule'],
      scope: 'global',
    }));
    const entry = (await provider.query({ ids: [out.id] })).results[0];
    expect(entry.scope).toBe('project');
  });
});

// -- H2: retrieval defaults exclude pending proposals; audit surfaces them --

describe('F1/H2: pending proposals are excluded from retrieval defaults but visible to audit', () => {
  it('a pending proposal does NOT surface via query() defaults', async () => {
    const out = JSON.parse(await kbCapture({
      type: 'user-directive',
      title: 'Directive quokkaTerm rule',
      summary: 'pending proposal',
      content: 'quokkaTerm: the user decided we deploy only on Fridays.',
      symbols: ['quokkaSymbol'],
    }));
    const res = await provider.query({ query: 'quokkaTerm' });
    expect(res.results.some(e => e.id === out.id)).toBe(false);
  });

  it('a pending proposal does NOT surface in prime() top_entries', async () => {
    const out = JSON.parse(await kbCapture({
      type: 'user-directive',
      title: 'Directive on wombatSymbol usage',
      summary: 'pending proposal',
      content: 'wombat directive body',
      symbols: ['wombatSymbol'],
    }));
    const primed = await provider.prime({ hint_symbols: ['wombatSymbol'] });
    expect(primed.top_entries.some(e => e.id === out.id)).toBe(false);
  });

  it('kb_list DOES show a pending proposal (audit surface)', async () => {
    const out = JSON.parse(await kbCapture({
      type: 'user-directive',
      title: 'Directive listable pending',
      summary: 'pending proposal',
      content: 'listable directive body',
      symbols: ['listSymbol'],
    }));
    const listed = await provider.list({ type: 'user-directive' });
    expect(listed.some(e => e.id === out.id)).toBe(true);
  });

  it('flagged_only DOES surface a pending proposal (that is where a human finds it)', async () => {
    const out = JSON.parse(await kbCapture({
      type: 'user-directive',
      title: 'Directive flagged pending',
      summary: 'pending proposal',
      content: 'flagged directive body',
      symbols: ['flagSymbol'],
    }));
    const flagged = await provider.query({ flagged_only: true, include_stale: true });
    expect(flagged.results.some(e => e.id === out.id)).toBe(true);
  });
});

// -- F1 activation primitives: state transitions --

describe('F1: directive activation primitives', () => {
  it('approveDirective flips a pending proposal to an ACTIVE directive', async () => {
    const out = JSON.parse(await kbCapture({
      type: 'user-directive',
      title: 'Approve me',
      summary: 'pending proposal',
      content: 'approve directive body',
      symbols: ['approveSymbol'],
    }));

    const active = await provider.approveDirective(out.id);
    expect(active.confidence).toBe('CONFIRMED');
    expect(active.author).toBe('user');
    expect(active.flagged_for_review).toBe(false);
    expect(active.tags).not.toContain('directive:pending');
    expect(active.promoted_at).toBeTruthy();
  });

  it('rejectDirective marks superseded + stale, keeps the tag (audit trail), never deletes', async () => {
    const out = JSON.parse(await kbCapture({
      type: 'user-directive',
      title: 'Reject me',
      summary: 'pending proposal',
      content: 'reject directive body',
      symbols: ['rejectSymbol'],
    }));

    const rejected = await provider.rejectDirective(out.id);
    expect(rejected.superseded_at).toBeTruthy();
    expect(rejected.stale).toBe(true);
    expect(rejected.tags).toContain('directive:pending');

    // Not deleted -- still readable by id.
    const still = (await provider.query({ ids: [out.id] })).results[0];
    expect(still).toBeDefined();
  });

  it('addDirective creates an already-active directive', async () => {
    const active = await makeActiveDirective(provider, { text: 'Always sign commits.', symbols: ['signing'] });
    expect(active.type).toBe('user-directive');
    expect(active.confidence).toBe('CONFIRMED');
    expect(active.author).toBe('user');
    expect(active.source).toBe('user-directive');
    expect(active.promoted_at).toBeTruthy();
    expect(active.tags).not.toContain('directive:pending');
  });

  it('listDirectives returns pending + active, excludes rejected', async () => {
    const pending = JSON.parse(await kbCapture({
      type: 'user-directive', title: 'pending one', summary: 's',
      content: 'pending body', symbols: ['a'],
    }));
    const active = await makeActiveDirective(provider, { text: 'active one', symbols: ['b'] });
    const rejectedRaw = JSON.parse(await kbCapture({
      type: 'user-directive', title: 'rejected one', summary: 's',
      content: 'rejected body', symbols: ['c'],
    }));
    await provider.rejectDirective(rejectedRaw.id);

    const listed = await provider.listDirectives();
    const ids = listed.map(e => e.id);
    expect(ids).toContain(pending.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(rejectedRaw.id);
  });

  it('approveDirective errors on unknown id, double-approve, and rejected directive', async () => {
    await expect(provider.approveDirective('does-not-exist')).rejects.toThrow(/not found/i);

    const active = await makeActiveDirective(provider);
    await expect(provider.approveDirective(active.id)).rejects.toThrow(/already active/i);

    const pending = JSON.parse(await kbCapture({
      type: 'user-directive', title: 'to reject', summary: 's',
      content: 'body', symbols: ['x'],
    }));
    await provider.rejectDirective(pending.id);
    await expect(provider.approveDirective(pending.id)).rejects.toThrow(/rejected/i);
  });
});

// -- H1: promote() refuses user-directive entries --

describe('F1/H1: promote() refuses user-directive entries (promote-ladder gate)', () => {
  it('refuses a pending proposal with an error naming the CLI', async () => {
    const out = JSON.parse(await kbCapture({
      type: 'user-directive', title: 'no promote', summary: 's',
      content: 'body', symbols: ['np'],
    }));
    await expect(provider.promote(out.id)).rejects.toThrow(/approve-directive/);
    // still inactive
    const entry = (await provider.query({ ids: [out.id] })).results[0];
    expect(entry.confidence).toBe('UNVERIFIED');
  });

  it('refuses an ACTIVE directive too (never climbs, never no-ops silently)', async () => {
    const active = await makeActiveDirective(provider);
    await expect(provider.promote(active.id)).rejects.toThrow(/approve-directive/);
  });
});

// -- Semantic 4: ACTIVE directive retrieves at top rank --

describe('D6 semantic 4: an ACTIVE directive retrieves at top rank', () => {
  it('surfaces first via query() on a distinctive term', async () => {
    const active = await provider.addDirective(
      'quokkaTerm: the user decided we deploy only on Fridays.',
      ['quokkaSymbol']
    );
    const res = await provider.query({ query: 'quokkaTerm' });
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0].id).toBe(active.id);
    expect(res.results[0].confidence).toBe('CONFIRMED');
  });

  it('surfaces in prime() top_entries via a hint symbol', async () => {
    const active = await provider.addDirective('Directive on wombatSymbol usage', ['wombatSymbol']);
    const primed = await provider.prime({ hint_symbols: ['wombatSymbol'] });
    expect(primed.top_entries.some(e => e.id === active.id)).toBe(true);
  });
});

// -- Semantic 2: never auto-decayed (L2 wording) --

describe('D6 semantic 2: an ACTIVE directive is never auto-decayed', () => {
  function runDecay(days: number): void {
    (provider as any).decayConceptEntries((provider as any).getDb(), days);
  }

  it('CONTROL: an old INFERRED concept entry IS downgraded to UNVERIFIED', async () => {
    const { id } = await provider.capture(makeInput({
      type: 'knowledge',
      title: 'A decayable concept',
      content: 'concept-level, no file link',
      source_files: [],
      confidence: 'INFERRED',
    }));
    const old = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
    (provider as any).getDb().prepare('UPDATE entries SET last_accessed = ? WHERE id = ?').run(old, id);

    runDecay(30);

    const entry = (await provider.query({ ids: [id] })).results[0];
    expect(entry.confidence).toBe('UNVERIFIED');
  });

  it('an ACTIVE (CONFIRMED) directive survives decay untouched', async () => {
    const active = await makeActiveDirective(provider, { symbols: ['deployWindow'] });
    const old = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
    (provider as any).getDb().prepare('UPDATE entries SET last_accessed = ?, promoted_at = ? WHERE id = ?').run(old, old, active.id);

    runDecay(30);

    const entry = (await provider.query({ ids: [active.id] })).results[0];
    expect(entry.confidence).toBe('CONFIRMED');
  });

  it('L2 pair: an INFERRED user-directive row decays while a CONFIRMED one never does', async () => {
    // ACTIVE (CONFIRMED) -- must survive.
    const active = await makeActiveDirective(provider, { symbols: ['deployWindow'] });
    // Hypothetical INFERRED user-directive row -- the confidence half of the
    // rekeyed guard means this DOES decay (it is not an ACTIVE directive).
    const infId = (await makeActiveDirective(provider, { text: 'inferred directive body', symbols: ['inf'] })).id;
    const old = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
    const db = (provider as any).getDb();
    db.prepare("UPDATE entries SET confidence = 'INFERRED', last_accessed = ?, promoted_at = ? WHERE id = ?").run(old, old, infId);
    db.prepare('UPDATE entries SET last_accessed = ?, promoted_at = ? WHERE id = ?').run(old, old, active.id);

    runDecay(30);

    expect((await provider.query({ ids: [active.id] })).results[0].confidence).toBe('CONFIRMED');
    expect((await provider.query({ ids: [infId] })).results[0].confidence).toBe('UNVERIFIED');
  });
});

// -- Semantic 3: supersede guard protects ACTIVE, not pending --

describe('D6 semantic 3: supersede guard (pure makeAudnDecision)', () => {
  it('agent capture (different type), shared symbols+files, NO contradiction -> null (add), never update', () => {
    const candidate = makeCandidate();
    const newContent = 'An unrelated refinement about the deploy window schedule.';
    const input = makeInput({ content: newContent });
    const result = makeAudnDecision(input, [candidate], newContent);
    expect(result).toBeNull();
  });

  it('agent capture (different type) with a contradiction signal -> flagged, never supersede', () => {
    const candidate = makeCandidate();
    const newContent = 'Actually this was wrong: the deploy window is no longer Fridays.';
    const input = makeInput({ content: newContent });
    const result = makeAudnDecision(input, [candidate], newContent);
    expect(result?.decision).toBe('flagged');
    expect(result?.newEntryOverrides?.contradiction_of).toBe(candidate.id);
  });

  it('a directive PROPOSAL (UNVERIFIED user-directive) can NOT supersede an ACTIVE directive', () => {
    const activeCandidate = makeCandidate({ confidence: 'CONFIRMED' });
    const newContent = 'The user decided we deploy only on Mondays per the revised schedule.';
    // Incoming is a proposal: same type but UNVERIFIED (as capture() forces).
    const input = makeInput({ type: 'user-directive', confidence: 'UNVERIFIED', content: newContent });
    const result = makeAudnDecision(input, [activeCandidate], newContent);
    // Guard trips (candidate is an ACTIVE directive) -> falls through to add.
    expect(result).toBeNull();
  });
});

describe('D6 semantic 3: supersede flow (end-to-end via capture + CLI)', () => {
  it('an agent capture contradicting an ACTIVE directive flags it -- old stays live, CONFIRMED', async () => {
    const directive = await makeActiveDirective(provider);

    const agent = await provider.capture(makeInput({
      type: 'knowledge',
      title: 'Deploy only on Fridays',
      content: 'Actually this was wrong: the deploy window is no longer Fridays, it is broken.',
    }));

    expect(agent.audn_decision).toBe('flagged');
    expect(agent.id).not.toBe(directive.id);

    const all = await provider.query({ include_superseded: true, include_stale: true });
    const old = all.results.find(e => e.id === directive.id);
    expect(old).toBeDefined();
    expect(old!.superseded_at).toBeFalsy();
    expect(old!.confidence).toBe('CONFIRMED');
    expect(old!.flagged_for_review).toBe(true);

    const flagged = all.results.find(e => e.id === agent.id);
    expect(flagged!.contradiction_of).toBe(directive.id);
  });

  it('superseding an old directive is the human approve-new + reject-old flow (resolution 2)', async () => {
    const first = await makeActiveDirective(provider, { text: 'Deploy only on Fridays.', symbols: ['deployWindow'] });
    // Human adds a new active directive and rejects the outdated one.
    const second = await makeActiveDirective(provider, { text: 'Deploy only on Mondays now.', symbols: ['deployWindow'] });
    await provider.rejectDirective(first.id);

    const all = await provider.query({ include_superseded: true, include_stale: true });
    const oldRow = all.results.find(e => e.id === first.id);
    expect(oldRow!.superseded_at).toBeTruthy();
    expect(oldRow!.stale).toBe(true);

    const newRow = all.results.find(e => e.id === second.id);
    expect(newRow!.superseded_at).toBeFalsy();
    expect(newRow!.stale).toBe(false);
    expect(newRow!.confidence).toBe('CONFIRMED');
  });
});
