import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';

// T1.1 / D1: the CONFIRMED gate. kb_capture must clamp any incoming confidence
// to a max of INFERRED; kb_promote is the ONLY path to CONFIRMED. The clamp is
// enforced server-side in the handler and made visible to the caller.

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

describe('kb_capture CONFIRMED gate (D1)', () => {
  it('clamps confidence=CONFIRMED down to INFERRED and reports confidence_clamped', async () => {
    const out = JSON.parse(await kbCapture({
      type: 'learning',
      title: 'Gate test learning',
      summary: 'A learning captured with CONFIRMED',
      content: 'The caller tried to assert this as CONFIRMED.',
      symbols: ['gateTestSymbol'],
      source_files: ['src/services/knowledge/kb-service.ts'],
      confidence: 'CONFIRMED',
    }));

    expect(out.confidence_clamped).toBe(true);

    const entry = await fetchEntry(out.id);
    expect(entry.confidence).toBe('INFERRED');
    expect(entry.content).toContain('[confidence clamped: CONFIRMED requires kb_promote]');
  });

  it('passes UNVERIFIED through unchanged (no clamp)', async () => {
    const out = JSON.parse(await kbCapture({
      type: 'learning',
      title: 'Unverified learning',
      summary: 'Captured as UNVERIFIED',
      content: 'A low-trust learning.',
      symbols: ['unverifiedSymbol'],
      confidence: 'UNVERIFIED',
    }));

    expect(out.confidence_clamped).toBe(false);
    const entry = await fetchEntry(out.id);
    expect(entry.confidence).toBe('UNVERIFIED');
  });

  it('defaults to INFERRED when confidence is omitted (no clamp)', async () => {
    const out = JSON.parse(await kbCapture({
      type: 'learning',
      title: 'Default confidence learning',
      summary: 'No confidence supplied',
      content: 'Should default to INFERRED.',
      symbols: ['defaultSymbol'],
    }));

    expect(out.confidence_clamped).toBe(false);
    const entry = await fetchEntry(out.id);
    expect(entry.confidence).toBe('INFERRED');
  });

  it('kb_promote remains the sole path to CONFIRMED (UNVERIFIED -> INFERRED -> CONFIRMED ladder)', async () => {
    const out = JSON.parse(await kbCapture({
      type: 'learning',
      title: 'Promotable learning',
      summary: 'Captured then promoted',
      content: 'Starts UNVERIFIED, climbs the ladder via promote.',
      symbols: ['ladderSymbol'],
      confidence: 'UNVERIFIED',
    }));

    const first = await provider.promote(out.id);
    expect(first.confidence_before).toBe('UNVERIFIED');
    expect(first.confidence_after).toBe('INFERRED');

    const second = await provider.promote(out.id);
    expect(second.confidence_before).toBe('INFERRED');
    expect(second.confidence_after).toBe('CONFIRMED');

    const entry = await fetchEntry(out.id);
    expect(entry.confidence).toBe('CONFIRMED');
  });
});

// T1.2 (F3, R3, KB 9462ab04): the ENFORCEMENT clamp now lives in
// SqliteProvider.capture() itself -- the single choke point the HTTP
// /api/kb/capture route also flows through (it calls provider.capture(
// JSON.parse(body)) directly, bypassing the kb_capture handler above). These
// tests drive provider.capture() directly, exactly as that route does, and
// prove the clamp is enforced at the provider regardless of route.
describe('SqliteProvider.capture CONFIRMED clamp (F3 provider enforcement)', () => {
  it('clamps a non-directive CONFIRMED capture to INFERRED (HTTP-route path)', async () => {
    // Fail-then-pass core: before T1.2 the provider stored CONFIRMED verbatim
    // (the clamp lived only in the handler), so this asserted INFERRED would
    // fail red; after T1.2 the provider itself clamps.
    const { id } = await provider.capture({
      type: 'learning',
      title: 'Provider-level CONFIRMED capture',
      summary: 'Captured straight through the provider as CONFIRMED',
      content: 'The HTTP route would mint this as CONFIRMED without the clamp.',
      source_files: [],
      symbols: ['providerClampSymbol'],
      tags: [],
      content_hash: '',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      author: 'doer',
      source: 'session',
      confidence: 'CONFIRMED',
    });

    const entry = await fetchEntry(id);
    expect(entry.confidence).toBe('INFERRED');
    expect(entry.content).toContain('[confidence clamped: CONFIRMED requires kb_promote]');
  });

  it('directive input via provider.capture stays a pending UNVERIFIED proposal (gate unchanged)', async () => {
    const { id } = await provider.capture({
      type: 'user-directive',
      title: 'Directive via provider',
      summary: 'A directive routed straight through the provider',
      content: 'Attempted active directive.',
      source_files: [],
      symbols: [],
      tags: [],
      content_hash: '',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      author: 'doer',
      source: 'user-directive',
      confidence: 'CONFIRMED',
    });

    const entry = await fetchEntry(id);
    expect(entry.confidence).toBe('UNVERIFIED');
    expect(entry.flagged_for_review).toBe(true);
    expect(entry.tags).toContain('directive:pending');
    // The general clamp must NOT double-annotate a directive (the gate handled
    // it first, so confidence was already UNVERIFIED, not CONFIRMED).
    expect(entry.content).not.toContain('[confidence clamped:');
  });

  it('promote() still mints CONFIRMED after a provider-level capture (ladder intact)', async () => {
    const { id } = await provider.capture({
      type: 'learning',
      title: 'Provider capture then promote',
      summary: 'Captured INFERRED via provider, climbs to CONFIRMED via promote',
      content: 'Ladder check.',
      source_files: [],
      symbols: ['ladderProviderSymbol'],
      tags: [],
      content_hash: '',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      author: 'doer',
      source: 'session',
      confidence: 'INFERRED',
    });

    const promoted = await provider.promote(id, 'verified against merged code');
    expect(promoted.confidence_after).toBe('CONFIRMED');
    const entry = await fetchEntry(id);
    expect(entry.confidence).toBe('CONFIRMED');
  });
});
