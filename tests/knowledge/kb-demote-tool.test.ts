import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import { kbDemote } from '../../src/tools/kb-demote.js';
import { AGY_ORCHESTRATOR_DENIED_TOOLS } from '../../src/providers/agy.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// Workstream B verification (my-beads-db-qy8.2.2): proves the kb_demote TOOL
// surface end to end -- a real SqliteProvider round trip, the D1 refusal over
// an HTTP-configured project (and that it writes NOTHING, not merely that it
// throws), and the tool's permission posture. The provider-level ladder/
// refusal/evidence behaviour itself (SqliteProvider.demote()) is already
// exhaustively covered by tests/knowledge/kb-demote.test.ts (workstream A,
// my-beads-db-qy8.1.2) -- this file does not repeat that coverage.
//
// Same "mock only the provider SELECTION, never the provider itself" pattern
// as tests/knowledge/kb-feedback.test.ts: getKbProviders is spied so the tool
// resolves straight to a REAL SqliteProvider(:memory:) (or a real
// HttpKbProvider wrapping a real SqliteProvider fallback), with no mock/stub
// standing in for SqliteProvider/HttpKbProvider behaviour itself.

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'kb_demote tool test entry',
    summary: 'An entry used to exercise the kb_demote tool surface',
    content: 'Some content that may later be demoted.',
    source_files: ['src/fixture.ts'],
    symbols: ['demoteToolSubject'],
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

describe('kbDemote tool (my-beads-db-qy8.2.2)', () => {
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

  it('demotes a real entry one rung and the row read back shows the new confidence and note', async () => {
    const { id } = await provider.capture(makeInput());
    await provider.promote(id, 'tool test: manually verified against the fixture file');
    const before = await provider.query({ ids: [id] });
    expect(before.results[0].confidence).toBe('CONFIRMED');

    const out = JSON.parse(
      await kbDemote({ id, reason: 'tool test: re-checked and no longer fully confident in this claim' }),
    );
    expect(out).toEqual({ id, previous_confidence: 'CONFIRMED', new_confidence: 'INFERRED' });

    const after = await provider.query({ ids: [id] });
    expect(after.results[0].confidence).toBe('INFERRED');
    expect(after.results[0].content).toContain('[Demoted: tool test: re-checked and no longer fully confident in this claim');
  });

  it('a demotion with evidence_files records the cited paths in the appended note', async () => {
    const { id } = await provider.capture(makeInput());
    const out = JSON.parse(
      await kbDemote({
        id,
        reason: 'tool test: the cited basis file no longer fully supports this claim',
        evidence_files: ['src/fixture.ts'],
      }),
    );
    expect(out.previous_confidence).toBe('INFERRED');
    expect(out.new_confidence).toBe('UNVERIFIED');

    const after = await provider.query({ ids: [id] });
    expect(after.results[0].content).toContain('evidence: src/fixture.ts');
  });

  it('unknown id surfaces as a rejected promise from the tool layer', async () => {
    await expect(
      kbDemote({ id: 'does-not-exist', reason: 'tool test: attempting to demote an id that was never captured' }),
    ).rejects.toThrow('Entry not found');
  });
});

describe('kbDemote over an HTTP-configured project (D1 refusal, my-beads-db-qy8.2.2)', () => {
  let fallback: SqliteProvider;
  let httpProvider: HttpKbProvider;

  beforeEach(async () => {
    fallback = new SqliteProvider(':memory:');
    await fallback.init();
    // Never dialed: requireSqliteProject refuses before any network call.
    httpProvider = new HttpKbProvider('http://127.0.0.1:1', 'test-token', fallback);
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
      project: httpProvider,
      global: fallback,
      projectSlug: 'test',
    } as any);
  });

  afterEach(() => {
    httpProvider.dispose();
    fallback.close();
    vi.restoreAllMocks();
  });

  it('throws the D1 refusal and writes NOTHING to the local fallback DB', async () => {
    const { id } = await fallback.capture(makeInput());
    const before = JSON.stringify((fallback as any).getDb().prepare('SELECT * FROM entries WHERE id = ?').get(id));

    await expect(
      kbDemote({ id, reason: 'tool test: should be refused before ever reaching the fallback' }),
    ).rejects.toThrow('kb_demote: this operation is not supported when the KB is backed by a remote HTTP provider');

    const after = JSON.stringify((fallback as any).getDb().prepare('SELECT * FROM entries WHERE id = ?').get(id));
    expect(after).toBe(before);
  });
});

describe('kb_demote permission posture (my-beads-db-qy8.2.2)', () => {
  it('is in AGY_ORCHESTRATOR_DENIED_TOOLS', () => {
    expect(AGY_ORCHESTRATOR_DENIED_TOOLS).toContain('kb_demote');
  });

  it('appears in no skills/fleet/profiles/*.json member profile -- the engine calls kb_demote, not a member', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const profilesDir = path.resolve(here, '..', '..', 'skills', 'fleet', 'profiles');
    const files = fs.readdirSync(profilesDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = fs.readFileSync(path.join(profilesDir, file), 'utf-8');
      expect(content.includes('kb_demote'), `${file} must not reference kb_demote`).toBe(false);
    }
  });
});
