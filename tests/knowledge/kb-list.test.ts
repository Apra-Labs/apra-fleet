import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbList } from '../../src/tools/kb-list.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import { vi } from 'vitest';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'Registry initialization behavior',
    summary: 'How the registry init works at startup.',
    content: 'The registry initializes lazily on first access via getOrCreate().',
    source_files: ['src/services/registry.ts'],
    symbols: ['initRegistry', 'getOrCreate'],
    module: 'src/services',
    tags: ['registry', 'init'],
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

describe('SqliteProvider.list (T3.3, F8a)', () => {
  it('confidence filter returns only that tier', async () => {
    await provider.capture(makeInput({ confidence: 'UNVERIFIED', title: 'A', symbols: ['symA'] }));
    const { id } = await provider.capture(makeInput({ confidence: 'INFERRED', title: 'B', symbols: ['symB'] }));
    await provider.promote(id, 'test');

    const confirmed = await provider.list({ confidence: 'CONFIRMED' });
    expect(confirmed.length).toBe(1);
    expect(confirmed.every(e => e.confidence === 'CONFIRMED')).toBe(true);

    const unverified = await provider.list({ confidence: 'UNVERIFIED' });
    expect(unverified.length).toBe(1);
    expect(unverified.every(e => e.confidence === 'UNVERIFIED')).toBe(true);
  });

  it('type filter works', async () => {
    await provider.capture(makeInput({ type: 'knowledge', title: 'K', symbols: ['symK'] }));
    await provider.capture(makeInput({
      type: 'runbook', title: 'R', summary: 'A runbook', content: 'Steps.',
      symbols: ['symR'], source_files: ['docs/r.md'],
    }));

    const runbooks = await provider.list({ type: 'runbook' });
    expect(runbooks.length).toBe(1);
    expect(runbooks[0].type).toBe('runbook');
  });

  it('module filter works (exact match)', async () => {
    await provider.capture(makeInput({ module: 'src/services', title: 'M1', symbols: ['symM1'] }));
    await provider.capture(makeInput({ module: 'src/tools', title: 'M2', symbols: ['symM2'] }));

    const results = await provider.list({ module: 'src/tools' });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('M2');
  });

  it('symbol filter matches entries whose symbols array contains the value (json_each)', async () => {
    await provider.capture(makeInput({ title: 'S1', symbols: ['uniqueSymbolOne'] }));
    await provider.capture(makeInput({ title: 'S2', symbols: ['uniqueSymbolTwo', 'other'] }));

    const results = await provider.list({ symbol: 'uniqueSymbolTwo' });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('S2');
  });

  it('tag filter matches entries whose tags array contains the value (json_each)', async () => {
    await provider.capture(makeInput({ title: 'T1', symbols: ['symTagT1'], tags: ['sprint:kb-inflight-capture', 'phase:1'] }));
    await provider.capture(makeInput({ title: 'T2', symbols: ['symTagT2'], tags: ['other-tag'] }));

    const results = await provider.list({ tag: 'sprint:kb-inflight-capture' });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('T1');
  });

  it('no tag filter -> unchanged behavior (all entries regardless of tags)', async () => {
    await provider.capture(makeInput({ title: 'NT1', symbols: ['symNoTag1'], tags: ['a'] }));
    await provider.capture(makeInput({ title: 'NT2', symbols: ['symNoTag2'], tags: ['b'] }));

    const results = await provider.list({});
    const titles = results.map(e => e.title);
    expect(titles).toContain('NT1');
    expect(titles).toContain('NT2');
  });

  it('tag + other filter compose (module AND tag)', async () => {
    await provider.capture(makeInput({
      title: 'Compose1', symbols: ['symCompose1'], module: 'src/services', tags: ['sprint:x', 'phase:1'],
    }));
    await provider.capture(makeInput({
      title: 'Compose2', symbols: ['symCompose2'], module: 'src/tools', tags: ['sprint:x', 'phase:1'],
    }));
    await provider.capture(makeInput({
      title: 'Compose3', symbols: ['symCompose3'], module: 'src/services', tags: ['sprint:y'],
    }));

    const results = await provider.list({ module: 'src/services', tag: 'sprint:x' });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Compose1');
  });

  it('limit is respected', async () => {
    for (let i = 0; i < 5; i++) {
      await provider.capture(makeInput({ title: `Entry ${i}`, symbols: [`sym${i}`] }));
    }

    const limited = await provider.list({ limit: 2 });
    expect(limited.length).toBe(2);

    const unlimited = await provider.list({});
    expect(unlimited.length).toBe(5);
  });

  it('excludes superseded entries by default', async () => {
    const first = await provider.capture(makeInput({ symbols: ['symSupersede'] }));
    await provider.capture(makeInput({
      symbols: ['symSupersede'],
      content: 'The registry now initializes eagerly at startup.',
    }));

    const results = await provider.list({});
    expect(results.some(e => e.id === first.id)).toBe(false);
  });

  it('excludes stale entries by default', async () => {
    await provider.capture(makeInput({
      type: 'context-cache', title: 'Cache entry', symbols: ['symCache'],
      source_files: ['src/cache.ts'], content_hash: 'h1', content_hash_type: 'git',
    }));
    await provider.invalidate(['src/cache.ts']);

    const results = await provider.list({ type: 'context-cache' });
    expect(results.length).toBe(0);
  });

  it('does NOT bump use_count or last_accessed', async () => {
    const { id } = await provider.capture(makeInput({ symbols: ['symNoBump'] }));

    await provider.list({});
    await provider.list({ symbol: 'symNoBump' });

    // query({ids}) returns the PRE-bump row then bumps use_count as a side
    // effect for the NEXT call to observe. Calling it twice in a row proves
    // the two list() calls above added nothing: if they had bumped, the
    // second query({ids}) call would report 2 (its own prior bump) plus
    // whatever list() added, not exactly 1.
    await provider.query({ ids: [id] });
    const fetched = await provider.query({ ids: [id] });
    expect(fetched.results[0].use_count).toBe(1);
  });
});

describe('kb_list tool', () => {
  beforeEach(() => {
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
      project: provider,
      global: provider,
      projectSlug: 'test',
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the stable reduced field set', async () => {
    await provider.capture(makeInput({ confidence: 'INFERRED', symbols: ['symTool'] }));
    const { id } = await provider.capture(makeInput({ title: 'ToPromote', confidence: 'INFERRED', symbols: ['symPromote'] }));
    await provider.promote(id, 'confirmed by test');

    const parsed = JSON.parse(await kbList({ confidence: 'CONFIRMED' }));
    expect(parsed.total).toBe(1);
    const entry = parsed.results[0];
    expect(Object.keys(entry).sort()).toEqual(
      ['confidence', 'id', 'source_files', 'summary', 'symbols', 'title', 'type'].sort()
    );
    expect(entry.confidence).toBe('CONFIRMED');
  });

  it('tag filter returns only tagged entries', async () => {
    await provider.capture(makeInput({ title: 'Tagged', symbols: ['symToolTagged'], tags: ['sprint:kb-inflight-capture', 'phase:1'] }));
    await provider.capture(makeInput({ title: 'Untagged', symbols: ['symToolUntagged'], tags: ['other'] }));

    const parsed = JSON.parse(await kbList({ tag: 'sprint:kb-inflight-capture' }));
    expect(parsed.total).toBe(1);
    expect(parsed.results[0].title).toBe('Tagged');
  });

  it('no tag -> unchanged behavior (returns all matching entries)', async () => {
    await provider.capture(makeInput({ title: 'NoTagA', symbols: ['symToolNoTagA'] }));
    await provider.capture(makeInput({ title: 'NoTagB', symbols: ['symToolNoTagB'] }));

    const parsed = JSON.parse(await kbList({}));
    const titles = parsed.results.map((e: any) => e.title);
    expect(titles).toContain('NoTagA');
    expect(titles).toContain('NoTagB');
  });

  it('tag + other filters compose', async () => {
    await provider.capture(makeInput({
      title: 'ComposeToolMatch', symbols: ['symToolCompose1'], module: 'src/services', tags: ['sprint:z'],
    }));
    await provider.capture(makeInput({
      title: 'ComposeToolNoMatch', symbols: ['symToolCompose2'], module: 'src/tools', tags: ['sprint:z'],
    }));

    const parsed = JSON.parse(await kbList({ module: 'src/services', tag: 'sprint:z' }));
    expect(parsed.total).toBe(1);
    expect(parsed.results[0].title).toBe('ComposeToolMatch');
  });
});
