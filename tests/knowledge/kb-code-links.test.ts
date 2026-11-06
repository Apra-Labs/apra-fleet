import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { CodeLinkItem, CodeLinkResolver, ResolvedCodeLink } from '../../src/services/knowledge/code-links.js';
import { interpretContextResult, kbCodeLinkResolverFor } from '../../src/tools/kb-code-link-resolver.js';
import { NullProvider, type CodeIntelligenceProvider } from '../../src/tools/code-intelligence.js';
import { CodeIntelError } from '../../src/tools/code-intelligence-readiness.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// KB entry -> code-index links (design D2a anchors): resolved at capture off
// the request path through an injected resolver, re-resolved by the freshness
// sweep, and looked up by file intersection or one-hop symbol neighbourhood.
// Real SqliteProvider on a temp kb.sqlite; every file lives under one mkdtemp
// dir removed in afterAll.

let tmp: string;
let repo: string;
let n = 0;
let p: SqliteProvider;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-code-links-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  for (const f of ['a.ts', 'b.ts', 'c.ts']) fs.writeFileSync(path.join(repo, 'src', f), `export const x = '${f}';\n`);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(async () => {
  p = new SqliteProvider(path.join(tmp, `kb-${n++}.sqlite`), repo);
  await p.init();
});
afterEach(() => p.close());

function input(over: Partial<KBEntryInput>): KBEntryInput {
  return {
    type: 'knowledge', title: 't', summary: 's', content: 'c', source_files: ['src/a.ts'], symbols: [], tags: [],
    content_hash: '', content_hash_type: 'sha256', flagged_for_review: false, author: 'links-test', source: 'doer',
    confidence: 'INFERRED', ...over,
  };
}

/** Fake resolver: a fixed symbol graph; unknown symbols unresolved. */
function fakeResolver(graph: Record<string, string[]>, calls: CodeLinkItem[][] = []): CodeLinkResolver {
  return async (items) => {
    calls.push(items);
    return items.map((it): ResolvedCodeLink => it.kind === 'file'
      ? { ...it, resolved: true }
      : graph[it.ref] ? { ...it, resolved: true, neighbours: graph[it.ref] } : { ...it, resolved: false });
  };
}

describe('code links at capture', () => {
  it('stores resolved links with neighbours, and an unresolvable symbol as unresolved', async () => {
    p.attachCodeResolver(fakeResolver({ syncMember: ['runRound', 'pushBranch'] }));
    const { id } = await p.capture(input({ title: 'sync member', symbols: ['syncMember', 'NoSuchSymbol'], source_files: ['src/a.ts'] }));
    expect(await p.waitForCodeLinks(5000)).toBe(true);
    expect(p.codeLinksOf(id)).toEqual([
      { kind: 'file', ref: 'src/a.ts', resolved: true, neighbours: [] },
      { kind: 'symbol', ref: 'NoSuchSymbol', resolved: false, neighbours: [] },
      { kind: 'symbol', ref: 'syncMember', resolved: true, neighbours: ['runRound', 'pushBranch'] },
    ]);
  });

  it('a throwing resolver does not fail the capture', async () => {
    p.attachCodeResolver(async () => { throw new Error('resolver exploded'); });
    const { id } = await p.capture(input({ title: 'throwing resolver', symbols: ['Boom'] }));
    expect(id).toBeTruthy();
    expect(await p.waitForCodeLinks(5000)).toBe(true);
    expect(p.codeLinksOf(id)).toEqual([]);
    expect(p.hasEntry(id)).toBe(true);
  });

  it('no resolver, or no code index (resolver answers null), is a skip', async () => {
    const a = await p.capture(input({ title: 'no resolver', symbols: ['Lonely'] }));
    expect(await p.waitForCodeLinks(5000)).toBe(true);
    expect(p.codeLinksOf(a.id)).toEqual([]);
    p.attachCodeResolver(async () => null);
    const b = await p.capture(input({ title: 'no index', symbols: ['Indexless'], source_files: ['src/b.ts'] }));
    expect(await p.waitForCodeLinks(5000)).toBe(true);
    expect(p.codeLinksOf(b.id)).toEqual([]);
    // The skip is recorded on the KB's own status, not in the fleet log.
    const st = p.codeLinksStatus();
    expect(st.last_skip).toMatch(/no ready code index/);
    expect(st.last_skip_at).not.toBeNull();
    expect(st.last_resolved_at).toBeNull();
  });
});

describe('freshness sweep re-resolves links', () => {
  it('replaces the neighbour set when the resolver answers differently', async () => {
    const graph: Record<string, string[]> = { syncMember: ['runRound'] };
    p.attachCodeResolver(fakeResolver(graph));
    const { id } = await p.capture(input({ title: 'sweep links', symbols: ['syncMember'] }));
    await p.waitForCodeLinks(5000);
    expect(p.codeLinksOf(id).find(l => l.kind === 'symbol')?.neighbours).toEqual(['runRound']);

    graph.syncMember = ['salvageBeforeReset', 'gitFetch'];
    await p.freshnessSweep();
    expect(await p.waitForCodeLinks(5000)).toBe(true);
    expect(p.codeLinksOf(id).find(l => l.kind === 'symbol')?.neighbours).toEqual(['salvageBeforeReset', 'gitFetch']);
  });
});

describe('lookupAnchors', () => {
  it('returns entries by file intersection and by one-hop symbol neighbour, not for unrelated symbols', async () => {
    p.attachCodeResolver(fakeResolver({ syncMember: ['runRound', 'pushBranch'], parseConfig: ['readFile'] }));
    const byFile = await p.capture(input({ title: 'file anchored', symbols: ['parseConfig'], source_files: ['src/b.ts'] }));
    const bySym = await p.capture(input({ title: 'symbol anchored', symbols: ['syncMember'], source_files: ['src/c.ts'] }));
    await p.waitForCodeLinks(5000);

    expect(p.lookupAnchors(['src/b.ts'], [])).toEqual([byFile.id]);
    expect(p.lookupAnchors(['./src/b.ts'], [])).toEqual([byFile.id]);
    expect(p.lookupAnchors([], ['runRound'])).toEqual([bySym.id]); // one hop from syncMember
    expect(p.lookupAnchors([], ['syncMember'])).toEqual([bySym.id]); // the symbol itself
    expect(p.lookupAnchors([], ['totallyUnrelated'])).toEqual([]);
    expect(p.lookupAnchors(['src/zzz.ts'], ['totallyUnrelated'])).toEqual([]);
    expect(p.lookupAnchors(['src/b.ts'], ['pushBranch']).sort()).toEqual([byFile.id, bySym.id].sort());

    // A retired entry is no anchor.
    await p.discard([byFile.id]);
    expect(p.lookupAnchors(['src/b.ts'], [])).toEqual([]);
  });
});

describe('tool-layer resolver', () => {
  const contextText = (payload: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) + '\n\n---\n**Next:** hint' }] });

  it('reads one-hop callers and callees out of a code_context answer', () => {
    const r = interpretContextResult('freshnessSweep', contextText({
      status: 'found',
      symbol: { name: 'freshnessSweep' },
      incoming: { calls: [
        { uid: 'Function:src/tools/kb-freshness-sweep.ts:kbFreshnessSweep', name: 'kbFreshnessSweep' },
        { uid: 'File:tests/knowledge/kb-freshness.test.ts', name: 'kb-freshness.test.ts' },
      ] },
      outgoing: { calls: [{ uid: 'Method:x:anchorIsMissing', name: 'anchorIsMissing' }] },
    }));
    expect(r).toEqual({ kind: 'symbol', ref: 'freshnessSweep', resolved: true, neighbours: ['kbFreshnessSweep', 'anchorIsMissing'] });
    expect(interpretContextResult('Nope', contextText({ status: 'not_found' })).resolved).toBe(false);
    expect(interpretContextResult('Nope', { isError: true, content: [] }).resolved).toBe(false);
  });

  it('answers null for provider none and for a code index that is not ready; files resolve on disk', async () => {
    const none = kbCodeLinkResolverFor(repo, undefined, { provider: async () => new NullProvider() });
    expect(await none([{ kind: 'symbol', ref: 'x' }])).toBeNull();

    // Readiness is checked first: a not-ready index is never queried (no child
    // spawn, no index build from a KB capture).
    const context = vi.fn(async () => contextText({ status: 'found' }));
    const gated = kbCodeLinkResolverFor(repo, undefined, {
      provider: async () => ({ context } as unknown as CodeIntelligenceProvider),
      indexReady: async () => false,
    });
    expect(await gated([{ kind: 'symbol', ref: 'x' }])).toBeNull();
    expect(context).not.toHaveBeenCalled();

    const notReady = {
      context: async () => { throw new CodeIntelError('E-CODE-INDEX-NOT-READY', 'building', 'retry'); },
    } as unknown as CodeIntelligenceProvider;
    const r1 = kbCodeLinkResolverFor(repo, undefined, { provider: async () => notReady });
    expect(await r1([{ kind: 'symbol', ref: 'x' }])).toBeNull();

    const ok = {
      context: async ({ name }: { name: string }) => contextText(name === 'known'
        ? { status: 'found', incoming: { calls: [{ uid: 'Function:a', name: 'caller' }] } }
        : { status: 'not_found' }),
    } as unknown as CodeIntelligenceProvider;
    const r2 = kbCodeLinkResolverFor(repo, undefined, { provider: async () => ok });
    expect(await r2([
      { kind: 'symbol', ref: 'known' }, { kind: 'symbol', ref: 'unknown' },
      { kind: 'file', ref: 'src/a.ts' }, { kind: 'file', ref: 'src/missing.ts' }, { kind: 'file', ref: '../outside.ts' },
    ])).toEqual([
      { kind: 'symbol', ref: 'known', resolved: true, neighbours: ['caller'] },
      { kind: 'symbol', ref: 'unknown', resolved: false },
      { kind: 'file', ref: 'src/a.ts', resolved: true },
      { kind: 'file', ref: 'src/missing.ts', resolved: false },
      { kind: 'file', ref: '../outside.ts', resolved: false },
    ]);
  });
});

describe('layering', () => {
  it('adds no import from src/services/knowledge to src/tools', () => {
    const root = path.resolve(__dirname, '../../src/services/knowledge');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f);
        else if (f.endsWith('.ts') && /from\s+['"](\.\.\/)+tools\//.test(fs.readFileSync(f, 'utf-8'))) offenders.push(path.relative(root, f));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
