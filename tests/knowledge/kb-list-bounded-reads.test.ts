// my-beads-db-qy8.12.2: permanent proof that the two candidate reads behind
// the D6/D7 promotion/demotion blocks stay BOUNDED as the KB grows.
//
// Why this file has to exist at all: on a small KB an unbounded read and a
// bounded one return byte-identical results, which is exactly why the
// regression shipped unnoticed. Nothing about the RESULT distinguishes them --
// only the request does. So the assertions below are on the SQL the provider
// actually issues (its text and its bound parameters) and on the behaviour of
// the new server-side `sourceFiles` filter, not on result content alone.
//
// REVERT PROOF (required by this task's acceptance criteria, and confirmed by
// actually reverting locally before this was committed -- 6 of the 13 tests
// here flip to FAIL): restore src/services/knowledge/sqlite-provider.ts and
// src/tools/kb-list.ts to their pre-my-beads-db-qy8.12.1 state and
//
//   * 'applies a bounded LIMIT in SQL even with excludeUnchangedDemotions'
//     FAILS with "expected '\n SELECT e.* FROM entries e\n ...' to match
//     /LIMIT \?/" -- the old code set applyLimitInSql=false whenever
//     excludeUnchangedDemotions was set, so the emitted SQL carried no bound
//     at all and scanned the whole matching tier.
//   * 'the SQL bound does not grow with the number of entries in the KB'
//     FAILS with "expected 'INFERRED' to be 20": with no LIMIT clause the
//     last bound parameter is the confidence filter, not a row cap.
//   * the three `sourceFiles` tests that assert the filter NARROWS the result
//     FAIL (e.g. "expected [ 'Touches transit', ...(3) ] to deeply equal
//     [ 'Touches rules' ]") -- without the filter the provider ignores the
//     option and returns every live entry. The three that assert the filter
//     does not break anything ('empty list is no filter', 'composes with the
//     other filters', 'bounds the payload when combined with a limit') pass
//     vacuously on the reverted code, by design: they are guard rails, not
//     the proof.
//   * 'source_files scopes the response server-side' FAILS ("expected 2 to be
//     1") -- that one covers the kb-list.ts half, which must forward the key
//     for any of the above to matter.
//
// The fleet-sprint half of this proof (the kb_list REQUEST arguments
// promotionCandidates/demotionCandidates send, and the entry count crossing
// the MCP boundary) lives in
// packages/apra-fleet-se/test/kb-candidate-reads-bounded.test.mjs.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbList } from '../../src/tools/kb-list.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// Mirrors DEMOTION_FILTER_OVERFETCH in src/services/knowledge/sqlite-provider.ts.
// Deliberately re-stated here rather than exported from the provider: the
// constant is an internal cost-tuning knob, and a test that imported it could
// not notice it silently changing.
const DEMOTION_FILTER_OVERFETCH = 5;

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'Registry initialization behavior',
    summary: 'How the registry init works at startup.',
    content: 'The registry initializes lazily on first access via getOrCreate().',
    source_files: ['src/services/registry.ts'],
    symbols: ['initRegistry'],
    module: 'src/services',
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

type RecordedQuery = { sql: string; params: unknown[] };

/**
 * Swap the provider's DatabaseSync handle for a recording proxy.
 *
 * list()'s cost is not observable in its RETURN value (see the file header),
 * so the only honest way to assert "this read is bounded" is to look at the
 * statement it prepares and the parameters it binds. Installed AFTER the
 * fixture rows are captured, so the recorder only ever sees the read under
 * test.
 */
function recordQueries(provider: SqliteProvider): RecordedQuery[] {
  const seen: RecordedQuery[] = [];
  const holder = provider as unknown as { db: Record<string, unknown> };
  const real = holder.db;
  holder.db = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const stmt = Reflect.get(target, prop, receiver).call(target, sql);
          return new Proxy(stmt, {
            get(st, p) {
              const value = Reflect.get(st, p);
              if (typeof value !== 'function') return value;
              if (p === 'all' || p === 'get' || p === 'run') {
                return (...params: unknown[]) => {
                  seen.push({ sql, params });
                  return value.apply(st, params);
                };
              }
              return value.bind(st);
            },
          });
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Record<string, unknown>;
  return seen;
}

/** The one statement list() issues against the `entries e` alias. */
function entriesRead(seen: RecordedQuery[]): RecordedQuery {
  const match = seen.filter(q => /FROM entries e\b/.test(q.sql));
  expect(match.length, 'expected exactly one aliased entries read from list()').toBe(1);
  return match[0];
}

let provider: SqliteProvider;

beforeEach(async () => {
  provider = new SqliteProvider(':memory:');
  await provider.init();
});

afterEach(() => {
  provider.close();
});

describe('SqliteProvider.list is bounded with excludeUnchangedDemotions (my-beads-db-qy8.12.1)', () => {
  async function seed(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await provider.capture(makeInput({ title: `Seeded entry ${i}`, symbols: [`sym${i}`] }));
    }
  }

  it('applies a bounded LIMIT in SQL even with excludeUnchangedDemotions', async () => {
    await seed(12);
    const seen = recordQueries(provider);

    await provider.list({ confidence: 'INFERRED', limit: 4, excludeUnchangedDemotions: true });

    const read = entriesRead(seen);
    // The whole defect: this clause used to be dropped entirely, turning a
    // LIMIT 4 into a full scan of the INFERRED tier.
    expect(read.sql).toMatch(/LIMIT \?/);
    expect(read.params[read.params.length - 1]).toBe(4 * DEMOTION_FILTER_OVERFETCH);
  });

  it('the SQL bound does not grow with the number of entries in the KB', async () => {
    await seed(3);
    const small = recordQueries(provider);
    await provider.list({ confidence: 'INFERRED', limit: 4, excludeUnchangedDemotions: true });
    const smallBound = entriesRead(small).params.at(-1);

    // Same call, an order of magnitude more rows behind it.
    await seed(45);
    const large = recordQueries(provider);
    await provider.list({ confidence: 'INFERRED', limit: 4, excludeUnchangedDemotions: true });
    const largeBound = entriesRead(large).params.at(-1);

    expect(largeBound).toBe(smallBound);
    expect(largeBound).toBe(4 * DEMOTION_FILTER_OVERFETCH);
  });

  it('a plain limit (no ping-pong filter) is still bound verbatim, not over-fetched', async () => {
    await seed(12);
    const seen = recordQueries(provider);

    await provider.list({ confidence: 'INFERRED', limit: 4 });

    const read = entriesRead(seen);
    expect(read.sql).toMatch(/LIMIT \?/);
    expect(read.params[read.params.length - 1]).toBe(4);
  });

  it('no limit still means no LIMIT clause -- the audit read is unchanged', async () => {
    await seed(3);
    const seen = recordQueries(provider);

    await provider.list({});

    expect(entriesRead(seen).sql).not.toMatch(/LIMIT/);
  });

  it('still honours the caller limit in the RESULT, not just in SQL', async () => {
    await seed(12);
    const entries = await provider.list({ confidence: 'INFERRED', limit: 4, excludeUnchangedDemotions: true });
    expect(entries.length).toBe(4);
  });
});

describe('SqliteProvider.list sourceFiles filter (my-beads-db-qy8.12.1)', () => {
  beforeEach(async () => {
    await provider.capture(makeInput({ title: 'Touches transit', symbols: ['a'], source_files: ['server/transit.js'] }));
    await provider.capture(makeInput({ title: 'Touches rules', symbols: ['b'], source_files: ['server/rules.js'] }));
    await provider.capture(makeInput({ title: 'Touches both', symbols: ['c'], source_files: ['server/transit.js', 'server/other.js'] }));
    await provider.capture(makeInput({ title: 'Touches neither', symbols: ['d'], source_files: ['server/unrelated.js'] }));
  });

  it('returns only entries citing the requested file', async () => {
    const entries = await provider.list({ sourceFiles: ['server/rules.js'] });
    expect(entries.map(e => e.title)).toEqual(['Touches rules']);
  });

  it('matches ANY of the requested files, not all of them', async () => {
    const entries = await provider.list({ sourceFiles: ['server/transit.js', 'server/rules.js'] });
    expect(entries.map(e => e.title).sort()).toEqual(['Touches both', 'Touches rules', 'Touches transit']);
  });

  it('matches on exact path, never a prefix or suffix of one', async () => {
    expect(await provider.list({ sourceFiles: ['transit.js'] })).toEqual([]);
    expect(await provider.list({ sourceFiles: ['server/'] })).toEqual([]);
  });

  it('an empty file list is treated as no filter, never as "match nothing"', async () => {
    // Also guards the SQL: `value IN ()` is a syntax error in SQLite, so a
    // naive implementation would throw here rather than return everything.
    const entries = await provider.list({ sourceFiles: [] });
    expect(entries.length).toBe(4);
  });

  it('composes with the other filters instead of replacing them', async () => {
    const entries = await provider.list({
      sourceFiles: ['server/transit.js', 'server/rules.js'],
      symbol: 'b',
    });
    expect(entries.map(e => e.title)).toEqual(['Touches rules']);
  });

  it('bounds the payload when combined with a limit', async () => {
    const entries = await provider.list({ sourceFiles: ['server/transit.js'], limit: 1 });
    expect(entries.length).toBe(1);
  });
});

// The filter is only useful to fleet-sprint if the TOOL forwards it: zod
// strips an unknown key silently, so a request-schema field that kbList()
// never reads would degrade back to the full-KB read with no error anywhere
// (the apra-fleet-src input-name trap).
describe('kb_list tool forwards source_files to the provider (my-beads-db-qy8.12.1)', () => {
  beforeEach(async () => {
    await provider.capture(makeInput({ title: 'Touches transit', symbols: ['a'], source_files: ['server/transit.js'] }));
    await provider.capture(makeInput({ title: 'Touches neither', symbols: ['d'], source_files: ['server/unrelated.js'] }));
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
      project: provider,
      global: provider,
      projectSlug: 'test',
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('source_files scopes the response server-side', async () => {
    const parsed = JSON.parse(await kbList({ source_files: ['server/transit.js'] }));
    expect(parsed.total).toBe(1);
    expect(parsed.results[0].title).toBe('Touches transit');
  });

  it('omitting source_files still returns the whole live set', async () => {
    const parsed = JSON.parse(await kbList({}));
    expect(parsed.total).toBe(2);
  });
});
