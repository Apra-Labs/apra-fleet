import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { kbList } from '../../src/tools/kb-list.js';
import { kbSessionPrime } from '../../src/tools/kb-session-prime.js';
import { kbContext } from '../../src/tools/kb-context.js';
import { kbPromote } from '../../src/tools/kb-promote.js';
import { getKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { requireSqliteProject } from '../../src/services/knowledge/require-sqlite-project.js';
import { computeFileHash } from '../../src/services/knowledge/file-hash.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

// MEMBER mixed-tier reads (a tier list naming CONFIRMED plus another tier):
// the CONFIRMED part comes from the member's checkout bible view, the other
// tiers from the per-repo DB restricted to the caller's own captures. Three
// members share one checkout (one per-repo DB): A and B each capture, C has
// no captures at all.
//
// Isolation: tests/setup.ts points APRA_FLEET_DATA_DIR at a per-run temp dir;
// the registry is backed up and restored; the checkout lives under one
// scratch root removed in afterAll; the origin remote is unique per run.

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const MIXED = ['CONFIRMED', 'INFERRED'] as const;
const WORD = 'sprocketmix';

let scratch: string;
let repo: string;
let memberA: string;
let memberB: string;
let memberC: string;
let e2: string; // A's own INFERRED capture
let e3: string; // B's INFERRED capture
let dup: string; // A's capture whose id the bible also carries
let aCtxF2: string; // A's own INFERRED context-cache entry for F2
let bCtxF3: string; // B's INFERRED context-cache entry for F3
const F1 = 'src/f1.ts';
const F2 = 'src/f2.ts';
const F3 = 'src/f3.ts';
const BIBLE_CTX = 'bible-ctx-f1';
const BIBLE_IDS = () => ['bible-e1', BIBLE_CTX, dup];

const as = <T>(member: string, fn: () => Promise<T>): Promise<T> => runWithSessionMember(member, fn);
const ids = (rows: Array<{ id: string }>) => rows.map(r => r.id);

async function capture(member: string, title: string, symbol: string): Promise<string> {
  const out = JSON.parse(await as(member, () => kbCapture({
    type: 'knowledge',
    title,
    summary: `${title}: the ${WORD} stage batches work per tick.`,
    content: `${title}: the ${WORD} stage batches work per tick, observed in src/sprocket.ts.`,
    source_files: ['src/sprocket.ts'],
    // Distinct symbols keep AUDN from linking the captures to each other.
    symbols: [symbol],
  } as Parameters<typeof kbCapture>[0])));
  return out.id as string;
}

function bibleEntry(id: string, title: string): Record<string, unknown> {
  return {
    id, type: 'knowledge', title,
    summary: `${title}: the ${WORD} stage is confirmed to batch work.`,
    symbols: [], source_files: ['src/sprocket.ts'],
    confidence: 'CONFIRMED', updated_at: '2026-09-01T00:00:00.000Z',
  };
}

beforeAll(async () => {
  backupAndResetRegistry();
  resetMemberBibleViews();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-member-mixed-'));
  repo = path.join(scratch, 'checkout');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'sprocket.ts'), 'export const sprocket = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', `https://example.test/kb-member-mixed-${RUN}.git`], { cwd: repo });

  for (const key of ['a', 'b', 'c']) {
    const agent = makeTestLocalAgent({ friendlyName: `kb-mixed-${key}-${RUN}`, workFolder: repo });
    addAgent(agent);
    if (key === 'a') memberA = agent.id;
    if (key === 'b') memberB = agent.id;
    if (key === 'c') memberC = agent.id;
  }

  e2 = await capture(memberA, `Sprocketmix alpha own fact`, 'sprocketAlpha');
  e3 = await capture(memberB, `Sprocketmix bravo foreign fact`, 'sprocketBravo');
  dup = await capture(memberA, `Sprocketmix alpha duplicate own copy`, 'sprocketDup');

  // Context-cache entries for F2 (A's own) and F3 (B's), seeded straight into
  // the per-repo DB with the file's real hash so they read fresh.
  for (const f of [F1, F2, F3]) fs.writeFileSync(path.join(repo, f), `export const v = '${f}';\n`);
  const db = requireSqliteProject((await getKbProviders(repo)).project, 'test');
  const seedCtx = async (member: string, file: string): Promise<string> => {
    const hash = (await computeFileHash(path.join(repo, file)))!;
    const { id } = await db.capture({
      type: 'context-cache', title: `Cache of ${file}`, summary: `File summary of ${file}.`,
      content: `File summary of ${file}.`, source_files: [file], symbols: [`cache_${path.basename(file, '.ts')}`],
      tags: [`member:${member}`], content_hash: hash.hash, content_hash_type: hash.type,
      flagged_for_review: false, author: 'doer', source: 'session', confidence: 'INFERRED',
    } as Parameters<typeof db.capture>[0]);
    return id;
  };
  aCtxF2 = await seedCtx(memberA, F2);
  bCtxF3 = await seedCtx(memberB, F3);

  // Written after the captures (and before any member read builds the view):
  // E1 is bible-only; `dup` is the same id as A's capture, with its own title;
  // the bible also carries a CONFIRMED context-cache entry for F1.
  fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.fleet', 'kb-canonical.json'), JSON.stringify({
    version: 2,
    entries: [
      bibleEntry('bible-e1', 'Sprocketmix confirmed bible fact'),
      bibleEntry(dup, 'Sprocketmix duplicate bible copy'),
      {
        id: BIBLE_CTX, type: 'context-cache', title: `Cache of ${F1}`, summary: `File summary of ${F1}.`,
        symbols: [], source_files: [F1], confidence: 'CONFIRMED', updated_at: '2026-09-01T00:00:00.000Z',
      },
    ],
  }), 'utf-8');
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  resetMemberBibleViews();
  restoreRegistry();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('kb_query in a MEMBER session with a mixed tier list', () => {
  it('returns the bible CONFIRMED entry and the caller\'s own capture, never another member\'s', async () => {
    const out = JSON.parse(await as(memberA, () => kbQuery({ query: WORD, confidence: [...MIXED] })));
    const got = ids(out.l1_results);
    expect(got).toEqual(expect.arrayContaining(['bible-e1', e2]));
    expect(got).not.toContain(e3);
    // The bible half comes first.
    expect(got.indexOf('bible-e1')).toBeLessThan(got.indexOf(e2));
    // L2 is fetched from the store that owns each id.
    const l2 = new Map((out.l2_expanded as Array<{ id: string; title: string; content: string }>).map(e => [e.id, e]));
    expect(l2.get(e2)?.content).toContain('observed in src/sprocket.ts');
    expect(l2.has('bible-e1')).toBe(true);
  });

  it('a CONFIRMED-only request is unchanged: the bible entries alone', async () => {
    const out = JSON.parse(await as(memberA, () => kbQuery({ query: WORD, confidence: ['CONFIRMED'] })));
    expect(ids(out.l1_results).sort()).toEqual(['bible-e1', dup].sort());
  });

  it('the mixed result is a superset of the CONFIRMED-only result', async () => {
    const confirmed = ids(JSON.parse(await as(memberA, () => kbQuery({ query: WORD, confidence: ['CONFIRMED'] }))).l1_results);
    const mixed = ids(JSON.parse(await as(memberA, () => kbQuery({ query: WORD, confidence: [...MIXED] }))).l1_results);
    expect(mixed).toEqual(expect.arrayContaining(confirmed));
  });

  it('a member with zero captures gets the bible entries', async () => {
    const out = JSON.parse(await as(memberC, () => kbQuery({ query: WORD, confidence: [...MIXED] })));
    expect(ids(out.l1_results).sort()).toEqual(['bible-e1', dup].sort());
  });

  it('an id in both the bible and the per-repo DB appears once, as the bible copy', async () => {
    const out = JSON.parse(await as(memberA, () => kbQuery({ query: WORD, confidence: [...MIXED] })));
    const rows = (out.l1_results as Array<{ id: string; title: string; confidence: string }>).filter(e => e.id === dup);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Sprocketmix duplicate bible copy', confidence: 'CONFIRMED' });
    const l2 = (out.l2_expanded as Array<{ id: string; title: string }>).filter(e => e.id === dup);
    expect(l2.map(e => e.title)).toEqual(['Sprocketmix duplicate bible copy']);
  });

  it('honours limit on the merged list', async () => {
    const out = JSON.parse(await as(memberA, () => kbQuery({ query: WORD, confidence: [...MIXED], limit: 1 })));
    expect(out.l1_results).toHaveLength(1);
    expect(['bible-e1', dup]).toContain(out.l1_results[0].id);
    const three = JSON.parse(await as(memberA, () => kbQuery({ query: WORD, confidence: [...MIXED], limit: 3 })));
    expect(ids(three.l1_results).sort()).toEqual(['bible-e1', dup, e2].sort());
  });

  it('expand_related keeps the per-repo half owner-tag filtered', async () => {
    const out = JSON.parse(await as(memberA, () => kbQuery({ query: WORD, confidence: [...MIXED], expand_related: true })));
    expect(Array.isArray(out.related_claims)).toBe(true);
    for (const e of out.related_claims as Array<{ confidence: string; tags: string[] }>) {
      expect(e.confidence === 'CONFIRMED' || e.tags.includes(`member:${memberA}`)).toBe(true);
    }
  });
});

describe('kb_list in a MEMBER session with a mixed tier list', () => {
  it('returns the bible CONFIRMED entries and the caller\'s own captures, never another member\'s, in id order', async () => {
    const out = JSON.parse(await as(memberA, () => kbList({ confidence: [...MIXED] })));
    const got = ids(out.results);
    expect(got).toEqual([...BIBLE_IDS(), e2, aCtxF2].sort());
    expect(got).not.toContain(e3);
    expect(got).not.toContain(bCtxF3);
    expect(out.total).toBe(5);
  });

  it('a CONFIRMED-only request is unchanged: the bible entries alone', async () => {
    const out = JSON.parse(await as(memberA, () => kbList({ confidence: ['CONFIRMED'] })));
    expect(ids(out.results)).toEqual(BIBLE_IDS().sort());
  });

  it('a member with zero captures gets the bible entries', async () => {
    const out = JSON.parse(await as(memberC, () => kbList({ confidence: [...MIXED] })));
    expect(ids(out.results)).toEqual(BIBLE_IDS().sort());
  });

  it('an id in both the bible and the per-repo DB appears once, as the bible copy', async () => {
    const out = JSON.parse(await as(memberA, () => kbList({ confidence: [...MIXED] })));
    const rows = (out.results as Array<{ id: string; title: string; confidence: string }>).filter(e => e.id === dup);
    expect(rows).toEqual([expect.objectContaining({ title: 'Sprocketmix duplicate bible copy', confidence: 'CONFIRMED' })]);
  });

  it('honours limit on the merged list', async () => {
    const out = JSON.parse(await as(memberA, () => kbList({ confidence: [...MIXED], limit: 2 })));
    expect(ids(out.results)).toEqual([...BIBLE_IDS(), e2, aCtxF2].sort().slice(0, 2));
  });

  it('member B sees its own capture and the bible, not A\'s', async () => {
    const out = JSON.parse(await as(memberB, () => kbList({ confidence: ['CONFIRMED', 'INFERRED', 'UNVERIFIED'] })));
    expect(ids(out.results)).toEqual([...BIBLE_IDS(), e3, bCtxF3].sort());
  });
});

const FILES = [F1, F2, F3];
type Ctx = { fresh: Array<{ file: string; entry_id: string }>; stale: Array<{ file: string; entry_id: string }>; missing: string[] };
const STATUS_RANK: Record<string, number> = { fresh: 2, stale: 1, missing: 0 };
function statusByFile(out: Ctx): Record<string, string> {
  const by: Record<string, string> = {};
  for (const r of out.fresh) by[r.file] = 'fresh';
  for (const r of out.stale) by[r.file] = 'stale';
  for (const f of out.missing) by[f] = 'missing';
  return by;
}

describe('kb_session_prime in a MEMBER session with a mixed tier list', () => {
  const prime = (member: string, confidence?: string[]) => as(member, async () => JSON.parse(await kbSessionPrime({
    hint_modules: [WORD], session_files: FILES,
    ...(confidence ? { confidence: confidence as Array<'CONFIRMED' | 'INFERRED' | 'UNVERIFIED'> } : {}),
  })));

  it('returns the bible CONFIRMED entry and the caller\'s own capture, never another member\'s', async () => {
    const out = await prime(memberA, [...MIXED]);
    const top = ids(out.top_entries);
    expect(top).toEqual(expect.arrayContaining(['bible-e1', e2]));
    expect(top).not.toContain(e3);
    expect(new Set(top).size).toBe(top.length);
    // The own context-cache entry for F2 is fresh; F3 (another member's) is not.
    expect(out.fresh_summaries.map((r: { file: string }) => r.file)).toEqual([F2]);
    expect(out.fresh_summaries.map((r: { entry_id: string }) => r.entry_id)).toEqual([aCtxF2]);
    expect(out.stale_files).not.toContain(F2);
    expect(out.stale_files).toEqual(expect.arrayContaining([F1, F3]));
    expect(out.session_warm).toBe(false);
  });

  it('the mixed result is a superset of the CONFIRMED-only result', async () => {
    const confirmed = await prime(memberA, ['CONFIRMED']);
    const mixed = await prime(memberA, [...MIXED]);
    expect(ids(mixed.top_entries)).toEqual(expect.arrayContaining(ids(confirmed.top_entries)));
    // The CONFIRMED half comes first, unchanged.
    expect(ids(mixed.top_entries).slice(0, confirmed.top_entries.length)).toEqual(ids(confirmed.top_entries));
    const confirmedFresh = confirmed.fresh_summaries.map((r: { file: string }) => r.file);
    expect(mixed.fresh_summaries.map((r: { file: string }) => r.file)).toEqual(expect.arrayContaining(confirmedFresh));
  });

  it('a member with zero captures gets the bible entries', async () => {
    const out = await prime(memberC, [...MIXED]);
    const confirmed = await prime(memberC, ['CONFIRMED']);
    expect(ids(out.top_entries)).toEqual(ids(confirmed.top_entries));
    expect(ids(out.top_entries)).toEqual(expect.arrayContaining(['bible-e1', dup]));
    expect(ids(out.top_entries)).not.toContain(e2);
  });

  it('an id in both the bible and the per-repo DB appears once, as the bible copy', async () => {
    const out = await prime(memberA, [...MIXED]);
    const rows = (out.top_entries as Array<{ id: string; title: string }>).filter(e => e.id === dup);
    expect(rows.map(e => e.title)).toEqual(['Sprocketmix duplicate bible copy']);
  });
});

describe('kb_context in a MEMBER session with a mixed tier list', () => {
  const context = (member: string, confidence?: string[]) => as(member, async () => JSON.parse(await kbContext({
    files: FILES,
    ...(confidence ? { confidence: confidence as Array<'CONFIRMED' | 'INFERRED' | 'UNVERIFIED'> } : {}),
  })) as Ctx);

  it('reports F1 from the bible, F2 fresh from the own capture, F3 (another member\'s) missing', async () => {
    const out = await context(memberA, [...MIXED]);
    expect(out.fresh.map(r => [r.file, r.entry_id])).toEqual([[F2, aCtxF2]]);
    // A bible context-cache entry carries no content hash (bible import
    // stores none), so the bible's F1 entry is found but reads stale.
    expect(out.stale.map(r => [r.file, r.entry_id])).toEqual([[F1, BIBLE_CTX]]);
    expect(out.missing).toEqual([F3]);
  });

  it('the mixed result is a superset of the CONFIRMED-only result (no file gets a worse status)', async () => {
    const confirmed = statusByFile(await context(memberA, ['CONFIRMED']));
    const mixed = statusByFile(await context(memberA, [...MIXED]));
    for (const f of FILES) expect(STATUS_RANK[mixed[f]]).toBeGreaterThanOrEqual(STATUS_RANK[confirmed[f]]);
    expect(confirmed).toEqual({ [F1]: 'stale', [F2]: 'missing', [F3]: 'missing' });
  });

  it('a member with zero captures gets the bible entries', async () => {
    const out = await context(memberC, [...MIXED]);
    expect(out.stale.map(r => r.entry_id)).toEqual([BIBLE_CTX]);
    expect(out.missing).toEqual([F2, F3]);
  });

  it('the default (no tier list) member read gives the same answer as the explicit CONFIRMED+INFERRED list here', async () => {
    expect(await context(memberA)).toEqual(await context(memberA, [...MIXED]));
    expect(await context(memberB)).toEqual(await context(memberB, [...MIXED]));
  });
});

describe('FULL session with the same mixed tier list is unchanged (no bible-view split)', () => {
  const full = <T>(fn: () => Promise<T>): Promise<T> => {
    vi.spyOn(process, 'cwd').mockReturnValue(repo);
    return runWithSessionMember(undefined, fn);
  };

  it('kb_query sees every member\'s captures from the per-repo DB, not the bible', async () => {
    const got = ids(JSON.parse(await full(() => kbQuery({ query: WORD, confidence: [...MIXED] }))).l1_results);
    expect(got).toEqual(expect.arrayContaining([e2, e3]));
    expect(got).not.toContain('bible-e1');
  });

  it('kb_list sees every member\'s captures', async () => {
    const got = ids(JSON.parse(await full(() => kbList({ confidence: [...MIXED] }))).results);
    expect(got).toEqual(expect.arrayContaining([e2, e3, aCtxF2, bCtxF3]));
    expect(got).not.toContain('bible-e1');
  });

  it('kb_session_prime sees every member\'s captures', async () => {
    const out = JSON.parse(await full(() => kbSessionPrime({ hint_modules: [WORD], session_files: FILES, confidence: [...MIXED] })));
    expect(ids(out.top_entries)).toEqual(expect.arrayContaining([e2, e3]));
    expect(out.fresh_summaries.map((r: { file: string }) => r.file).sort()).toEqual([F2, F3]);
  });

  it('kb_context reports F2 and F3 fresh and F1 missing (no bible entry in the per-repo DB)', async () => {
    const out = JSON.parse(await full(() => kbContext({ files: FILES, confidence: [...MIXED] }))) as Ctx;
    expect(out.fresh.map(r => r.file).sort()).toEqual([F2, F3]);
    expect(out.missing).toEqual([F1]);
  });
});

// A member's own capture promoted to CONFIRMED in the per-repo DB (kb_promote)
// has not reached the bible yet. The own half of a mixed read asks for every
// requested tier, so it is still returned; another member's DB-only CONFIRMED
// entry is not (CONFIRMED is the bible's for everything but own captures).
// Own word and files (F4/F5) keep the shared fixtures' exact lists untouched.
describe('MEMBER mixed-tier reads keep the caller\'s own CONFIRMED-in-DB captures', () => {
  const WORD2 = 'gearpromo';
  const F4 = 'src/f4.ts';
  const F5 = 'src/f5.ts';
  let aConf: string; // A's capture, promoted to CONFIRMED in the per-repo DB
  let bConf: string; // B's capture, promoted to CONFIRMED in the per-repo DB
  let aCtxF4: string; // A's context-cache entry for F4, promoted to CONFIRMED
  let bCtxF5: string; // B's context-cache entry for F5, promoted to CONFIRMED
  const REASON = 'Verified against src/sprocket.ts in this test fixture checkout.';

  const promote = async (member: string, id: string): Promise<void> => {
    const out = JSON.parse(await as(member, () => kbPromote({ id, reason: REASON })));
    expect(out.new_confidence).toBe('CONFIRMED');
  };

  beforeAll(async () => {
    const cap = async (member: string, title: string, symbol: string): Promise<string> => {
      const out = JSON.parse(await as(member, () => kbCapture({
        type: 'knowledge', title,
        summary: `${title}: the ${WORD2} stage retries a failed tick.`,
        content: `${title}: the ${WORD2} stage retries a failed tick, see src/sprocket.ts.`,
        source_files: ['src/sprocket.ts'], symbols: [symbol],
      } as Parameters<typeof kbCapture>[0])));
      return out.id as string;
    };
    aConf = await cap(memberA, 'Gearpromo alpha promoted fact', 'gearAlpha');
    bConf = await cap(memberB, 'Gearpromo bravo promoted fact', 'gearBravo');

    for (const f of [F4, F5]) fs.writeFileSync(path.join(repo, f), `export const v = '${f}';\n`);
    const db = requireSqliteProject((await getKbProviders(repo)).project, 'test');
    const seedCtx = async (member: string, file: string): Promise<string> => {
      const hash = (await computeFileHash(path.join(repo, file)))!;
      const { id } = await db.capture({
        type: 'context-cache', title: `Cache of ${file}`, summary: `File summary of ${file}.`,
        content: `File summary of ${file}.`, source_files: [file], symbols: [`cache_${path.basename(file, '.ts')}`],
        tags: [`member:${member}`], content_hash: hash.hash, content_hash_type: hash.type,
        flagged_for_review: false, author: 'doer', source: 'session', confidence: 'INFERRED',
      } as Parameters<typeof db.capture>[0]);
      return id;
    };
    aCtxF4 = await seedCtx(memberA, F4);
    bCtxF5 = await seedCtx(memberB, F5);

    await promote(memberA, aConf);
    await promote(memberB, bConf);
    await promote(memberA, aCtxF4);
    await promote(memberB, bCtxF5);
    // The rows really are CONFIRMED in the per-repo DB, and the bible does not carry them.
    const stored = (await db.query({ ids: [aConf, bConf, aCtxF4, bCtxF5] })).results;
    expect(stored).toHaveLength(4);
    for (const e of stored) expect(e.confidence).toBe('CONFIRMED');
    for (const id of [aConf, bConf, aCtxF4, bCtxF5]) expect(BIBLE_IDS()).not.toContain(id);
  });

  it('kb_query returns the caller\'s own CONFIRMED-in-DB capture, not another member\'s', async () => {
    const out = JSON.parse(await as(memberA, () => kbQuery({ query: WORD2, confidence: [...MIXED] })));
    const rows = out.l1_results as Array<{ id: string; confidence: string }>;
    expect(rows.find(e => e.id === aConf)).toMatchObject({ confidence: 'CONFIRMED' });
    expect(ids(rows)).not.toContain(bConf);
    expect(ids(out.l2_expanded)).toContain(aConf);
  });

  it('kb_list returns the caller\'s own CONFIRMED-in-DB entries, not another member\'s', async () => {
    const out = JSON.parse(await as(memberA, () => kbList({ confidence: [...MIXED] })));
    const rows = out.results as Array<{ id: string; confidence: string }>;
    expect(rows.find(e => e.id === aConf)).toMatchObject({ confidence: 'CONFIRMED' });
    expect(rows.find(e => e.id === aCtxF4)).toMatchObject({ confidence: 'CONFIRMED' });
    expect(ids(rows)).not.toContain(bConf);
    expect(ids(rows)).not.toContain(bCtxF5);
  });

  it('kb_session_prime returns the caller\'s own CONFIRMED-in-DB capture, not another member\'s', async () => {
    const out = JSON.parse(await as(memberA, () => kbSessionPrime({
      hint_modules: [WORD2], session_files: [F4, F5], confidence: [...MIXED],
    })));
    const top = ids(out.top_entries);
    expect(top).toContain(aConf);
    expect(top).not.toContain(bConf);
    expect(out.fresh_summaries.map((r: { entry_id: string }) => r.entry_id)).toEqual([aCtxF4]);
    expect(out.stale_files).toEqual([F5]);
  });

  it('kb_context reports the caller\'s own CONFIRMED-in-DB cache entry fresh, not another member\'s', async () => {
    const out = JSON.parse(await as(memberA, () => kbContext({ files: [F4, F5], confidence: [...MIXED] }))) as Ctx;
    expect(out.fresh.map(r => [r.file, r.entry_id])).toEqual([[F4, aCtxF4]]);
    expect(out.missing).toEqual([F5]);
    // The default member read agrees.
    expect(JSON.parse(await as(memberA, () => kbContext({ files: [F4, F5] })))).toEqual(out);
  });
});
