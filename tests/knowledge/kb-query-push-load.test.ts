import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { SqliteProvider, QUERY_EMBED_DEADLINE_MS } from '../../src/services/knowledge/sqlite-provider.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';
import { FakeEmbedder } from '../helpers/fake-embedder.js';

// The load a pushed KB block puts on a member's server: up to 6 kb_query calls
// per dispatch through the repository's maintainer. Those reads must never wait
// for a model load or download, nor for a hung embedding worker; and every path
// through query() must still record its usage.

const SITUATIONS = 6;
// capture() clamps confidence below CONFIRMED, so reads name the stored tier.
const TIER = { confidence: ['INFERRED'] as ['INFERRED'] };

function entry(overrides: Partial<KBEntryInput>): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'Default title',
    summary: 'Default summary',
    content: 'Default content body.',
    source_files: ['src/default.ts'],
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

class ControlledEmbedder extends FakeEmbedder {
  queryCalls = 0;
  constructor(private readonly stateName: string, private readonly queryAnswer: () => Promise<Float32Array | null>) {
    super('acme/encoder');
  }
  override get state(): { state: string } { return { state: this.stateName }; }
  override async embedDocuments(): Promise<Float32Array[] | null> { return new Promise(() => { /* never */ }); }
  override async embedQuery(): Promise<Float32Array | null> {
    this.queryCalls++;
    return this.queryAnswer();
  }
}

let provider: SqliteProvider;
let tmpDir: string;
let id: string;

const usageRows = (): { kind: string; source: string }[] => (provider as unknown as {
  getDb(): { prepare(sql: string): { all(): { kind: string; source: string }[] } };
}).getDb().prepare('SELECT kind, source FROM usage_events').all();

const useCount = async (): Promise<number> =>
  (await provider.list({ confidence: ['CONFIRMED', 'INFERRED', 'UNVERIFIED'] })).find(r => r.id === id)!.use_count;

const hitIds = (json: string): string[] => (JSON.parse(json).l1_results as { id: string }[]).map(r => r.id);

beforeEach(async () => {
  provider = new SqliteProvider(':memory:');
  await provider.init();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-push-load-'));
  id = (await provider.capture(entry({ title: 'Zebrafish retry budget', source_files: ['src/zebra.ts'] }))).id;
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: provider,
    global: provider,
    projectSlug: 'test',
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  provider.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('a burst of kb_query calls while the model is not ready', () => {
  it.each(['idle', 'loading', 'failed'])('state %s: all answer from keywords, none touches the embedder', async (state) => {
    const emb = new ControlledEmbedder(state, () => new Promise(() => { /* a download that never ends */ }));
    provider.attachEmbedder(() => emb);
    const results = await Promise.all(
      Array.from({ length: SITUATIONS }, () => kbQuery({ query: 'zebrafish', limit: 8, ...TIER }, { folder: tmpDir })),
    );
    for (const r of results) expect(hitIds(r)).toEqual([id]);
    expect(emb.queryCalls).toBe(0);
  });
});

describe('a hung embedding worker with a ready model', () => {
  // A remote member call gets 120 s by default; a whole burst stays far below it.
  const MAX_WAIT_MS = 30_000;
  const STEP_MS = 250;

  it('a burst answers from keywords once the deadline passes, not at the caller timeout', async () => {
    const emb = new ControlledEmbedder('ready', () => new Promise(() => { /* hung, not dead */ }));
    provider.attachEmbedder(() => emb);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = 0;
    const burst = Promise.all(Array.from({ length: SITUATIONS }, () =>
      kbQuery({ query: 'zebrafish', limit: 8, ...TIER }, { folder: tmpDir }).then((r) => { settled++; return r; }),
    ));
    // A kb_query reads the project and global KBs in turn, so one call can wait
    // on the deadline more than once. Real async work runs between the waits.
    let elapsed = 0;
    while (settled < SITUATIONS && elapsed < MAX_WAIT_MS) {
      await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(STEP_MS);
      elapsed += STEP_MS;
    }
    const results = await burst;
    expect(elapsed).toBeGreaterThanOrEqual(QUERY_EMBED_DEADLINE_MS);
    expect(elapsed).toBeLessThan(MAX_WAIT_MS);
    for (const r of results) expect(hitIds(r)).toEqual([id]);
  });

  it('an embedding that answers in time clears its timer and still ranks', async () => {
    const emb = new FakeEmbedder('acme/encoder');
    provider.attachEmbedder(() => emb);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const res = await kbQuery({ query: 'zebrafish', limit: 8, ...TIER }, { folder: tmpDir });
    expect(hitIds(res)).toEqual([id]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('usage is recorded on every query path', () => {
  // Provider-level on purpose: kb_query's L2 lookup by id bumps its own top
  // hits, which would hide a hybrid path that stopped bumping its L1 rows.
  it('a hybrid read (files anchor, no text) bumps use_count and records returned/query', async () => {
    const res = await provider.query({ anchor_files: ['src/zebra.ts'], limit: 8, l1_only: true });
    expect(res.results.map(r => r.id)).toEqual([id]);
    expect(await useCount()).toBe(1);
    expect(usageRows()).toEqual([{ kind: 'returned', source: 'query' }]);
  });

  it('a hybrid read with error_text and a ready embedder records returned/query', async () => {
    provider.attachEmbedder(() => new FakeEmbedder('acme/encoder'));
    const res = await provider.query({ query: 'zebrafish', error_text: 'retry budget exceeded', limit: 8, l1_only: true });
    expect(res.results.map(r => r.id)).toEqual([id]);
    expect(await useCount()).toBe(1);
    expect(usageRows()).toEqual([{ kind: 'returned', source: 'query' }]);
  });

  it('the same hybrid read from an engine-origin session records nothing (the push is reported by kb_usage)', async () => {
    const res = await runWithSessionMember(
      undefined,
      () => kbQuery({ files: ['src/zebra.ts'], limit: 8, ...TIER }, { folder: tmpDir }),
      { engineOrigin: true },
    );
    expect(hitIds(res)).toEqual([id]);
    expect(await useCount()).toBe(0);
    expect(usageRows()).toEqual([]);
  });
});
