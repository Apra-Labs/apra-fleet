import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { orJoinFtsTerms, ftsSafeTerm, makeFtsQuery } from '../../src/services/knowledge/audn.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// T2.1 / D4: shared OR-join helper, closes yashr-5n2, yashr-17i.

describe('ftsSafeTerm', () => {
  it('quotes each alphanumeric/underscore token, space-joined within a term', () => {
    expect(ftsSafeTerm('makeFtsQuery')).toBe('"makeFtsQuery"');
    expect(ftsSafeTerm('src/tools/kb-capture.ts')).toBe('"src" "tools" "kb" "capture" "ts"');
  });

  it('returns null when nothing usable remains', () => {
    expect(ftsSafeTerm('((')).toBeNull();
    expect(ftsSafeTerm('')).toBeNull();
  });
});

describe('orJoinFtsTerms', () => {
  it('OR-joins multiple sanitized terms', () => {
    expect(orJoinFtsTerms(['alpha', 'beta'])).toBe('"alpha" OR "beta"');
  });

  it('single-term behavior unchanged (no OR keyword introduced)', () => {
    expect(orJoinFtsTerms(['alpha'])).toBe('"alpha"');
  });

  it('drops terms that sanitize to nothing rather than breaking the query', () => {
    expect(orJoinFtsTerms(['((', 'goodName'])).toBe('"goodName"');
  });
});

describe('makeFtsQuery (D4 CHANGED to OR-join)', () => {
  it('OR-joins the title tokens instead of AND-joining them', () => {
    const query = makeFtsQuery('code_graph now works fixed');
    expect(query).toBe('"code_graph" OR "now" OR "works" OR "fixed"');
  });

  it('single-token title unchanged', () => {
    expect(makeFtsQuery('makeFtsQuery')).toBe('"makeFtsQuery"');
  });
});

// -- Integration: SqliteProvider.prime() multi-term retrieval --
// MUST FAIL on today's code (searchTerms.join(' ') = implicit AND), PASS after
// the OR-join fix.

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'learning',
    title: 'Placeholder title',
    summary: 'Placeholder summary',
    content: 'Placeholder content',
    source_files: [],
    symbols: [],
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
});

afterEach(() => {
  provider.close();
});

describe('SqliteProvider.prime multi-term retrieval (D4 OR-join)', () => {
  it('a prime with two hint terms returns entries containing EITHER term (today: nothing)', async () => {
    await provider.capture(makeInput({
      title: 'termAlphaOnly entry',
      summary: 'Contains only termAlphaOnly',
      content: 'This entry mentions termAlphaOnly and nothing else notable.',
      symbols: ['termAlphaOnly'],
    }));
    await provider.capture(makeInput({
      title: 'termBetaOnly entry',
      summary: 'Contains only termBetaOnly',
      content: 'This entry mentions termBetaOnly and nothing else notable.',
      symbols: ['termBetaOnly'],
    }));

    const result = await provider.prime({ hint_symbols: ['termAlphaOnly', 'termBetaOnly'] });
    const titles = result.top_entries.map(e => e.title);
    expect(titles).toContain('termAlphaOnly entry');
    expect(titles).toContain('termBetaOnly entry');
  });

  it('single-term prime behavior is unchanged (regression)', async () => {
    await provider.capture(makeInput({
      title: 'soloTermXyz entry',
      summary: 'Contains soloTermXyz',
      content: 'This entry mentions soloTermXyz.',
      symbols: ['soloTermXyz'],
    }));

    const result = await provider.prime({ hint_symbols: ['soloTermXyz'] });
    expect(result.top_entries.map(e => e.title)).toContain('soloTermXyz entry');
  });
});

// -- F2 e2e cross-type contradiction at capture() level (T1.4 + T2.1 together) --
// MUST FAIL on today's code (candidate never discovered: same-type filter +
// AND-join both block it), PASS after.

describe('F2 e2e: cross-type contradiction discovered and flagged at capture()', () => {
  it('a later cross-type "now works" entry flags an earlier "is broken" entry on shared symbols', async () => {
    const entryA = await provider.capture(makeInput({
      type: 'knowledge',
      title: 'code_graph is broken',
      summary: 'code_graph tool status',
      content: 'code_graph is broken',
      symbols: ['GitNexusProvider.graph', 'callGitNexus'],
      source_files: ['docs/code-intelligence-child-surface.md'],
    }));
    expect(entryA.audn_decision).toBe('add');

    const entryB = await provider.capture(makeInput({
      type: 'learning',
      title: 'code_graph now works, fixed via cypher CALLS',
      summary: 'code_graph tool status update',
      content: 'code_graph now works, fixed via cypher CALLS',
      symbols: ['GitNexusProvider.graph', 'callGitNexus'],
      source_files: ['src/tools/code-intelligence-gitnexus.ts'],
    }));

    expect(entryB.audn_decision).toBe('flagged');

    const rows = await provider.query({ ids: [entryB.id] });
    expect(rows.results[0].contradiction_of).toBe(entryA.id);

    const oldRows = await provider.query({ include_superseded: true });
    const old = oldRows.results.find(e => e.id === entryA.id);
    expect(old?.flagged_for_review).toBe(true);
  });
});

describe('prime() does not double-sanitize hint_symbols', () => {
  it('bulk prime with MULTIPLE hints does not inject a literal OR term', async () => {
    const provider = new SqliteProvider(':memory:');
    await provider.init();

    // Entry mentions alphaSym only. The word "or" appears in its prose.
    await provider.capture({
      type: 'knowledge',
      title: 'alphaSym behavior',
      summary: 'Describes alphaSym.',
      content: 'This alphaSym path caches results or recomputes them.',
      source_files: ['src/alpha.ts'],
      symbols: ['alphaSym'],
      tags: [],
      content_hash: '',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      author: 'test-agent',
      source: 'doer',
      confidence: 'INFERRED',
    } as KBEntryInput);

    // Entry that mentions NEITHER hint, but does contain the word "or".
    await provider.capture({
      type: 'knowledge',
      title: 'unrelated subject',
      summary: 'Mentions neither hint.',
      content: 'This unrelated path either succeeds or fails.',
      source_files: ['src/unrelated.ts'],
      symbols: ['unrelatedSym'],
      tags: [],
      content_hash: '',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      author: 'test-agent',
      source: 'doer',
      confidence: 'INFERRED',
    } as KBEntryInput);

    const r = await provider.prime({ hint_symbols: ['alphaSym', 'betaSym'] });
    const titles = r.top_entries.map(e => e.title);

    expect(titles).toContain('alphaSym behavior');
    // If "OR" leaks in as a search term, the unrelated entry matches on "or".
    expect(titles).not.toContain('unrelated subject');

    provider.close();
  });
});
