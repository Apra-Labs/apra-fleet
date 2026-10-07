import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { getKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { requireSqliteProject } from '../../src/services/knowledge/require-sqlite-project.js';
import { resetMemberBibleViews, KbMemberViewError } from '../../src/services/knowledge/member-bible-view.js';
import type { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntry } from '../../src/services/knowledge/types.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { kbList } from '../../src/tools/kb-list.js';
import { kbContext } from '../../src/tools/kb-context.js';
import { kbSessionPrime } from '../../src/tools/kb-session-prime.js';
import { kbPromote } from '../../src/tools/kb-promote.js';
import { kbInvalidate } from '../../src/tools/kb-invalidate.js';
import { kbFreshnessSweep } from '../../src/tools/kb-freshness-sweep.js';
import { kbFeedback } from '../../src/tools/kb-feedback.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

// MEMBER-session writes and own-scope operations, all on the machine's per-repo
// DB: captures are tagged member:<caller uuid>; an explicit INFERRED/UNVERIFIED
// read, kb_promote and kb_invalidate see only the caller's own entries;
// kb_feedback is a typed read-only no-op. Two members share one machine and one
// checkout (hence one per-repo DB) so only the own-scope rule separates them.

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const UNCONFIRMED = ['INFERRED', 'UNVERIFIED'] as const;
const REASON = 'Verified against src/gizmo.ts: the gizmo stage batches work per tick.';

let scratch: string;
let repo: string;
let memberA: string;
let memberB: string;
let db: SqliteProvider;

const asA = <T>(fn: () => Promise<T>): Promise<T> => runWithSessionMember(memberA, fn);
const asB = <T>(fn: () => Promise<T>): Promise<T> => runWithSessionMember(memberB, fn);
const asFull = <T>(fn: () => Promise<T>): Promise<T> => runWithSessionMember(undefined, fn);
const ids = (rows: Array<{ id: string }>) => rows.map(r => r.id);

function row(id: string): KBEntry | undefined {
  return (db as unknown as { getDb(): { prepare(s: string): { get(...a: unknown[]): unknown } } })
    .getDb().prepare('SELECT * FROM entries WHERE id = ?').get(id) as KBEntry | undefined;
}
function rowCount(): number {
  return ((db as unknown as { getDb(): { prepare(s: string): { get(): unknown } } })
    .getDb().prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n;
}

async function capture(as: typeof asA, title: string, over: Record<string, unknown> = {}): Promise<string> {
  const out = JSON.parse(await as(() => kbCapture({
    type: 'knowledge',
    title,
    summary: `${title}: the gizmo stage batches work per tick.`,
    content: `${title}: the gizmo stage batches work per tick, observed in src/gizmo.ts.`,
    source_files: ['src/gizmo.ts'],
    ...over,
  } as Parameters<typeof kbCapture>[0])));
  return out.id as string;
}

let aKnowledge: string;
let bKnowledge: string;
let aCtx: string;
let bCtx: string;

beforeAll(async () => {
  backupAndResetRegistry();
  resetMemberBibleViews();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-member-own-'));
  repo = path.join(scratch, 'checkout');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'gizmo.ts'), 'export const gizmo = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', `https://example.test/kb-member-own-${RUN}.git`], { cwd: repo });

  const a = makeTestLocalAgent({ friendlyName: `kb-own-a-${RUN}`, workFolder: repo });
  const b = makeTestLocalAgent({ friendlyName: `kb-own-b-${RUN}`, workFolder: repo });
  addAgent(a);
  addAgent(b);
  memberA = a.id;
  memberB = b.id;
  db = requireSqliteProject((await getKbProviders(repo)).project, 'test');

  aKnowledge = await capture(asA, 'Gizmo alpha fact', { tags: ['caller-tag'] });
  bKnowledge = await capture(asB, 'Gizmo bravo fact', { symbols: ['bravoOnly'] });
  aCtx = await capture(asA, 'Gizmo alpha context', { type: 'context-cache' });
  bCtx = await capture(asB, 'Gizmo bravo context', { type: 'context-cache', symbols: ['bravoCtx'] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  resetMemberBibleViews();
  restoreRegistry();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('kb_capture in a MEMBER session', () => {
  it('stores the entry in the per-repo DB tagged member:<caller uuid>, after the caller tags', () => {
    expect(row(aKnowledge)).toBeDefined();
    expect(JSON.parse(row(aKnowledge)!.tags as unknown as string)).toEqual(['caller-tag', `member:${memberA}`]);
    expect(JSON.parse(row(bKnowledge)!.tags as unknown as string)).toEqual([`member:${memberB}`]);
  });

  it('keeps the directive quarantine: a member directive is pending AND own-tagged', async () => {
    const id = await capture(asA, 'Always batch gizmos', { type: 'user-directive' });
    const tags = JSON.parse(row(id)!.tags as unknown as string);
    expect(tags).toEqual(expect.arrayContaining(['directive:pending', `member:${memberA}`]));
    expect(row(id)!.confidence).toBe('UNVERIFIED');
  });

  it('a FULL session capture carries no member tag', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(repo);
    const id = await capture(asFull, 'Gizmo full-session fact', { symbols: ['fullOnly'] });
    expect(JSON.parse(row(id)!.tags as unknown as string)).toEqual([]);
  });
});

describe('explicit INFERRED/UNVERIFIED reads return only the caller\'s own entries', () => {
  it('kb_query', async () => {
    const a = JSON.parse(await asA(() => kbQuery({ query: 'gizmo', confidence: [...UNCONFIRMED], expand_related: true })));
    expect(ids(a.l1_results).sort()).toEqual([aCtx, aKnowledge].sort());
    expect(a.related_claims.every((e: { tags: string[] }) => e.tags.includes(`member:${memberA}`))).toBe(true);
    const b = JSON.parse(await asB(() => kbQuery({ query: 'gizmo', confidence: ['INFERRED'] })));
    expect(ids(b.l1_results).sort()).toEqual([bCtx, bKnowledge].sort());
  });

  it('kb_list (an explicit tag filter is ANDed with the own scope)', async () => {
    const a = JSON.parse(await asA(() => kbList({ confidence: ['INFERRED'] })));
    expect(ids(a.results).sort()).toEqual([aCtx, aKnowledge].sort());
    const b = JSON.parse(await asB(() => kbList({ confidence: ['INFERRED'], tag: 'caller-tag' })));
    expect(b.results).toEqual([]);
  });

  it('kb_context', async () => {
    const hits = async (as: typeof asA) => {
      const out = JSON.parse(await as(() => kbContext({ files: ['src/gizmo.ts'], confidence: ['INFERRED'] })));
      return [...out.fresh, ...out.stale].map((r: { entry_id: string }) => r.entry_id);
    };
    expect(await hits(asA)).toEqual([aCtx]);
    expect(await hits(asB)).toEqual([bCtx]);
  });

  it('kb_context DEFAULT (no confidence) in a MEMBER session includes the member\'s own INFERRED cache entry, never another member\'s', async () => {
    // kb_context's default tier set is CONFIRMED + INFERRED; in a MEMBER
    // session the INFERRED half is answered from the per-repo DB own-tagged
    // and merged with the checkout bible's CONFIRMED entries.
    const hits = async (as: typeof asA) => {
      const out = JSON.parse(await as(() => kbContext({ files: ['src/gizmo.ts'] })));
      return [...out.fresh, ...out.stale].map((r: { entry_id: string }) => r.entry_id);
    };
    expect(await hits(asA)).toEqual([aCtx]);
    expect(await hits(asB)).toEqual([bCtx]);
  });

  it('kb_session_prime (no bible cold-seed of other entries)', async () => {
    const a = JSON.parse(await asA(() => kbSessionPrime({ hint_modules: ['gizmo'], confidence: ['INFERRED'] })));
    expect(ids(a.top_entries)).toEqual([aKnowledge]);
    const b = JSON.parse(await asB(() => kbSessionPrime({ hint_modules: ['gizmo'], confidence: ['INFERRED'] })));
    expect(ids(b.top_entries)).toEqual([bKnowledge]);
  });

  it('a FULL session explicit INFERRED read is unchanged (sees every member\'s entries)', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(repo);
    const out = JSON.parse(await asFull(() => kbList({ confidence: ['INFERRED'] })));
    expect(ids(out.results)).toEqual(expect.arrayContaining([aKnowledge, bKnowledge, aCtx, bCtx]));
  });
});

// A CONFIRMED read in a MEMBER session answers from the checkout bible view
// by default (kb-self.ts getSelfReadKb), and every bible-view row is imported
// with tags: [] (bible-import.ts) -- so tag: 'member:<id>' can never match
// there, and demotionCandidates-style reads always come back empty. This
// fails against pre-fix routing: own_scope did not exist, so the only way to
// ask for "my own CONFIRMED rows" was the unsatisfiable bible-view tag filter.
describe('own_scope: true reads the caller\'s own CONFIRMED rows from the per-repo DB', () => {
  const biblePath = (): string => path.join(repo, '.fleet', 'kb-canonical.json');
  let aConfirmed: string;
  let bConfirmed: string;

  beforeAll(async () => {
    aConfirmed = await capture(asA, 'Gizmo alpha confirmed fact');
    await asA(() => kbPromote({ id: aConfirmed, reason: REASON }));
    bConfirmed = await capture(asB, 'Gizmo bravo confirmed fact');
    await asB(() => kbPromote({ id: bConfirmed, reason: REASON }));
    // The falsification below needs a NON-EMPTY bible. With no bible file at
    // all the default CONFIRMED read returns nothing for any reason at all --
    // including a view that never loaded -- so "zero rows" would prove
    // nothing. Publishing A's own row into A's checkout bible makes the
    // default read demonstrably LIVE, and the row it then serves carries
    // tags: [] (importBibleEntries stamps every imported entry that way),
    // which is exactly why an own-tagged CONFIRMED read can never be
    // satisfied from the view.
    fs.mkdirSync(path.dirname(biblePath()), { recursive: true });
    fs.writeFileSync(biblePath(), JSON.stringify({
      entries: [{
        id: aConfirmed,
        type: 'knowledge',
        title: 'Gizmo alpha confirmed fact',
        summary: 'Gizmo alpha confirmed fact: the gizmo stage batches work per tick.',
        symbols: [],
        source_files: ['src/gizmo.ts'],
        confidence: 'CONFIRMED',
        updated_at: '2026-10-07T00:00:00.000Z',
      }],
    }));
    resetMemberBibleViews();
  });

  afterAll(() => {
    fs.rmSync(biblePath(), { force: true });
    resetMemberBibleViews();
  });

  it('the default CONFIRMED read is served by a LIVE bible view whose row is untagged, so an own-tagged read there is unsatisfiable', async () => {
    // The view really does answer, and it answers with the row stripped of
    // every tag -- the two halves of "the bible view can never satisfy
    // tag: member:<id>".
    const live = JSON.parse(await asA(() => kbQuery({ query: 'gizmo', limit: 50 })));
    expect(ids(live.l1_results)).toContain(aConfirmed);
    expect(live.l1_results.find((e: { id: string }) => e.id === aConfirmed).tags).toEqual([]);

    const out = JSON.parse(await asA(() => kbQuery({ query: 'gizmo', tag: `member:${memberA}` })));
    expect(ids(out.l1_results)).toEqual([]);
    const l = JSON.parse(await asA(() => kbList({ tag: `member:${memberA}` })));
    expect(ids(l.results)).toEqual([]);
  });

  it('kb_query own_scope: true reads the row back, and never another member\'s', async () => {
    const a = JSON.parse(await asA(() => kbQuery({ query: 'gizmo', own_scope: true })));
    expect(ids(a.l1_results)).toContain(aConfirmed);
    expect(ids(a.l1_results)).not.toContain(bConfirmed);
    const b = JSON.parse(await asB(() => kbQuery({ query: 'gizmo', own_scope: true })));
    expect(ids(b.l1_results)).toContain(bConfirmed);
    expect(ids(b.l1_results)).not.toContain(aConfirmed);
  });

  it('another member\'s row is indistinguishable from one that does not exist', async () => {
    // Not merely "absent from the list": the WHOLE response for a term only
    // B's row carries is byte-identical to the response for a term no entry
    // anywhere carries, so nothing in it -- no error, no count, no extra
    // field -- discloses that B's entry exists.
    const foreign = await asA(() => kbQuery({ query: 'bravo', limit: 50, own_scope: true }));
    const absent = await asA(() => kbQuery({ query: 'zzznosuchtermanywhere', limit: 50, own_scope: true }));
    expect(foreign).toBe(absent);
    const out = JSON.parse(foreign);
    expect(Object.keys(out).sort()).toEqual(['l1_results', 'l2_expanded']);
    expect(out.l1_results).toEqual([]);
    expect(foreign).not.toContain(bConfirmed);
    expect(foreign).not.toContain(memberB);
  });

  it('own_scope has no effect for a FULL session (already reads the per-repo DB)', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(repo);
    const out = JSON.parse(await asFull(() => kbQuery({ query: 'gizmo', own_scope: true })));
    expect(ids(out.l1_results)).toEqual(expect.arrayContaining([aConfirmed, bConfirmed]));
  });
});

describe('kb_promote in a MEMBER session acts only on own entries', () => {
  it('promoting another member\'s entry is the same typed not-found as an unknown id, and changes nothing', async () => {
    const before = row(aKnowledge);
    const unknown = await asB(() => kbPromote({ id: 'no-such-entry', reason: REASON })).catch(e => e as Error);
    const foreign = await asB(() => kbPromote({ id: aKnowledge, reason: REASON })).catch(e => e as Error);
    expect(unknown).toBeInstanceOf(Error);
    expect(foreign).toBeInstanceOf(Error);
    expect(foreign.message).toBe(unknown.message.replace('no-such-entry', aKnowledge));
    expect(foreign.message).toBe(`Entry not found: ${aKnowledge}`);
    expect(row(aKnowledge)).toEqual(before);
  });

  it('promoting an own entry works', async () => {
    const out = JSON.parse(await asB(() => kbPromote({ id: bKnowledge, reason: REASON })));
    expect(out).toMatchObject({ id: bKnowledge, previous_confidence: 'INFERRED', new_confidence: 'CONFIRMED' });
  });
});

describe('kb_invalidate {files} in a MEMBER session acts only on own entries', () => {
  it('invalidates the caller\'s context-cache entry for the file and leaves the other member\'s untouched', async () => {
    const bBefore = row(bCtx);
    const out = JSON.parse(await asA(() => kbInvalidate({ files: ['src/gizmo.ts'] })));
    expect(out.invalidated).toBe(1);
    expect(row(aCtx)).toMatchObject({ stale: 1, content_hash: 'invalidated' });
    expect(row(bCtx)).toEqual(bBefore);
  });
});

describe('kb_feedback in a MEMBER session', () => {
  it('is a typed no-op: E-MEMBER-VIEW-READ-ONLY, the DB unchanged', async () => {
    const countBefore = rowCount();
    const targetBefore = row(aKnowledge);
    const err = await asA(() => kbFeedback({ id: aKnowledge, reason: 'This claim proved wrong in practice.' })).catch(e => e);
    expect(err).toBeInstanceOf(KbMemberViewError);
    expect(err.code).toBe('E-MEMBER-VIEW-READ-ONLY');
    expect(err.message).toMatch(/Remediation: /);
    expect(rowCount()).toBe(countBefore);
    expect(row(aKnowledge)).toEqual(targetBefore);
  });
});

// THE ELIGIBILITY SET THE DEMOTION LANE NEEDS.
//
// SqliteProvider.demote() refuses, in order: an unknown id or one not carrying
// the caller's ownerTag, a superseded entry (E-DEMOTE-SUPERSEDED), a
// user-directive, a non-CONFIRMED entry, then the reason floor. There is
// deliberately NO stale refusal and no disputed refusal -- staleness is a
// freshness verdict while trust is a separate axis, and a row the sweep has
// already staled, or that something now contradicts, is exactly the kind most
// worth demoting. So the own-scope read must be able to EXPRESS that set.
//
// own_scope does NOT move any default to get there: the default query path
// still drops stale rows, and (with no explicit confidence list) disputed ones
// too. The caller widens the read with include_stale plus an explicit
// confidence list -- which is what turns exclude_disputed off. include_stale
// also admits SUPERSEDED rows, which demote() does refuse, so dropping those
// is the caller's job; the contract text says so rather than leaving it
// implicit.
describe('own_scope: the eligibility set kb_demote accepts is expressible', () => {
  let staleId: string;
  let flaggedId: string;
  let supersededId: string;
  let freshId: string;

  // The widening the demotion lane applies: include_stale admits the swept-
  // stale rows, and an explicit confidence list is what turns exclude_disputed
  // off so a contradiction-flagged row survives.
  const widened = () => ({ limit: 50, own_scope: true, include_stale: true, confidence: ['CONFIRMED'] as ('CONFIRMED')[] });

  beforeAll(async () => {
    const file = (name: string, body: string): void =>
      fs.writeFileSync(path.join(repo, 'src', name), body);
    file('sprocket-stale.ts', 'export const sprocketCache = 1;\n');
    file('sprocket-flag.ts', 'export const sprocketStage = 1;\n');
    file('sprocket-flag-v2.ts', 'export const sprocketStage = 2;\n');
    file('sprocket-drop.ts', 'export const sprocketQueue = 1;\n');
    file('sprocket-fresh.ts', 'export const sprocketMeter = 1;\n');

    // Each fixture carries its OWN symbol, so the contradiction capture below
    // (which needs symbol overlap) can only ever match the one it targets.
    const ownConfirmed = async (over: Record<string, unknown>): Promise<string> => {
      const out = JSON.parse(await asA(() => kbCapture({ type: 'knowledge', ...over } as Parameters<typeof kbCapture>[0])));
      expect(out.audn_decision).toBe('add');
      const promoted = JSON.parse(await asA(() => kbPromote({ id: out.id as string, reason: REASON })));
      expect(promoted.new_confidence).toBe('CONFIRMED');
      return out.id as string;
    };

    staleId = await ownConfirmed({
      title: 'Sprocket cache warms on the first tick',
      summary: 'The sprocket cache is populated during the first tick.',
      content: 'The sprocket cache is populated during the first tick, observed in src/sprocket-stale.ts.',
      source_files: ['src/sprocket-stale.ts'], symbols: ['sprocketCache'],
    });
    flaggedId = await ownConfirmed({
      title: 'Sprocket stage is broken in module Alpha',
      summary: 'The sprocket stage throws under load in module Alpha.',
      content: 'The sprocket stage is broken when called concurrently.',
      source_files: ['src/sprocket-flag.ts'], symbols: ['sprocketStage'],
    });
    supersededId = await ownConfirmed({
      title: 'Sprocket queue drains on shutdown',
      summary: 'The sprocket queue is drained during shutdown.',
      content: 'The sprocket queue is drained during shutdown, observed in src/sprocket-drop.ts.',
      source_files: ['src/sprocket-drop.ts'], symbols: ['sprocketQueue'],
    });
    freshId = await ownConfirmed({
      title: 'Sprocket meter samples every tick',
      summary: 'The sprocket meter takes one sample per tick.',
      content: 'The sprocket meter takes one sample per tick, observed in src/sprocket-fresh.ts.',
      source_files: ['src/sprocket-fresh.ts'], symbols: ['sprocketMeter'],
    });

    // STALE: rewrite the stored basis file and run the REAL freshness sweep.
    file('sprocket-stale.ts', 'export const sprocketCache = 2;\n');
    const sweep = JSON.parse(await asA(() => kbFreshnessSweep({})));
    expect(sweep.staled).toBe(1);
    expect(row(staleId)!.stale).toBe(1);

    // CONTRADICTION-FLAGGED: a real opposite-polarity capture on the same
    // symbol. The flag lands on the OLDER entry, which keeps its CONFIRMED
    // tier and its member tag.
    const challenger = JSON.parse(await asA(() => kbCapture({
      type: 'knowledge',
      title: 'Sprocket stage is fixed in module Beta',
      summary: 'The sprocket stage now works correctly in module Beta.',
      content: 'The sprocket stage is fixed as of the latest release.',
      source_files: ['src/sprocket-flag-v2.ts'], symbols: ['sprocketStage'],
    })));
    expect(challenger.audn_decision).toBe('flagged');
    expect(row(flaggedId)!.flagged_for_review).toBe(1);
    expect(row(flaggedId)!.confidence).toBe('CONFIRMED');

    // SUPERSEDED: a real discard by id, in the owner's own session.
    const discarded = JSON.parse(await asA(() => kbInvalidate({ ids: [supersededId] })));
    expect(discarded.discarded).toEqual([supersededId]);
    expect(row(supersededId)!.superseded_at).not.toBeNull();
  });

  it('the DEFAULT own_scope read still drops stale, disputed and superseded rows (own_scope moves no default)', async () => {
    const out = JSON.parse(await asA(() => kbQuery({ query: 'sprocket', limit: 50, own_scope: true })));
    expect(ids(out.l1_results)).toContain(freshId);
    expect(ids(out.l1_results)).not.toContain(staleId);
    expect(ids(out.l1_results)).not.toContain(flaggedId);
    expect(ids(out.l1_results)).not.toContain(supersededId);
  });

  it('a STALE owned CONFIRMED row and a CONTRADICTION-FLAGGED one are both reachable through this path', async () => {
    const out = JSON.parse(await asA(() => kbQuery({ query: 'sprocket', ...widened() })));
    expect(ids(out.l1_results)).toEqual(expect.arrayContaining([staleId, flaggedId, freshId]));
  });

  it('the widened read also admits SUPERSEDED rows, which kb_demote refuses -- the caller drops those', async () => {
    const out = JSON.parse(await asA(() => kbQuery({ query: 'sprocket', ...widened() })));
    expect(ids(out.l1_results)).toContain(supersededId);
  });

  it('the widened read stays owner-isolated, and is still empty without the opt-in', async () => {
    const b = JSON.parse(await asB(() => kbQuery({ query: 'sprocket', ...widened() })));
    expect(ids(b.l1_results)).toEqual([]);
    const noOptIn = JSON.parse(await asA(() => kbQuery({
      query: 'sprocket', limit: 50, tag: `member:${memberA}`,
      confidence: ['CONFIRMED'], include_stale: true,
    })));
    expect(ids(noOptIn.l1_results)).toEqual([]);
  });
});
