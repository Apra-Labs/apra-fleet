import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { makeAudnDecision } from '../../src/services/knowledge/audn.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntry, KBEntryInput } from '../../src/services/knowledge/types.js';

// T3.1 / D6: 'user-directive' is the highest-trust entry type. All four binding
// semantics are proven here:
//   1. clamp exemption -- captured at CONFIRMED (the SOLE exemption), stamped
//      author='user', source='user-directive';
//   2. never auto-decayed by decayConceptEntries;
//   3. only superseded by another user-directive (an agent capture flags it,
//      never retires it);
//   4. CONFIRMED confidence gives CONFIRMED-equivalent retrieval, no extra code.

function makeDirectiveInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'user-directive',
    title: 'Deploy only on Fridays',
    summary: 'Standing user instruction about deploy windows',
    content: 'The user decided we deploy only on Fridays.',
    source_files: ['src/deploy.ts'],
    symbols: ['deployWindow'],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'user',
    source: 'user-directive',
    confidence: 'CONFIRMED',
    ...overrides,
  };
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

// -- Semantic 1: clamp exemption (handler level) --

describe('D6 semantic 1: user-directive clamp exemption', () => {
  it('stores CONFIRMED at capture and stamps author=user / source=user-directive (no clamp)', async () => {
    const out = JSON.parse(await kbCapture({
      type: 'user-directive',
      title: 'Never force-push to main',
      summary: 'Standing user rule',
      content: 'The user said: never force-push to main.',
      symbols: ['gitPolicy'],
    }));

    // Not clamped -- the SOLE exemption from the D1 gate.
    expect(out.confidence_clamped).toBe(false);

    const entry = (await provider.query({ ids: [out.id] })).results[0];
    expect(entry.confidence).toBe('CONFIRMED');
    expect(entry.type).toBe('user-directive');
    expect(entry.author).toBe('user');
    expect(entry.source).toBe('user-directive');
    // No bracketed clamp note is appended for a user-directive.
    expect(entry.content).not.toContain('[confidence clamped');
  });

  it('forces CONFIRMED even when the caller passes a lower confidence hint', async () => {
    const out = JSON.parse(await kbCapture({
      type: 'user-directive',
      title: 'Always run the ASCII sweep',
      summary: 'Standing user rule',
      content: 'The user said: always run the ASCII sweep before commit.',
      symbols: ['asciiSweep'],
      confidence: 'UNVERIFIED',
    }));

    const entry = (await provider.query({ ids: [out.id] })).results[0];
    expect(entry.confidence).toBe('CONFIRMED');
  });

  it('CONTRAST: a normal knowledge capture with confidence=CONFIRMED still clamps to INFERRED', async () => {
    const out = JSON.parse(await kbCapture({
      type: 'knowledge',
      title: 'Some verified fact',
      summary: 'A knowledge entry',
      content: 'The caller tried to assert this as CONFIRMED.',
      symbols: ['someFact'],
      confidence: 'CONFIRMED',
    }));

    expect(out.confidence_clamped).toBe(true);
    const entry = (await provider.query({ ids: [out.id] })).results[0];
    expect(entry.confidence).toBe('INFERRED');
    expect(entry.content).toContain('[confidence clamped: CONFIRMED requires kb_promote]');
  });
});

// -- Semantic 4: retrieval at top rank (CONFIRMED-equivalent, no extra ranking code) --

describe('D6 semantic 4: user-directive is retrievable at top rank', () => {
  it('surfaces first via query() on a distinctive term', async () => {
    const { id } = await provider.capture(makeDirectiveInput({
      title: 'Directive quokkaTerm deploy rule',
      content: 'quokkaTerm: the user decided we deploy only on Fridays.',
      symbols: ['quokkaSymbol'],
    }));

    const res = await provider.query({ query: 'quokkaTerm' });
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results[0].id).toBe(id);
    expect(res.results[0].confidence).toBe('CONFIRMED');
  });

  it('surfaces in prime() top_entries via a hint symbol', async () => {
    const { id } = await provider.capture(makeDirectiveInput({
      title: 'Directive on wombatSymbol usage',
      symbols: ['wombatSymbol'],
    }));

    const primed = await provider.prime({ hint_symbols: ['wombatSymbol'] });
    expect(primed.top_entries.some(e => e.id === id)).toBe(true);
  });
});

// -- Semantic 2: never auto-decayed --

describe('D6 semantic 2: user-directive is never auto-decayed', () => {
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

  it('a CONFIRMED user-directive survives decay untouched', async () => {
    const { id } = await provider.capture(makeDirectiveInput({ source_files: [] }));
    const old = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
    (provider as any).getDb().prepare('UPDATE entries SET last_accessed = ? WHERE id = ?').run(old, id);

    runDecay(30);

    const entry = (await provider.query({ ids: [id] })).results[0];
    expect(entry.confidence).toBe('CONFIRMED');
  });

  it('the type guard protects a user-directive even if its confidence were INFERRED (defensive)', async () => {
    // Directly exercises the `type != 'user-directive'` clause: simulate a
    // future world where the decay confidence predicate is loosened by forcing
    // an INFERRED user-directive row. The type guard must still spare it.
    const { id } = await provider.capture(makeDirectiveInput({ source_files: [] }));
    const old = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
    (provider as any).getDb()
      .prepare("UPDATE entries SET confidence = 'INFERRED', last_accessed = ? WHERE id = ?")
      .run(old, id);

    runDecay(30);

    const entry = (await provider.query({ ids: [id] })).results[0];
    // NOT downgraded to UNVERIFIED -- the type guard held.
    expect(entry.confidence).toBe('INFERRED');
  });
});

// -- Semantic 3: only superseded by another user-directive --

describe('D6 semantic 3: supersede guard (pure makeAudnDecision)', () => {
  it('agent capture (different type), shared symbols+files, NO contradiction -> null (add), never update', () => {
    const candidate = makeCandidate();
    const newContent = 'An unrelated refinement about the deploy window schedule.';
    const input = makeInput({ content: newContent });
    const result = makeAudnDecision(input, [candidate], newContent);
    // Would be 'update' for a same-type refinement; the user-directive guard
    // (and the same-type gate) forbid it -> add.
    expect(result).toBeNull();
  });

  it('agent capture (different type) with a contradiction signal -> flagged, never supersede', () => {
    const candidate = makeCandidate();
    const newContent = 'Actually this was wrong: the deploy window is no longer Fridays.';
    const input = makeInput({ content: newContent });
    const result = makeAudnDecision(input, [candidate], newContent);
    expect(result?.decision).toBe('flagged');
    expect(result?.newEntryOverrides?.contradiction_of).toBe(candidate.id);
    expect(result?.shouldSupersede).toBeUndefined();
  });

  it('BOTH user-directives, non-contradicting refinement -> update (normal supersede applies)', () => {
    const candidate = makeCandidate();
    const newContent = 'The user decided we deploy only on Mondays per the revised schedule.';
    const input = makeDirectiveInput({ content: newContent });
    const result = makeAudnDecision(input, [candidate], newContent);
    expect(result?.decision).toBe('update');
    expect(result?.shouldSupersede).toBe(true);
  });
});

describe('D6 semantic 3: supersede guard (end-to-end via capture)', () => {
  it('an agent capture (knowledge) contradicting a user-directive flags it -- old stays live (superseded_at NULL)', async () => {
    const directive = await provider.capture(makeDirectiveInput());
    expect(directive.audn_decision).toBe('add');

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
    // The user-directive was NOT retired: still live, still CONFIRMED, flagged.
    expect(old!.superseded_at).toBeFalsy();
    expect(old!.stale).toBe(false);
    expect(old!.confidence).toBe('CONFIRMED');
    expect(old!.flagged_for_review).toBe(true);

    const flagged = all.results.find(e => e.id === agent.id);
    expect(flagged!.contradiction_of).toBe(directive.id);
  });

  it('a second user-directive DOES supersede the first (superseded_at + stale per T1.3)', async () => {
    const first = await provider.capture(makeDirectiveInput());
    expect(first.audn_decision).toBe('add');

    const second = await provider.capture(makeDirectiveInput({
      content: 'The user decided we deploy only on Mondays per the revised schedule.',
    }));
    expect(second.audn_decision).toBe('update');
    expect(second.id).not.toBe(first.id);

    const all = await provider.query({ include_superseded: true, include_stale: true });
    const old = all.results.find(e => e.id === first.id);
    expect(old!.superseded_at).toBeTruthy();
    expect(old!.stale).toBe(true);

    const fresh = all.results.find(e => e.id === second.id);
    expect(fresh!.superseded_at).toBeFalsy();
    expect(fresh!.stale).toBe(false);
  });
});
