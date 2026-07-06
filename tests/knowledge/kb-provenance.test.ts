import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import { kbHarvest } from '../../src/tools/kb-harvest.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import * as kbServiceModule from '../../src/services/knowledge/kb-service.js';

// T2.3 / D5 (+ revised D7 harvest provenance): provenance enums stamped by the
// tool layer, never a free string from the caller.

let provider: SqliteProvider;

beforeEach(async () => {
  provider = new SqliteProvider(':memory:');
  await provider.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: provider,
    global: provider,
    projectSlug: 'test',
  } as any);
  vi.spyOn(kbServiceModule, 'getKBService').mockReturnValue({
    getProvider: () => provider,
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

describe('kb_capture provenance stamping (T2.3 / D5)', () => {
  it('a valid role hint stamps the validated Author enum value as author', async () => {
    const out = JSON.parse(await kbCapture({
      type: 'learning',
      title: 'Provenance test: valid role',
      summary: 'Captured with a valid role hint',
      content: 'A doer captured this.',
      symbols: ['provenanceSymbolA'],
      role: 'doer',
    }));

    const entry = await fetchEntry(out.id);
    expect(entry.author).toBe('doer');
    expect(entry.source).toBe('session');
  });

  it('an invalid role hint stamps author=unknown (never the free string)', async () => {
    const out = JSON.parse(await kbCapture({
      type: 'learning',
      title: 'Provenance test: invalid role',
      summary: 'Captured with a bogus role hint',
      content: 'Someone captured this with a made-up role.',
      symbols: ['provenanceSymbolB'],
      role: 'totally-not-a-real-role',
    }));

    const entry = await fetchEntry(out.id);
    expect(entry.author).toBe('unknown');
  });

  it('an absent role hint stamps author=unknown', async () => {
    const out = JSON.parse(await kbCapture({
      type: 'learning',
      title: 'Provenance test: absent role',
      summary: 'Captured with no role hint',
      content: 'No role was supplied.',
      symbols: ['provenanceSymbolC'],
    }));

    const entry = await fetchEntry(out.id);
    expect(entry.author).toBe('unknown');
    expect(entry.source).toBe('session');
  });

  it('role=reviewer stamps source=review', async () => {
    const out = JSON.parse(await kbCapture({
      type: 'learning',
      title: 'Provenance test: reviewer role',
      summary: 'Captured by a reviewer',
      content: 'A reviewer captured this.',
      symbols: ['provenanceSymbolD'],
      role: 'reviewer',
    }));

    const entry = await fetchEntry(out.id);
    expect(entry.author).toBe('reviewer');
    expect(entry.source).toBe('review');
  });
});

describe('kb_promote provenance stamping (T2.3 / D5)', () => {
  it('promote() stamps source=promotion on the promoted row', async () => {
    const { id } = await provider.capture({
      type: 'learning',
      title: 'Promotable provenance entry',
      summary: 'Starts as a session capture',
      content: 'Some content to promote.',
      source_files: [],
      symbols: ['promoSymbol'],
      tags: [],
      content_hash: '',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      author: 'doer',
      source: 'session',
      confidence: 'UNVERIFIED',
    });

    await provider.promote(id);
    const afterFirst = await fetchEntry(id);
    expect(afterFirst.source).toBe('promotion');

    await provider.promote(id);
    const afterSecond = await fetchEntry(id);
    expect(afterSecond.confidence).toBe('CONFIRMED');
    expect(afterSecond.source).toBe('promotion');
  });
});

describe('kb_harvest provenance (revised D7)', () => {
  it('a harvested entry is stamped author=harvest and source=harvest', async () => {
    const transcript = 'Note: The harvested provenance module always tags entries distinctly from real captures.';

    const result = JSON.parse(await kbHarvest({ session_transcript: transcript }));
    expect(result.entries_captured).toBeGreaterThanOrEqual(1);

    const rows = await provider.query({ query: 'harvested', include_stale: true });
    const harvested = rows.results.find(e => e.author === 'harvest');
    expect(harvested).toBeDefined();
    expect(harvested!.source).toBe('harvest');
    expect(harvested!.confidence).toBe('UNVERIFIED');
  });
});

describe('legacy provenance values still parse (D5 tolerant reads, no migration)', () => {
  it('a row inserted with legacy author/source values reads back without error', async () => {
    const { id } = await provider.capture({
      type: 'learning',
      title: 'Legacy provenance row',
      summary: 'Simulates a pre-T2.3 row',
      content: 'Legacy content.',
      source_files: [],
      symbols: ['legacySymbol'],
      tags: [],
      content_hash: '',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      author: 'Knowledge Agent',
      source: 'kb_agent_harvest',
      confidence: 'INFERRED',
    });

    const entry = await fetchEntry(id);
    expect(entry.author).toBe('Knowledge Agent');
    expect(entry.source).toBe('kb_agent_harvest');
  });
});
