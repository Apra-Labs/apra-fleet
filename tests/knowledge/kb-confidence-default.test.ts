import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { kbList } from '../../src/tools/kb-list.js';
import { kbSessionPrime } from '../../src/tools/kb-session-prime.js';
import { kbContext } from '../../src/tools/kb-context.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// The four KB read tools (kb_query, kb_list, kb_session_prime, kb_context)
// return only CONFIRMED, undisputed entries when the caller gives no
// confidence filter; other tiers appear only when listed explicitly, and
// kb_query {flagged_only:true} is exempt (it exists to list disputed entries).

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'Confdefault base',
    summary: 'confdefault summary',
    content: 'confdefault content',
    source_files: ['src/cd/base.ts'],
    symbols: ['cdBase'],
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
let emptyGlobal: SqliteProvider;
let tmpDir: string;
let ids: Record<string, string>;

async function confirmed(o: Partial<KBEntryInput>): Promise<string> {
  // importMode is the only capture() path that keeps CONFIRMED.
  return (await provider.capture(makeInput({ ...o, confidence: 'CONFIRMED' }), { importMode: true })).id;
}
async function plain(o: Partial<KBEntryInput>): Promise<string> {
  return (await provider.capture(makeInput(o))).id;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-confdefault-'));
  provider = new SqliteProvider(':memory:');
  await provider.init();
  emptyGlobal = new SqliteProvider(':memory:');
  await emptyGlobal.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: provider,
    global: emptyGlobal,
    projectSlug: 'test',
  } as any);

  ids = {
    confirmed: await confirmed({ title: 'Confdefault confirmed claim', source_files: ['src/cd/a.ts'], symbols: ['cdA'] }),
    inferred: await plain({ title: 'Confdefault inferred claim', source_files: ['src/cd/b.ts'], symbols: ['cdB'] }),
    unverified: await plain({ title: 'Confdefault unverified claim', confidence: 'UNVERIFIED', source_files: ['src/cd/c.ts'], symbols: ['cdC'] }),
    flagged: await confirmed({ title: 'Confdefault flagged confirmed claim', flagged_for_review: true, source_files: ['src/cd/d.ts'], symbols: ['cdD'] }),
  };
  ids.challenger = await confirmed({
    title: 'Confdefault challenger confirmed claim',
    contradiction_of: ids.flagged,
    source_files: ['src/cd/e.ts'],
    symbols: ['cdE'],
  } as Partial<KBEntryInput>);
});

afterEach(() => {
  vi.restoreAllMocks();
  provider.close();
  emptyGlobal.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ALL = ['CONFIRMED', 'INFERRED', 'UNVERIFIED'] as const;

describe('default (no confidence filter) is CONFIRMED + undisputed', () => {
  it('kb_query', async () => {
    const parsed = JSON.parse(await kbQuery({ query: 'confdefault', limit: 50 }));
    expect(parsed.l1_results.map((e: any) => e.id)).toEqual([ids.confirmed]);
  });

  it('kb_list', async () => {
    const parsed = JSON.parse(await kbList({ limit: 50 }));
    const got = parsed.results.map((e: any) => e.id);
    expect(got).toContain(ids.confirmed);
    expect(got).not.toContain(ids.inferred);
    expect(got).not.toContain(ids.unverified);
    expect(got).not.toContain(ids.flagged);
    expect(got).not.toContain(ids.challenger);
    for (const e of parsed.results) expect(e.confidence).toBe('CONFIRMED');
  });

  it('kb_session_prime', async () => {
    const parsed = JSON.parse(await kbSessionPrime({
      hint_symbols: ['confdefault'],
    } as any, { folder: tmpDir }));
    const got = parsed.top_entries.map((e: any) => e.id);
    expect(got).toContain(ids.confirmed);
    expect(got).not.toContain(ids.inferred);
    expect(got).not.toContain(ids.unverified);
    expect(got).not.toContain(ids.flagged);
    expect(got).not.toContain(ids.challenger);
  });

  it('kb_context', async () => {
    const mk = (file: string, confidence: 'CONFIRMED' | 'INFERRED') => makeInput({
      type: 'context-cache', title: `cache ${file}`, source_files: [file],
      content_hash: 'invalidated', confidence,
    });
    await provider.capture(mk('src/cd/ctx-confirmed.ts', 'CONFIRMED'), { importMode: true });
    await provider.capture(mk('src/cd/ctx-inferred.ts', 'INFERRED'));
    const files = ['src/cd/ctx-confirmed.ts', 'src/cd/ctx-inferred.ts'];

    const byDefault = JSON.parse(await kbContext({ files } as any));
    expect(byDefault.missing).toEqual(['src/cd/ctx-inferred.ts']);
    expect(byDefault.stale.map((r: any) => r.file)).toEqual(['src/cd/ctx-confirmed.ts']);

    const explicit = JSON.parse(await kbContext({ files, confidence: ['INFERRED'] } as any));
    expect(explicit.stale.map((r: any) => r.file)).toEqual(['src/cd/ctx-inferred.ts']);
  });

  it('kb_context excludes disputed CONFIRMED cache entries by default', async () => {
    const mk = (file: string, o: Partial<KBEntryInput>) => makeInput({
      type: 'context-cache', title: `cache ${file}`, source_files: [file],
      content_hash: 'invalidated', ...o,
    });
    const flaggedId = (await provider.capture(
      mk('src/cd/ctx-flagged.ts', { confidence: 'CONFIRMED', flagged_for_review: true }), { importMode: true })).id;
    await provider.capture(
      mk('src/cd/ctx-challenger.ts', { confidence: 'CONFIRMED', contradiction_of: flaggedId } as Partial<KBEntryInput>),
      { importMode: true });
    const files = ['src/cd/ctx-flagged.ts', 'src/cd/ctx-challenger.ts'];

    const byDefault = JSON.parse(await kbContext({ files } as any));
    expect(byDefault.missing.sort()).toEqual([...files].sort());
    expect(byDefault.stale).toEqual([]);

    // An explicit tier list opts out of the dispute filter.
    const explicit = JSON.parse(await kbContext({ files, confidence: ['CONFIRMED'] } as any));
    expect(explicit.stale.map((r: any) => r.file).sort()).toEqual([...files].sort());
  });
});

describe('explicit confidence opts in to other tiers', () => {
  it('kb_query confidence ["INFERRED"] returns INFERRED entries', async () => {
    const parsed = JSON.parse(await kbQuery({ query: 'confdefault', limit: 50, confidence: ['INFERRED'] }));
    expect(parsed.l1_results.map((e: any) => e.id)).toEqual([ids.inferred]);
  });

  it('kb_list accepts an array confidence input', async () => {
    const parsed = JSON.parse(await kbList({ limit: 50, confidence: ['INFERRED', 'UNVERIFIED'] }));
    expect(parsed.results.map((e: any) => e.id).sort()).toEqual([ids.inferred, ids.unverified].sort());
  });

  it('kb_session_prime accepts a confidence array', async () => {
    const parsed = JSON.parse(await kbSessionPrime({ hint_symbols: ['confdefault'], confidence: ['INFERRED'],
    } as any, { folder: tmpDir }));
    expect(parsed.top_entries.map((e: any) => e.id)).toContain(ids.inferred);
  });

  it('kb_query with every tier listed still returns the full set', async () => {
    const parsed = JSON.parse(await kbQuery({ query: 'confdefault', limit: 50, confidence: [...ALL] }));
    const got = parsed.l1_results.map((e: any) => e.id);
    for (const id of Object.values(ids)) expect(got).toContain(id);
  });
});

describe('flagged_only is exempt', () => {
  it('kb_query {flagged_only:true} still returns the disputed pair', async () => {
    const parsed = JSON.parse(await kbQuery({ flagged_only: true }));
    const got = parsed.flagged_entries.map((e: any) => e.id);
    expect(got).toContain(ids.flagged);
    expect(got).toContain(ids.challenger);
  });
});
