import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { SqliteProvider, USAGE_WINDOW_DAYS } from '../../src/services/knowledge/sqlite-provider.js';
import { kbStats } from '../../src/tools/kb-stats.js';
import { kbUsage, kbUsageSchema } from '../../src/tools/kb-usage.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// Server-side KB usage telemetry: kb_usage records pushed (returned) and cited
// events, kb_stats.usage reports them over the last 30 days, and a read made
// by an engine-origin session (origin=engine) is not a delivery -- it bumps no
// use_count and records no returned event, while an agent kb_query still does.

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'Default title',
    summary: 'Default summary',
    content: 'Default content body.',
    source_files: ['src/default.ts'],
    symbols: ['defaultSymbol'],
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

const DAY_MS = 24 * 60 * 60 * 1000;

let provider: SqliteProvider;
let tmpDir: string;

beforeEach(async () => {
  provider = new SqliteProvider(':memory:');
  await provider.init();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-usage-test-'));
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: provider,
    global: provider,
    projectSlug: 'test',
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  provider.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function useCountOf(id: string): Promise<number> {
  const rows = await provider.list({ confidence: ['CONFIRMED', 'INFERRED', 'UNVERIFIED'] });
  const row = rows.find(r => r.id === id);
  if (!row) throw new Error(`no row ${id}`);
  return row.use_count;
}

describe('kb_usage + kb_stats.usage: cited / returned over the last 30 days', () => {
  it('N pushed and M cited ids reported through kb_usage come back as returned N, cited M, rate M/N', async () => {
    const a = await provider.capture(makeInput({ title: 'Alpha usage entry', symbols: ['alphaSym'], source_files: ['src/a.ts'] }));
    const b = await provider.capture(makeInput({ title: 'Beta usage entry', symbols: ['betaSym'], source_files: ['src/b.ts'] }));
    const c = await provider.capture(makeInput({ title: 'Gamma usage entry', symbols: ['gammaSym'], source_files: ['src/c.ts'] }));
    // A pushed bible id with no local row still counts as delivered.
    const pushed = [a.id, b.id, c.id, 'bible-only-id-from-another-clone'];
    const cited = [a.id, c.id];

    const res = JSON.parse(await kbUsage({ pushed, cited }, { folder: tmpDir }));
    expect(res).toEqual({ recorded: { returned: 4, cited: 2 } });

    const stats = JSON.parse(await kbStats({}, { folder: tmpDir }));
    expect(stats.usage).toEqual({ window_days: 30, returned: 4, cited: 2, cited_rate: 0.5 });
    // Existing fields keep their meaning: kb_usage is not a query/touch, so it
    // bumped no use_count and retrieval is untouched.
    expect(stats.retrieval).toEqual({ entries_retrieved: 0, total_uses: 0, hit_rate: 0 });
    expect(await useCountOf(a.id)).toBe(0);
  });

  it('events older than 30 days are excluded; an in-window event at the edge still counts', async () => {
    const now = Date.now();
    provider.recordUsage({ pushed: ['old-1', 'old-2', 'old-3'], cited: ['old-1', 'old-2'] }, new Date(now - 31 * DAY_MS).toISOString());
    provider.recordUsage({ pushed: ['recent-1', 'recent-2'], cited: ['recent-1'] }, new Date(now - 29 * DAY_MS).toISOString());

    expect(USAGE_WINDOW_DAYS).toBe(30);
    expect(provider.usageStats()).toEqual({ window_days: 30, returned: 2, cited: 1, cited_rate: 0.5 });
    const stats = JSON.parse(await kbStats({}, { folder: tmpDir }));
    expect(stats.usage).toEqual({ window_days: 30, returned: 2, cited: 1, cited_rate: 0.5 });
  });

  it('no returned events in the window: cited_rate is null, never 0 or a division error', async () => {
    expect(provider.usageStats()).toEqual({ window_days: 30, returned: 0, cited: 0, cited_rate: null });
    provider.recordUsage({ cited: ['x'] });
    expect(provider.usageStats()).toEqual({ window_days: 30, returned: 0, cited: 1, cited_rate: null });
  });

  it('duplicates within one list count once; an empty call records nothing', async () => {
    const res = JSON.parse(await kbUsage({ pushed: ['p', 'p', 'q'], cited: ['p', 'p'] }, { folder: tmpDir }));
    expect(res.recorded).toEqual({ returned: 2, cited: 1 });
    expect(JSON.parse(await kbUsage({}, { folder: tmpDir })).recorded).toEqual({ returned: 0, cited: 0 });
    expect(provider.usageStats()).toMatchObject({ returned: 2, cited: 1 });
  });

  it('kbUsageSchema accepts only string id lists (optional), rejects empty ids', () => {
    expect(kbUsageSchema.safeParse({}).success).toBe(true);
    expect(kbUsageSchema.safeParse({ pushed: ['a'], cited: ['b'] }).success).toBe(true);
    expect(kbUsageSchema.safeParse({ pushed: [''] }).success).toBe(false);
    expect(kbUsageSchema.safeParse({ cited: 'a' }).success).toBe(false);
  });
});

describe('engine-origin reads are not deliveries', () => {
  it('an engine-origin kb_query bumps no use_count and records no returned event; an agent kb_query does both', async () => {
    const e = await provider.capture(makeInput({ title: 'Engine origin probe entry', summary: 'zebrafish telemetry probe', symbols: ['probeSym'] }));
    await provider.promote(e.id, 'test fixture: verified against the seeded tree');
    await provider.promote(e.id, 'test fixture: verified against the seeded tree');
    expect(await useCountOf(e.id)).toBe(0);

    // Engine-origin session (the knowledgeFor read that builds the pushed block).
    const engineRes = JSON.parse(await runWithSessionMember(undefined, () => kbQuery({ query: 'zebrafish' }, { folder: tmpDir }), { engineOrigin: true }));
    expect(engineRes.l1_results.map((r: { id: string }) => r.id)).toContain(e.id);
    expect(await useCountOf(e.id)).toBe(0);
    expect(provider.usageStats().returned).toBe(0);

    // Agent-side kb_query keeps counting.
    const agentRes = JSON.parse(await kbQuery({ query: 'zebrafish' }, { folder: tmpDir }));
    expect(agentRes.l1_results.map((r: { id: string }) => r.id)).toContain(e.id);
    const afterAgent = await useCountOf(e.id);
    expect(afterAgent).toBeGreaterThan(0);
    const returnedAfterAgent = provider.usageStats().returned;
    expect(returnedAfterAgent).toBeGreaterThan(0);

    // The engine then reports what it actually pushed: counted as returned.
    await runWithSessionMember(undefined, () => kbUsage({ pushed: [e.id] }, { folder: tmpDir }), { engineOrigin: true });
    expect(provider.usageStats().returned).toBe(returnedAfterAgent + 1);
    expect(await useCountOf(e.id)).toBe(afterAgent);
  });

  it('touch() and query({ids}) are no-ops for an engine-origin session', async () => {
    const e = await provider.capture(makeInput({ title: 'Touch probe entry', symbols: ['touchSym'] }));
    const bumped = await runWithSessionMember(undefined, () => provider.touch([e.id]), { engineOrigin: true });
    expect(bumped).toBe(0);
    await runWithSessionMember(undefined, () => provider.query({ ids: [e.id] }), { engineOrigin: true });
    expect(await useCountOf(e.id)).toBe(0);
    expect(provider.usageStats().returned).toBe(0);

    expect(await provider.touch([e.id])).toBe(1);
    await provider.query({ ids: [e.id] });
    expect(await useCountOf(e.id)).toBe(2);
    expect(provider.usageStats().returned).toBe(2);
  });
});
