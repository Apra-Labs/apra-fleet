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

  // Written after the captures (and before any member read builds the view):
  // E1 is bible-only; `dup` is the same id as A's capture, with its own title.
  fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.fleet', 'kb-canonical.json'), JSON.stringify({
    version: 2,
    entries: [
      bibleEntry('bible-e1', 'Sprocketmix confirmed bible fact'),
      bibleEntry(dup, 'Sprocketmix duplicate bible copy'),
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
    expect(got).toEqual(['bible-e1', dup, e2].sort());
    expect(got).not.toContain(e3);
    expect(out.total).toBe(3);
  });

  it('a CONFIRMED-only request is unchanged: the bible entries alone', async () => {
    const out = JSON.parse(await as(memberA, () => kbList({ confidence: ['CONFIRMED'] })));
    expect(ids(out.results)).toEqual(['bible-e1', dup].sort());
  });

  it('a member with zero captures gets the bible entries', async () => {
    const out = JSON.parse(await as(memberC, () => kbList({ confidence: [...MIXED] })));
    expect(ids(out.results)).toEqual(['bible-e1', dup].sort());
  });

  it('an id in both the bible and the per-repo DB appears once, as the bible copy', async () => {
    const out = JSON.parse(await as(memberA, () => kbList({ confidence: [...MIXED] })));
    const rows = (out.results as Array<{ id: string; title: string; confidence: string }>).filter(e => e.id === dup);
    expect(rows).toEqual([expect.objectContaining({ title: 'Sprocketmix duplicate bible copy', confidence: 'CONFIRMED' })]);
  });

  it('honours limit on the merged list', async () => {
    const out = JSON.parse(await as(memberA, () => kbList({ confidence: [...MIXED], limit: 2 })));
    expect(ids(out.results)).toEqual(['bible-e1', dup, e2].sort().slice(0, 2));
  });

  it('member B sees its own capture and the bible, not A\'s', async () => {
    const out = JSON.parse(await as(memberB, () => kbList({ confidence: ['CONFIRMED', 'INFERRED', 'UNVERIFIED'] })));
    expect(ids(out.results)).toEqual(['bible-e1', dup, e3].sort());
  });
});
