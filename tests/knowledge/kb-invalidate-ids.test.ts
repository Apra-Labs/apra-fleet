import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

const memberState = vi.hoisted(() => ({ id: undefined as string | undefined, kbMaintainer: false }));
const providerState = vi.hoisted(() => ({ p: undefined as unknown }));

vi.mock('../../src/services/tool-scope.js', () => ({
  getSessionMemberId: () => memberState.id,
  getSessionKbMaintainer: () => memberState.kbMaintainer,
}));
vi.mock('../../src/services/knowledge/kb-self.js', () => ({
  getSelfKbProviders: async () => ({ project: providerState.p, global: {}, projectSlug: 'slug' }),
  memberOwnerTag: (anchor?: unknown) => (anchor !== undefined || memberState.id === undefined ? undefined : `member:${memberState.id}`),
}));

import { kbInvalidate } from '../../src/tools/kb-invalidate.js';

function input(title: string, tags: string[]): KBEntryInput {
  return {
    type: 'learning', title, summary: `${title} summary text`, content: `${title} content body`,
    source_files: ['src/a.ts'], symbols: [`sym_${title}`], tags,
    content_hash: '', content_hash_type: 'sha256', flagged_for_review: false,
    author: 'test', source: 'doer', confidence: 'INFERRED',
  };
}

let provider: SqliteProvider;
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';

beforeEach(async () => {
  provider = new SqliteProvider(':memory:');
  await provider.init();
  providerState.p = provider;
  memberState.id = undefined;
  memberState.kbMaintainer = false;
});
afterEach(() => provider.close());

const run = async (args: Record<string, unknown>) => JSON.parse(await kbInvalidate(args as any));
const visible = async () => (await provider.query({ confidence: ['INFERRED'] } as any)).results.map(e => e.id);

describe('kb_invalidate {ids}', () => {
  it('discards an own entry: gone from query/list, row kept with superseded_at set', async () => {
    const { id } = await provider.capture(input('alphaone', [`member:${A}`]));
    expect(await visible()).toContain(id);
    const out = await run({ ids: [id] });
    expect(out).toEqual({ discarded: [id], not_found: [], already_discarded: [] });
    expect(await visible()).not.toContain(id);
    const list = await (provider as any).list({ confidence: ['INFERRED'] });
    expect(list.map((e: any) => e.id)).not.toContain(id);
    const row = (provider as any).getDb().prepare('SELECT superseded_at, stale FROM entries WHERE id = ?').get(id);
    expect(row.superseded_at).toBeTruthy();
    expect(row.stale).toBe(1);
  });

  it('reports unknown ids as not_found and repeat discards as already_discarded', async () => {
    const { id } = await provider.capture(input('betaone', []));
    await run({ ids: [id] });
    const out = await run({ ids: [id, 'no-such-id'] });
    expect(out).toEqual({ discarded: [], not_found: ['no-such-id'], already_discarded: [id] });
  });

  it('rejects both files and ids, and neither', async () => {
    await expect(kbInvalidate({ files: ['src/a.ts'], ids: ['x'] } as any)).rejects.toThrow(/exactly one/);
    await expect(kbInvalidate({} as any)).rejects.toThrow(/exactly one/);
  });

  it('MEMBER session: another member\'s entry is not_found and unchanged; own entry is discarded', async () => {
    const own = await provider.capture(input('gammaone', [`member:${A}`]));
    const other = await provider.capture(input('deltaone', [`member:${B}`]));
    const untagged = await provider.capture(input('epsilonone', []));
    memberState.id = A;
    const out = await run({ ids: [other.id, untagged.id, own.id] });
    expect(out.discarded).toEqual([own.id]);
    // A member session without the kb_maintainer grant: refused is reported (empty here).
    expect(out.refused).toEqual([]);
    expect(out.not_found.sort()).toEqual([other.id, untagged.id].sort());
    const ids = await visible();
    expect(ids).toContain(other.id);
    expect(ids).toContain(untagged.id);
    const row = (provider as any).getDb().prepare('SELECT superseded_at FROM entries WHERE id = ?').get(other.id);
    expect(row.superseded_at).toBeNull();
  });

  it('MEMBER session with an explicit in-process anchor discards another member\'s entry (full scope, like kb_promote/kb_capture)', async () => {
    const other = await provider.capture(input('etaone', [`member:${B}`]));
    memberState.id = A;
    const out = JSON.parse(await kbInvalidate({ ids: [other.id] } as any, { folder: '/tmp/x', remoteUrl: 'https://example.invalid/r.git' } as any));
    expect(out).toEqual({ discarded: [other.id], not_found: [], already_discarded: [] });
  });

  it('MEMBER session without the kb_maintainer grant: an own CONFIRMED entry is refused (left live), own INFERRED discarded in the same call', async () => {
    const confirmed = await provider.capture(input('thetaone', [`member:${A}`]));
    await provider.promote(confirmed.id, 'test fixture: verified');
    await provider.promote(confirmed.id, 'test fixture: verified');
    const inferred = await provider.capture(input('iotaone', [`member:${A}`]));
    memberState.id = A;
    const out = await run({ ids: [confirmed.id, inferred.id] });
    expect(out).toEqual({ discarded: [inferred.id], not_found: [], already_discarded: [], refused: [confirmed.id] });
    const row = (provider as any).getDb().prepare('SELECT superseded_at, confidence FROM entries WHERE id = ?').get(confirmed.id);
    expect(row.superseded_at).toBeNull();
    expect(row.confidence).toBe('CONFIRMED');
  });

  it('MEMBER session WITH the kb_maintainer grant discards an own CONFIRMED entry (no refused field)', async () => {
    const confirmed = await provider.capture(input('kappaone', [`member:${A}`]));
    await provider.promote(confirmed.id, 'test fixture: verified');
    await provider.promote(confirmed.id, 'test fixture: verified');
    memberState.id = A;
    memberState.kbMaintainer = true;
    expect(await run({ ids: [confirmed.id] })).toEqual({ discarded: [confirmed.id], not_found: [], already_discarded: [] });
  });

  it('FULL session may discard any entry', async () => {
    const other = await provider.capture(input('zetaone', [`member:${B}`]));
    expect((await run({ ids: [other.id] })).discarded).toEqual([other.id]);
  });

  it('files path is unchanged', async () => {
    const out = await run({ files: ['src/a.ts'] });
    expect(out).toEqual({ invalidated: 0, files: ['src/a.ts'] });
  });
});
