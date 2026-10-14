import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { getKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { requireSqliteProject } from '../../src/services/knowledge/require-sqlite-project.js';
import { importBibleEntries } from '../../src/services/knowledge/bible-import.js';
import { resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { kbSessionPrime } from '../../src/tools/kb-session-prime.js';
import { kbList } from '../../src/tools/kb-list.js';
import { kbContext } from '../../src/tools/kb-context.js';
import { kbStats } from '../../src/tools/kb-stats.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

// MEMBER-session reads (kb_query, kb_session_prime, kb_list, kb_context,
// kb_stats) answer from the member's checkout bible view; FULL sessions and
// explicit INFERRED/UNVERIFIED requests keep reading the per-repo DB.
//
// One checkout serves BOTH sessions, so the only thing that differs between a
// member read and a FULL read is the routing: the bible on disk holds the
// 'bible-*' entries and the per-repo DB holds the 'repo-*' entries.

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const ALL_TIERS = ['CONFIRMED', 'INFERRED', 'UNVERIFIED'] as const;

let scratch: string;
let repo: string;
let memberId: string;

function entry(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, type: 'knowledge',
    title: `Gizmo pipeline fact ${id}`,
    summary: `Gizmo pipeline fact recorded as ${id}; the gizmo stage batches work.`,
    symbols: [], source_files: ['src/gizmo.ts'],
    confidence: 'CONFIRMED', updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

const BIBLE = [
  entry('bible-1'),
  entry('bible-2', { title: 'Gizmo pipeline retries bible-2' }),
  entry('bible-ctx', { type: 'context-cache', source_files: ['src/gizmo.ts'] }),
];
const REPO = [
  entry('repo-1', { title: 'Gizmo pipeline stage order repo-1' }),
  entry('repo-inferred', { title: 'Gizmo pipeline inferred note repo-inferred', confidence: 'INFERRED' }),
  entry('repo-ctx', { type: 'context-cache', source_files: ['src/other.ts'] }),
];

const asMember = <T>(fn: () => Promise<T>): Promise<T> => runWithSessionMember(memberId, fn);
const asFull = <T>(fn: () => Promise<T>): Promise<T> => runWithSessionMember(undefined, fn);
const ids = (rows: Array<{ id: string }>) => rows.map(r => r.id);

beforeAll(async () => {
  backupAndResetRegistry();
  resetMemberBibleViews();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-member-read-'));
  repo = path.join(scratch, 'checkout');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'gizmo.ts'), 'export const gizmo = 1;\n');
  fs.writeFileSync(path.join(repo, 'src', 'other.ts'), 'export const other = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', `https://example.test/kb-member-read-${RUN}.git`], { cwd: repo });
  fs.writeFileSync(path.join(repo, '.fleet', 'kb-canonical.json'), JSON.stringify({ version: 2, entries: BIBLE }), 'utf-8');

  const agent = makeTestLocalAgent({ friendlyName: `kb-member-read-${RUN}`, workFolder: repo });
  addAgent(agent);
  memberId = agent.id;

  // Seed the per-repo DB (the one a FULL session in this folder reads).
  const providers = await getKbProviders(repo);
  await importBibleEntries(requireSqliteProject(providers.project, 'test'), REPO);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  resetMemberBibleViews();
  restoreRegistry();
  fs.rmSync(scratch, { recursive: true, force: true });
});

function fullSessionInRepo(): void {
  vi.spyOn(process, 'cwd').mockReturnValue(repo);
}

describe('MEMBER session reads come from the checkout bible view', () => {
  it('kb_query', async () => {
    const out = JSON.parse(await asMember(() => kbQuery({ query: 'gizmo pipeline' })));
    expect(ids(out.l1_results).sort()).toEqual(['bible-1', 'bible-2', 'bible-ctx']);
  });

  it('kb_session_prime', async () => {
    const out = JSON.parse(await asMember(() => kbSessionPrime({ hint_modules: ['gizmo'] })));
    const top = ids(out.top_entries);
    expect(top).toEqual(expect.arrayContaining(['bible-1', 'bible-2']));
    expect(top).not.toContain('repo-1');
  });

  it('kb_list', async () => {
    const out = JSON.parse(await asMember(() => kbList({})));
    expect(ids(out.results).sort()).toEqual(['bible-1', 'bible-2', 'bible-ctx']);
  });

  it('kb_context', async () => {
    const out = JSON.parse(await asMember(() => kbContext({ files: ['src/gizmo.ts', 'src/other.ts'] })));
    const hits = [...out.fresh, ...out.stale].map((r: { entry_id: string }) => r.entry_id);
    expect(hits).toEqual(['bible-ctx']);
    expect(out.missing).toEqual(['src/other.ts']);
  });

  it('kb_stats reports the bible\'s CONFIRMED entry count', async () => {
    const out = JSON.parse(await asMember(() => kbStats({})));
    expect(out.totals.by_confidence.CONFIRMED).toBe(3);
    expect(out.totals.total).toBe(3);
    expect(out.bible).toMatchObject({ present: true, entries: 3 });
  });

  it('an explicit INFERRED/UNVERIFIED request goes to the per-repo DB, own captures only', async () => {
    // The per-repo 'repo-*' rows carry no member:<uuid> tag, so they are not
    // this member's own: the request returns neither the bible nor them.
    // Positive own-scope coverage: kb-member-own-scope.test.ts.
    const q = JSON.parse(await asMember(() => kbQuery({ query: 'gizmo pipeline', confidence: [...ALL_TIERS] })));
    expect(ids(q.l1_results)).toEqual([]);
    const l = JSON.parse(await asMember(() => kbList({ confidence: ['INFERRED'] })));
    expect(ids(l.results)).toEqual([]);
  });
});

describe('FULL session reads keep the per-repo DB', () => {
  it('kb_query', async () => {
    fullSessionInRepo();
    const out = JSON.parse(await asFull(() => kbQuery({ query: 'gizmo pipeline' })));
    expect(ids(out.l1_results).sort()).toEqual(['repo-1', 'repo-ctx']);
  });

  it('kb_session_prime', async () => {
    fullSessionInRepo();
    const out = JSON.parse(await asFull(() => kbSessionPrime({ hint_modules: ['gizmo'] })));
    const live = out.top_entries.filter((e: { via?: string }) => e.via === undefined);
    expect(ids(live)).toEqual(['repo-1']);
  });

  it('kb_list', async () => {
    fullSessionInRepo();
    const out = JSON.parse(await asFull(() => kbList({})));
    expect(ids(out.results).sort()).toEqual(['repo-1', 'repo-ctx']);
  });

  it('kb_context', async () => {
    fullSessionInRepo();
    const out = JSON.parse(await asFull(() => kbContext({ files: ['src/gizmo.ts', 'src/other.ts'] })));
    const hits = [...out.fresh, ...out.stale].map((r: { entry_id: string }) => r.entry_id);
    expect(hits).toEqual(['repo-ctx']);
    expect(out.missing).toEqual(['src/gizmo.ts']);
  });

  it('kb_stats', async () => {
    fullSessionInRepo();
    const out = JSON.parse(await asFull(() => kbStats({})));
    expect(out.totals.by_confidence).toMatchObject({ CONFIRMED: 2, INFERRED: 1 });
  });

  it('an explicit anchor in a MEMBER session (in-process caller) keeps the per-repo DB', async () => {
    const out = JSON.parse(await asMember(() => kbList({}, { folder: repo })));
    expect(ids(out.results).sort()).toEqual(['repo-1', 'repo-ctx']);
  });
});
