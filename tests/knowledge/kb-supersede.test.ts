import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// Supersede is OPT-IN. symbol+file overlap is a topicality signal, not consent
// to destroy: measured 25% of real agent captures retired a DISTINCT entry.
// A caller that means to replace something passes `supersedes`. Everything else
// links and both entries stay live.

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'Registry initialization behavior',
    summary: 'How registry init works',
    content: 'The registry initializes lazily on first access via getOrCreate().',
    source_files: ['src/services/registry.ts'],
    symbols: ['initRegistry', 'getOrCreate'],
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

describe('implicit capture does NOT supersede', () => {
  it('keeps two DISTINCT facts about the same symbol+file both live', async () => {
    const perf = await provider.capture(makeInput({
      title: 'parseConfig is slow on large files',
      content: 'parseConfig does a full re-read per key; it is slow on large files.',
      source_files: ['src/config.ts'],
      symbols: ['parseConfig'],
    }));
    const crash = await provider.capture(makeInput({
      title: 'parseConfig throws on null input',
      content: 'parseConfig throws a TypeError when handed a null input buffer.',
      source_files: ['src/config.ts'],
      symbols: ['parseConfig'],
    }));

    const live = await provider.query({ limit: 50 });
    const ids = live.results.map(e => e.id);
    expect(ids).toContain(perf.id);
    expect(ids).toContain(crash.id);
  });

  it('leaves the prior entry unsuperseded and unstale', async () => {
    const first = await provider.capture(makeInput());
    const second = await provider.capture(makeInput({
      content: 'The registry now initializes eagerly at startup. Changed in v2.',
    }));
    expect(second.audn_decision).toBe('update');

    const all = await provider.query({ include_superseded: true, include_stale: true });
    const old = all.results.find(e => e.id === first.id);
    expect(old!.superseded_at).toBeFalsy();
    expect(old!.stale).toBe(false);
  });

  it('links the refinement to its predecessor', async () => {
    const first = await provider.capture(makeInput());
    const second = await provider.capture(makeInput({
      content: 'The registry now initializes eagerly at startup. Changed in v2.',
    }));

    // getLinked() does not expose link_type, and wireLinks already creates
    // shares_symbol/shares_file edges between these two. Assert the 'refines'
    // edge directly. (TS `private` is compile-time only.)
    const db = (provider as unknown as { db: import('better-sqlite3').Database }).db;
    const row = db.prepare(
      'SELECT 1 FROM links WHERE from_id = ? AND to_id = ? AND link_type = ?'
    ).get(second.id, first.id, 'refines');
    expect(row).toBeDefined();
  });
});

describe('explicit supersedes DOES supersede', () => {
  it('retires the named entry with superseded_at AND stale', async () => {
    const first = await provider.capture(makeInput());
    const second = await provider.capture(makeInput({
      content: 'The registry now initializes eagerly at startup. Changed in v2.',
      supersedes: first.id,
    }));
    expect(second.audn_decision).toBe('update');

    const all = await provider.query({ include_superseded: true, include_stale: true });
    const old = all.results.find(e => e.id === first.id);
    expect(old!.superseded_at).toBeTruthy();
    expect(old!.stale).toBe(true);
    expect(old!.content_hash).toBe('');

    const fresh = all.results.find(e => e.id === second.id);
    expect(fresh!.superseded_at).toBeFalsy();
    expect(fresh!.stale).toBe(false);
  });

  it('does NOT clear flagged_for_review on the superseded entry', async () => {
    // resolveContradiction clears the flag; this path must not. kb-review.md
    // depends on the difference.
    const first = await provider.capture(makeInput({ flagged_for_review: true }));
    const second = await provider.capture(makeInput({
      content: 'The registry now initializes eagerly at startup. Changed in v2.',
      supersedes: first.id,
    }));
    expect(second.id).not.toBe(first.id);

    const all = await provider.query({ include_superseded: true, include_stale: true });
    const old = all.results.find(e => e.id === first.id);
    expect(old!.flagged_for_review).toBe(true);
  });

  it('query() excludes the explicitly superseded entry by default', async () => {
    const first = await provider.capture(makeInput());
    const second = await provider.capture(makeInput({
      content: 'The registry now initializes eagerly at startup. Changed in v2.',
      supersedes: first.id,
    }));

    const results = await provider.query({ query: 'Registry initialization behavior' });
    const ids = results.results.map(e => e.id);
    expect(ids).not.toContain(first.id);
    expect(ids).toContain(second.id);
  });

  it('honors supersedes when the named target is NOT rank-1', async () => {
    // Two equally eligible entries (same type/symbols/source_files/title,
    // different content). AUDN's rank-ordered candidate loop may return
    // either as matchedId first; naming the SECOND explicitly must still
    // retire it, not silently no-op because it lost the bm25 race.
    const e1 = await provider.capture(makeInput({
      content: 'The registry initializes lazily on first access via getOrCreate(), variant one.',
    }));
    const e2 = await provider.capture(makeInput({
      content: 'The registry initializes lazily on first access via getOrCreate(), variant two.',
    }));

    const third = await provider.capture(makeInput({
      content: 'The registry now initializes eagerly at startup. Changed in v2.',
      supersedes: e2.id,
    }));
    expect(third.audn_decision).toBe('update');

    const all = await provider.query({ include_superseded: true, include_stale: true });
    const e1row = all.results.find(e => e.id === e1.id)!;
    const e2row = all.results.find(e => e.id === e2.id)!;
    expect(e2row.superseded_at).toBeTruthy();
    expect(e2row.stale).toBe(true);
    expect(e1row.superseded_at).toBeFalsy();
    expect(e1row.stale).toBe(false);
  });

  it('kb-review path M: two corrective captures naming different targets with the SAME merged content retire BOTH', async () => {
    const e1 = await provider.capture(makeInput({
      content: 'The registry initializes lazily on first access via getOrCreate(), variant one.',
    }));
    const e2 = await provider.capture(makeInput({
      content: 'The registry initializes lazily on first access via getOrCreate(), variant two.',
    }));

    const mergedContent = 'The registry initializes lazily via getOrCreate(); this single note merges the variant one and variant two descriptions.';
    const capture1 = await provider.capture(makeInput({ content: mergedContent, supersedes: e1.id }));
    const capture2 = await provider.capture(makeInput({ content: mergedContent, supersedes: e2.id }));
    expect(capture1.audn_decision).toBe('update');
    expect(capture2.audn_decision).toBe('update');

    const all = await provider.query({ include_superseded: true, include_stale: true });
    const e1row = all.results.find(e => e.id === e1.id)!;
    const e2row = all.results.find(e => e.id === e2.id)!;
    expect(e1row.superseded_at).toBeTruthy();
    expect(e2row.superseded_at).toBeTruthy();
  });

  it('ignores a supersedes id that is not the matched candidate', async () => {
    const first = await provider.capture(makeInput());
    const unrelated = await provider.capture(makeInput({
      title: 'Unrelated cache behavior',
      content: 'The cache evicts on a 60s TTL.',
      source_files: ['src/cache.ts'],
      symbols: ['evictCache'],
    }));
    // Names an id AUDN did not match -> must not retire anything.
    const third = await provider.capture(makeInput({
      content: 'The registry now initializes eagerly at startup. Changed in v2.',
      supersedes: unrelated.id,
    }));
    expect(third.id).not.toBe(first.id);

    const all = await provider.query({ include_superseded: true, include_stale: true });
    expect(all.results.find(e => e.id === unrelated.id)!.superseded_at).toBeFalsy();
    expect(all.results.find(e => e.id === first.id)!.superseded_at).toBeFalsy();
  });
});
