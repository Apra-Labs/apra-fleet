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
