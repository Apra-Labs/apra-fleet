import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbQuery, kbQuerySchema } from '../../src/tools/kb-query.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntry, KBEntryInput } from '../../src/services/knowledge/types.js';

// kb_query's opt-in retrieval-trust filters: `confidence` (tier allow-list) and
// `exclude_disputed` (drop either side of an unresolved contradiction). The
// sprint engine asks for CONFIRMED-only, non-disputed knowledge; the property
// under test is that the restriction holds for EVERY entry the response
// carries -- direct hits, L2 expansions and graph-expanded related_claims --
// and that a caller passing neither filter sees exactly the old behaviour.

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'Trustfilter base entry',
    summary: 'trustfilter summary',
    content: 'trustfilter content',
    source_files: ['src/trust/base.ts'],
    symbols: ['trustBase'],
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

// importMode is the only capture() path that keeps CONFIRMED (every other path
// clamps it to INFERRED), so it is how a test lands a CONFIRMED row directly.
async function confirmed(overrides: Partial<KBEntryInput>): Promise<string> {
  const { id } = await provider.capture(makeInput({ ...overrides, confidence: 'CONFIRMED' }), { importMode: true });
  return id;
}
async function plain(overrides: Partial<KBEntryInput>): Promise<string> {
  const { id } = await provider.capture(makeInput(overrides));
  return id;
}

let ids: Record<string, string>;

beforeEach(async () => {
  provider = new SqliteProvider(':memory:');
  await provider.init();
  // Every entry matches the query "trustfilter"; distinct files/symbols keep
  // AUDN from linking or deduplicating them.
  ids = {
    confirmed: await confirmed({ title: 'Trustfilter confirmed claim', source_files: ['src/trust/a.ts'], symbols: ['trustA'] }),
    inferred: await plain({ title: 'Trustfilter inferred claim', source_files: ['src/trust/b.ts'], symbols: ['trustB'] }),
    unverified: await plain({ title: 'Trustfilter unverified claim', confidence: 'UNVERIFIED', source_files: ['src/trust/c.ts'], symbols: ['trustC'] }),
    flagged: await confirmed({ title: 'Trustfilter flagged confirmed claim', flagged_for_review: true, source_files: ['src/trust/d.ts'], symbols: ['trustD'] }),
  };
  ids.challenger = await confirmed({
    title: 'Trustfilter challenger confirmed claim',
    contradiction_of: ids.flagged,
    source_files: ['src/trust/e.ts'],
    symbols: ['trustE'],
  } as Partial<KBEntryInput>);
});

afterEach(() => {
  vi.restoreAllMocks();
  provider.close();
});

describe('SqliteProvider.query trust filters', () => {
  it('default (no filter) is unchanged: every tier and disputed entries come back', async () => {
    const r = await provider.query({ query: 'trustfilter', limit: 50 });
    const got = r.results.map(e => e.id);
    for (const id of Object.values(ids)) expect(got).toContain(id);
  });

  it('confidence allow-list drops the other tiers', async () => {
    const r = await provider.query({ query: 'trustfilter', limit: 50, confidence: ['CONFIRMED'] });
    expect(r.results.every(e => e.confidence === 'CONFIRMED')).toBe(true);
    const got = r.results.map(e => e.id);
    expect(got).toContain(ids.confirmed);
    expect(got).not.toContain(ids.inferred);
    expect(got).not.toContain(ids.unverified);
  });

  it('exclude_disputed drops both halves of a contradiction pair', async () => {
    const r = await provider.query({ query: 'trustfilter', limit: 50, exclude_disputed: true });
    const got = r.results.map(e => e.id);
    expect(got).not.toContain(ids.flagged);
    expect(got).not.toContain(ids.challenger);
    expect(got).toContain(ids.confirmed);
    expect(got).toContain(ids.inferred);
  });

  it('flagged_only ignores the filters -- listing disputed entries is its purpose', async () => {
    const r = await provider.query({ flagged_only: true, include_stale: true, exclude_disputed: true, confidence: ['INFERRED'] });
    const got = r.results.map(e => e.id);
    expect(got).toContain(ids.flagged);
    expect(got).toContain(ids.challenger);
  });
});

describe('SqliteProvider.relatedClaims trust filters', () => {
  it('without a filter a contradiction edge is traversed (unchanged)', async () => {
    const related = await provider.relatedClaims([ids.flagged]);
    expect(related.map(e => e.id)).toContain(ids.challenger);
  });

  it('exclude_disputed drops a contradiction-linked claim', async () => {
    const related = await provider.relatedClaims([ids.flagged], 5, { exclude_disputed: true });
    expect(related).toEqual([]);
  });

  it('confidence drops a refines-linked claim of another tier', async () => {
    const original = await confirmed({ title: 'Refines origin', summary: 'refinesorigin', source_files: ['src/trust/r.ts'], symbols: ['trustR'] });
    // Same type + overlapping file and symbol, different content -> AUDN links refines.
    const refinement = await plain({ title: 'Refines origin revised', summary: 'refinesorigin', content: 'a different framing', source_files: ['src/trust/r.ts'], symbols: ['trustR'] });
    expect((await provider.relatedClaims([original])).map(e => e.id)).toContain(refinement);
    expect((await provider.relatedClaims([original], 5, { confidence: ['CONFIRMED'] })).map(e => e.id)).not.toContain(refinement);
  });
});

describe('kb_query tool trust filters', () => {
  function useProvider(p: unknown) {
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
      project: p,
      global: p,
      projectSlug: 'test',
    } as any);
  }

  it('CONFIRMED-only + exclude_disputed restricts l1, l2 and related_claims alike', async () => {
    useProvider(provider);
    const parsed = JSON.parse(await kbQuery({
      query: 'trustfilter', limit: 50, expand_related: true,
      confidence: ['CONFIRMED'], exclude_disputed: true,
    }));
    const all: KBEntry[] = [...parsed.l1_results, ...parsed.l2_expanded, ...parsed.related_claims];
    expect(parsed.l1_results.map((e: KBEntry) => e.id)).toEqual([ids.confirmed]);
    for (const e of all) {
      expect(e.confidence).toBe('CONFIRMED');
      expect(e.flagged_for_review).toBe(false);
      expect(e.contradiction_of ?? null).toBeNull();
    }
  });

  it('with no filter the tool returns only CONFIRMED undisputed entries (default)', async () => {
    useProvider(provider);
    const parsed = JSON.parse(await kbQuery({ query: 'trustfilter', limit: 50 }));
    expect(parsed.l1_results.map((e: KBEntry) => e.id)).toEqual([ids.confirmed]);
  });

  it('filters even when the provider ignores the options (older remote KB server)', async () => {
    const entry = (id: string, confidence: string, extra: Partial<KBEntry> = {}) =>
      ({ id, title: id, confidence, flagged_for_review: false, content: 'c', ...extra });
    const unfiltering = {
      query: async (opts: { ids?: string[] }) => {
        const rows = [
          entry('c1', 'CONFIRMED'),
          entry('i1', 'INFERRED'),
          entry('u1', 'UNVERIFIED'),
          entry('f1', 'CONFIRMED', { flagged_for_review: true }),
          entry('x1', 'CONFIRMED', { contradiction_of: 'f1' }),
        ];
        const results = opts.ids ? rows.filter(r => opts.ids!.includes(r.id)) : rows;
        return { results, total: results.length, l1_only: false };
      },
      relatedClaims: async () => [entry('r-inferred', 'INFERRED'), entry('r-flagged', 'CONFIRMED', { flagged_for_review: true }), entry('r-ok', 'CONFIRMED')],
    };
    useProvider(unfiltering);
    const parsed = JSON.parse(await kbQuery({
      query: 'anything', expand_related: true, confidence: ['CONFIRMED'], exclude_disputed: true,
    }));
    expect(parsed.l1_results.map((e: KBEntry) => e.id)).toEqual(['c1']);
    expect(parsed.l2_expanded.map((e: KBEntry) => e.id)).toEqual(['c1']);
    expect(parsed.related_claims.map((e: KBEntry) => e.id)).toEqual(['r-ok']);
  });

  // An options-ignoring provider (older remote KB server) that DOES honour limit.
  function ignoringProvider(rows: Array<Record<string, unknown>>) {
    const calls: Array<{ limit?: number; ids?: string[] }> = [];
    return {
      calls,
      query: async (opts: { ids?: string[]; limit?: number }) => {
        calls.push({ limit: opts.limit, ids: opts.ids });
        const results = opts.ids ? rows.filter(r => opts.ids!.includes(r.id as string)) : rows.slice(0, opts.limit ?? 20);
        return { results, total: results.length, l1_only: false };
      },
      relatedClaims: async () => [],
    };
  }
  const row = (id: string, title: string, confidence: string) =>
    ({ id, title, confidence, flagged_for_review: false, content: 'c' });

  it('an excluded project entry does not shadow an admissible global entry of the same title', async () => {
    const project = ignoringProvider([row('p-inf', 'Shared title', 'INFERRED')]);
    const global = ignoringProvider([row('g-conf', 'Shared title', 'CONFIRMED')]);
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({ project, global, projectSlug: 'test' } as any);

    const parsed = JSON.parse(await kbQuery({ query: 'shared', confidence: ['CONFIRMED'] }));

    expect(parsed.l1_results.map((e: KBEntry) => e.id)).toEqual(['g-conf']);
  });

  it('a full page of excluded entries from an options-ignoring provider does not starve the result', async () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => row(`inf${i}`, `inferred ${i}`, 'INFERRED')),
      row('conf0', 'confirmed 0', 'CONFIRMED'),
      row('conf1', 'confirmed 1', 'CONFIRMED'),
    ];
    const project = ignoringProvider(rows);
    const global = ignoringProvider([]);
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({ project, global, projectSlug: 'test' } as any);

    const parsed = JSON.parse(await kbQuery({ query: 'anything', limit: 5, confidence: ['CONFIRMED'] }));

    expect(parsed.l1_results.map((e: KBEntry) => e.id)).toEqual(['conf0', 'conf1']);
    expect(project.calls.filter(c => !c.ids).map(c => c.limit)).toEqual([5, 20]);
  });

  it('a filtering provider (sqlite) is asked once -- the wider re-query never fires for it', async () => {
    const spy = vi.spyOn(provider, 'query');
    useProvider(provider);

    await kbQuery({ query: 'trustfilter', limit: 2, confidence: ['CONFIRMED'], exclude_disputed: true });

    // project + global L1 (same provider here), plus one L2 id fetch.
    expect(spy.mock.calls.filter(([o]) => !o.ids).map(([o]) => o.limit)).toEqual([2, 2]);
  });

  it('rejects an empty confidence list rather than guessing its meaning', () => {
    expect(kbQuerySchema.safeParse({ query: 'x', confidence: [] }).success).toBe(false);
    expect(kbQuerySchema.safeParse({ query: 'x', confidence: ['CONFIRMED'] }).success).toBe(true);
    expect(kbQuerySchema.safeParse({ query: 'x', confidence: ['BOGUS'] }).success).toBe(false);
  });
});
