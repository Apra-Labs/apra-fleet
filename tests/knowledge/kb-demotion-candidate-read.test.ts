import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { getKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { requireSqliteProject } from '../../src/services/knowledge/require-sqlite-project.js';
import { resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import type { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import { kbPromote } from '../../src/tools/kb-promote.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';
// The ENGINE's own read, imported rather than restated. This is the whole
// point of the file: fleet-sprint's demotionCandidates() is unit-tested
// against a fake kb_query, which can only ever confirm that the arguments it
// sends are the arguments it sends. Nothing there can notice that those
// arguments, run against the REAL kb_query, match no row in any real sprint --
// which is exactly the defect this bead reopened for. Importing the builder
// binds this test to the production arguments, so a change to them is
// re-verified here against a live member session.
import {
  buildDemotionCandidateQuery,
  isDemotableCandidate,
} from '../../packages/apra-fleet-se/fleet-sprint/kb.mjs';

// =============================================================================
// THE DEMOTION-CANDIDATE READ, END TO END, AGAINST A REAL MEMBER SESSION.
//
// fleet-sprint offers a reviewer the CONFIRMED entries it may demote back to
// INFERRED. The first implementation asked for them with
// `tag: member:<id>` + `confidence: ['CONFIRMED']` in a MEMBER session -- and
// that read is UNSATISFIABLE BY CONSTRUCTION, in every sprint:
//
//   getSelfReadKb (kb-self.ts) routes a MEMBER-session read that does not name
//   INFERRED/UNVERIFIED to the member's CHECKOUT BIBLE VIEW, and
//   importBibleEntries (bible-import.ts) stamps every row of that view
//   `tags: []`. There is no row in that view carrying any member tag, so the
//   owner filter matches nothing -- forever, silently, with no error.
//
// The reviewer was therefore offered zero demotion candidates in every real
// sprint while the fleet-sprint unit tests stayed green, because a fake
// kb_query answers whatever the fake was told to answer. This file closes that
// gap: it runs the engine's ACTUAL arguments through the ACTUAL kb_query in an
// ACTUAL member session, and asserts a real row comes back.
// =============================================================================

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const REASON = 'Verified against src/gizmo.ts: the gizmo stage batches work per tick.';

let scratch: string;
let repo: string;
let maintainer: string;
let otherMember: string;
let db: SqliteProvider;

const asMaintainer = <T>(fn: () => Promise<T>): Promise<T> => runWithSessionMember(maintainer, fn);
const asOther = <T>(fn: () => Promise<T>): Promise<T> => runWithSessionMember(otherMember, fn);
const ids = (rows: Array<{ id: string }>): string[] => rows.map(r => r.id);

function rawDb(): { prepare(s: string): { run(...a: unknown[]): unknown } } {
  return (db as unknown as { getDb(): { prepare(s: string): { run(...a: unknown[]): unknown } } }).getDb();
}

async function capture(
  as: typeof asMaintainer,
  title: string,
  over: Record<string, unknown> = {},
): Promise<string> {
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

/** A CONFIRMED row owned by `as`'s member (capture tags it, promote confirms it). */
async function confirmed(as: typeof asMaintainer, title: string, over: Record<string, unknown> = {}): Promise<string> {
  const id = await capture(as, title, over);
  await as(() => kbPromote({ id, reason: REASON }));
  return id;
}

/** The entry ids the engine would actually OFFER, given a changed-file set. */
function offered(rows: Array<Record<string, unknown>>, changedFiles: string[]): string[] {
  const fileSet = new Set(changedFiles);
  return rows
    .filter(e => isDemotableCandidate(e)
      && Array.isArray(e.source_files)
      && (e.source_files as string[]).some(f => fileSet.has(f)))
    .map(e => e.id as string);
}

const biblePath = (): string => path.join(repo, '.fleet', 'kb-canonical.json');

let plain: string;
let staleRow: string;
let supersededRow: string;
let directiveRow: string;
let inferredRow: string;
let foreignRow: string;

beforeAll(async () => {
  backupAndResetRegistry();
  resetMemberBibleViews();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-demote-cands-'));
  repo = path.join(scratch, 'checkout');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'gizmo.ts'), 'export const gizmo = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', `https://example.test/kb-demote-cands-${RUN}.git`], { cwd: repo });

  const m = makeTestLocalAgent({ friendlyName: `kb-demote-maint-${RUN}`, workFolder: repo });
  const o = makeTestLocalAgent({ friendlyName: `kb-demote-other-${RUN}`, workFolder: repo });
  addAgent(m);
  addAgent(o);
  maintainer = m.id;
  otherMember = o.id;
  db = requireSqliteProject((await getKbProviders(repo)).project, 'test');

  // The maintainer's own rows, one per eligibility case kb_demote decides.
  plain = await confirmed(asMaintainer, 'Gizmo plain confirmed fact');
  staleRow = await confirmed(asMaintainer, 'Gizmo stale confirmed fact');
  supersededRow = await confirmed(asMaintainer, 'Gizmo superseded confirmed fact');
  directiveRow = await confirmed(asMaintainer, 'Gizmo directive fact');
  // INFERRED: captured, never promoted.
  inferredRow = await capture(asMaintainer, 'Gizmo inferred fact');
  // Another member's CONFIRMED row in the SAME per-repo DB -- the own-scope
  // boundary. kb_demote would refuse it as "Entry not found".
  foreignRow = await confirmed(asOther, 'Gizmo foreign confirmed fact');

  // States the tools do not expose a write path for, set directly. `stale` and
  // the contradiction flag are deliberately NOT refusals in
  // SqliteProvider.demote() -- its own comment calls a stale entry one of the
  // ones most worth demoting -- while superseded_at IS (E-DEMOTE-SUPERSEDED).
  rawDb().prepare('UPDATE entries SET stale = 1, flagged_for_review = 1 WHERE id = ?').run(staleRow);
  rawDb().prepare('UPDATE entries SET superseded_at = ? WHERE id = ?').run('2026-10-01T00:00:00.000Z', supersededRow);
  rawDb().prepare("UPDATE entries SET type = 'user-directive' WHERE id = ?").run(directiveRow);

  // A LIVE, NON-EMPTY bible view for the falsification below. Without a bible
  // file the default CONFIRMED read returns nothing for every possible reason
  // -- including "the view never loaded" -- so "zero rows" would prove nothing
  // at all. Publishing the maintainer's own row into the checkout bible makes
  // the default read demonstrably live, and the row it then serves carries
  // tags: [], which is precisely why an own-tagged CONFIRMED read can never be
  // satisfied from there.
  fs.mkdirSync(path.dirname(biblePath()), { recursive: true });
  fs.writeFileSync(biblePath(), JSON.stringify({
    entries: [{
      id: plain,
      type: 'knowledge',
      title: 'Gizmo plain confirmed fact',
      summary: 'Gizmo plain confirmed fact: the gizmo stage batches work per tick.',
      symbols: [],
      source_files: ['src/gizmo.ts'],
      confidence: 'CONFIRMED',
      updated_at: '2026-10-07T00:00:00.000Z',
    }],
  }));
  resetMemberBibleViews();
});

afterAll(() => {
  resetMemberBibleViews();
  restoreRegistry();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("demotionCandidates' real read path", () => {
  it('returns the maintainer\'s own CONFIRMED rows from the per-repo DB -- NON-EMPTY, which is the whole fix', async () => {
    const out = JSON.parse(await asMaintainer(() => kbQuery(buildDemotionCandidateQuery(maintainer))));

    expect(out.l1_results.length).toBeGreaterThan(0);
    expect(ids(out.l1_results)).toContain(plain);
    // Every row really is the caller's own and really is CONFIRMED.
    for (const e of out.l1_results) {
      expect(e.confidence).toBe('CONFIRMED');
      expect(e.tags).toContain(`member:${maintainer}`);
    }
  });

  it('FALSIFICATION: the same read without own_scope -- the routing this replaced -- returns ZERO rows from a demonstrably LIVE bible view', async () => {
    // Half one: the default CONFIRMED read is genuinely answering, and the row
    // it answers with carries no tags.
    const live = JSON.parse(await asMaintainer(() => kbQuery({ query: 'gizmo', limit: 50 })));
    expect(ids(live.l1_results)).toContain(plain);
    expect(live.l1_results.find((e: { id: string }) => e.id === plain).tags).toEqual([]);

    // Half two: the engine's arguments, minus own_scope, against that live
    // view. This is the OLD read, and it matches nothing -- so every real
    // sprint offered the reviewer zero demotion candidates.
    const { own_scope: _dropped, ...oldRouting } = buildDemotionCandidateQuery(maintainer);
    const before = JSON.parse(await asMaintainer(() => kbQuery(oldRouting)));
    expect(before.l1_results).toEqual([]);
  });

  it('a STALE, contradiction-flagged CONFIRMED row IS returned -- the default read would have dropped it', async () => {
    const out = JSON.parse(await asMaintainer(() => kbQuery(buildDemotionCandidateQuery(maintainer))));
    expect(ids(out.l1_results)).toContain(staleRow);

    // Both halves of why: the default-trusted read drops stale rows, and an
    // explicit exclude_disputed drops the flagged one. kb_demote accepts both,
    // so excluding them discards the best candidates there are.
    const narrowed = JSON.parse(await asMaintainer(() => kbQuery({
      ...buildDemotionCandidateQuery(maintainer), include_stale: false,
    })));
    expect(ids(narrowed.l1_results)).not.toContain(staleRow);
    const undisputed = JSON.parse(await asMaintainer(() => kbQuery({
      ...buildDemotionCandidateQuery(maintainer), exclude_disputed: true,
    })));
    expect(ids(undisputed.l1_results)).not.toContain(staleRow);
  });

  it('the widened read DOES serve superseded rows, which is why the caller must drop them itself', async () => {
    const out = JSON.parse(await asMaintainer(() => kbQuery(buildDemotionCandidateQuery(maintainer))));
    // include_stale maps onto BOTH provider options (include_stale and
    // include_superseded), so this row arrives even though kb_demote refuses
    // it with E-DEMOTE-SUPERSEDED.
    expect(ids(out.l1_results)).toContain(supersededRow);
    expect(isDemotableCandidate(out.l1_results.find((e: { id: string }) => e.id === supersededRow))).toBe(false);
  });

  it('never serves another member\'s row, and never an unconfirmed one', async () => {
    const out = JSON.parse(await asMaintainer(() => kbQuery(buildDemotionCandidateQuery(maintainer))));
    expect(ids(out.l1_results)).not.toContain(foreignRow);
    expect(ids(out.l1_results)).not.toContain(inferredRow);
  });

  it('END TO END: the engine\'s read + its eligibility and changed-file filters offer exactly the demotable owned rows', async () => {
    const out = JSON.parse(await asMaintainer(() => kbQuery(buildDemotionCandidateQuery(maintainer))));

    // Every seeded row cites src/gizmo.ts, so the changed-file filter admits
    // all of them and what survives is decided purely by eligibility.
    expect(offered(out.l1_results, ['src/gizmo.ts']).sort()).toEqual([plain, staleRow].sort());

    // And nothing at all when the review's diff touches other files.
    expect(offered(out.l1_results, ['src/unrelated.ts'])).toEqual([]);
  });
});
