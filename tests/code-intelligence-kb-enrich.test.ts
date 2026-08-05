import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock references so they are available inside vi.mock factories,
// which are hoisted above import statements. src/tools/code-intelligence-kb-
// enrich.ts calls getKbProviders() (a module-level singleton getter in
// src/services/knowledge/kb-providers.ts), so KB constraint 1 applies:
// vi.resetModules() + a dynamic import at the start of each test.
// ---------------------------------------------------------------------------
const mockQuery = vi.hoisted(() => vi.fn());
const mockGetKbProviders = vi.hoisted(() => vi.fn());

vi.mock('../src/services/knowledge/kb-providers.js', () => ({
  getKbProviders: mockGetKbProviders,
}));

function confirmedEntry(overrides: Partial<{
  title: string;
  summary: string;
  symbols: string[];
  confidence: string;
}> = {}) {
  return {
    id: 'id-1',
    type: 'knowledge',
    title: 'Some title',
    summary: 'Some summary text',
    content: '',
    source_files: [],
    symbols: ['targetSymbol'],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    stale: false,
    flagged_for_review: false,
    author: 'kb-agent',
    source: 'doer',
    confidence: 'CONFIRMED',
    created_at: new Date().toISOString(),
    use_count: 0,
    ...overrides,
  };
}

describe('enrichContextWithKb()', () => {
  beforeEach(() => {
    vi.resetModules();
    mockQuery.mockReset();
    mockGetKbProviders.mockReset();
    mockGetKbProviders.mockResolvedValue({ project: { query: mockQuery } });
  });

  it('appends a block with N=2 confirmed matching entries, truncating summaries to 120 chars', async () => {
    const longSummary = 'x'.repeat(200);
    mockQuery.mockResolvedValue({
      results: [
        confirmedEntry({ title: 'Entry One', summary: 'Short summary', symbols: ['targetSymbol'] }),
        confirmedEntry({ title: 'Entry Two', summary: longSummary, symbols: ['targetSymbol', 'other'] }),
      ],
      total: 2,
      l1_only: true,
    });

    const { enrichContextWithKb } = await import('../src/tools/code-intelligence-kb-enrich.js');
    const providerResult = { content: [{ type: 'text', text: 'context result' }] };

    const enriched = (await enrichContextWithKb('targetSymbol', providerResult)) as {
      content: { type: string; text: string }[];
    };

    expect(mockQuery).toHaveBeenCalledWith({
      query: 'targetSymbol',
      l1_only: true,
      include_stale: false,
    });
    expect(enriched.content).toHaveLength(2);
    expect(enriched.content[0]).toEqual({ type: 'text', text: 'context result' });
    const block = enriched.content[1].text;
    expect(block).toContain('[knowledge-bank] 2 confirmed entries for targetSymbol:');
    expect(block).toContain('- Entry One -- Short summary');
    expect(block).toContain(`- Entry Two -- ${longSummary.slice(0, 120)}`);
    // Truncated, not the full 200-char summary.
    expect(block).not.toContain(longSummary);
  });

  it('does not append a block when there are zero matching entries', async () => {
    mockQuery.mockResolvedValue({ results: [], total: 0, l1_only: true });

    const { enrichContextWithKb } = await import('../src/tools/code-intelligence-kb-enrich.js');
    const providerResult = { content: [{ type: 'text', text: 'context result' }] };

    const enriched = await enrichContextWithKb('targetSymbol', providerResult);

    expect(enriched).toBe(providerResult);
  });

  it('does not append a block when entries exist but their symbols do not contain the requested name', async () => {
    mockQuery.mockResolvedValue({
      results: [confirmedEntry({ symbols: ['someOtherSymbol'] })],
      total: 1,
      l1_only: true,
    });

    const { enrichContextWithKb } = await import('../src/tools/code-intelligence-kb-enrich.js');
    const providerResult = { content: [{ type: 'text', text: 'context result' }] };

    const enriched = await enrichContextWithKb('targetSymbol', providerResult);

    expect(enriched).toBe(providerResult);
  });

  it('does not append a block when the only matching entries are not CONFIRMED', async () => {
    mockQuery.mockResolvedValue({
      results: [
        confirmedEntry({ symbols: ['targetSymbol'], confidence: 'INFERRED' }),
        confirmedEntry({ symbols: ['targetSymbol'], confidence: 'UNVERIFIED' }),
      ],
      total: 2,
      l1_only: true,
    });

    const { enrichContextWithKb } = await import('../src/tools/code-intelligence-kb-enrich.js');
    const providerResult = { content: [{ type: 'text', text: 'context result' }] };

    const enriched = await enrichContextWithKb('targetSymbol', providerResult);

    expect(enriched).toBe(providerResult);
  });

  it('returns the result unchanged (never fails) when the KB service throws', async () => {
    mockGetKbProviders.mockRejectedValue(new Error('kb unavailable'));

    const { enrichContextWithKb } = await import('../src/tools/code-intelligence-kb-enrich.js');
    const providerResult = { content: [{ type: 'text', text: 'context result' }] };

    const enriched = await enrichContextWithKb('targetSymbol', providerResult);

    expect(enriched).toBe(providerResult);
  });

  it('returns the result unchanged (never fails) when project.query() throws', async () => {
    mockQuery.mockRejectedValue(new Error('db locked'));

    const { enrichContextWithKb } = await import('../src/tools/code-intelligence-kb-enrich.js');
    const providerResult = { content: [{ type: 'text', text: 'context result' }] };

    const enriched = await enrichContextWithKb('targetSymbol', providerResult);

    expect(enriched).toBe(providerResult);
  });

  it('does not enrich an error result and does not query the KB at all', async () => {
    const { enrichContextWithKb } = await import('../src/tools/code-intelligence-kb-enrich.js');
    const errorResult = { content: [{ type: 'text', text: 'offline' }], isError: true };

    const enriched = await enrichContextWithKb('targetSymbol', errorResult);

    expect(enriched).toBe(errorResult);
    expect(mockGetKbProviders).not.toHaveBeenCalled();
  });
});
