import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { getKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { requireSqliteProject } from '../../src/services/knowledge/require-sqlite-project.js';
import { importBibleEntries } from '../../src/services/knowledge/bible-import.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';
import { resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import { kbQuery, MEMBER_DEFAULT_LIMIT, MEMBER_SLIM_ROW_KEYS } from '../../src/tools/kb-query.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';
import { BARE_BIBLE_PATH, loadQueries } from '../helpers/kb-recall-eval.js';

// MEMBER-session kb_query defaults: a member read that gives no limit returns
// at most MEMBER_DEFAULT_LIMIT slim rows (no content field) and no L2 content,
// CONFIRMED only. An explicit limit keeps the full row shape and L2 content,
// an explicit confidence list keeps its tiers, and FULL sessions are
// unchanged. The second block measures result size on the real query set
// (docs/kb-recall-measurements.md).

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const LONG = 'The gizmo stage batches work into fixed windows and flushes on idle. '.repeat(20);

let scratch: string;
let memberId: string;

const asMember = <T>(fn: () => Promise<T>): Promise<T> => runWithSessionMember(memberId, fn);
const asFull = <T>(fn: () => Promise<T>): Promise<T> => runWithSessionMember(undefined, fn);

function gizmo(i: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `bible-${String(i).padStart(2, '0')}`, type: 'knowledge',
    title: `Gizmo pipeline fact ${i}`,
    summary: `Gizmo pipeline fact ${i}: the gizmo stage batches work.`,
    content: LONG,
    symbols: [`gizmoStep${i}`], source_files: ['src/gizmo.ts'],
    confidence: 'CONFIRMED', updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

/**
 * A git checkout with an origin remote and the given bible. Every file a
 * bible entry cites is created, so the bible view's freshness basis matches.
 */
function makeCheckout(name: string, bible: { entries: Array<{ source_files?: string[] }> }): string {
  const repo = path.join(scratch, name);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'gizmo.ts'), 'export const gizmo = 1;\n');
  for (const e of bible.entries) {
    for (const f of e.source_files ?? []) {
      const abs = path.join(repo, f);
      if (fs.existsSync(abs)) continue;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `// ${f}\n`);
    }
  }
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', `https://example.test/kb-member-defaults-${name}-${RUN}.git`], { cwd: repo });
  fs.writeFileSync(path.join(repo, '.fleet', 'kb-canonical.json'), JSON.stringify(bible), 'utf-8');
  return repo;
}

beforeAll(() => {
  backupAndResetRegistry();
  resetMemberBibleViews();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-member-defaults-'));
});

afterAll(() => {
  resetMemberBibleViews();
  restoreRegistry();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('MEMBER kb_query defaults', () => {
  let repo: string;

  beforeAll(async () => {
    const bible = { version: 2, entries: Array.from({ length: 12 }, (_, i) => gizmo(i + 1)) };
    repo = makeCheckout('caps', bible);
    const agent = makeTestLocalAgent({ friendlyName: `kb-member-defaults-${RUN}`, workFolder: repo });
    addAgent(agent);
    memberId = agent.id;
    // The member's own INFERRED capture in the per-repo DB.
    const providers = await getKbProviders(repo);
    await requireSqliteProject(providers.project, 'test').capture({
      type: 'knowledge', title: 'Gizmo flush window own note', summary: 'Own note on the gizmo flush window.',
      content: 'Own note on the gizmo flush window.', source_files: ['src/gizmo.ts'], symbols: [], tags: [`member:${memberId}`],
      content_hash: '', content_hash_type: 'sha256', stale: false, flagged_for_review: false,
      author: 'test', source: 'doer', confidence: 'INFERRED', scope: 'project',
    } as KBEntryInput, { importMode: true, preferredId: 'own-inferred', verbatim: true });
  });

  it('no limit: at most the member cap, slim rows without content, CONFIRMED only, no L2 content', async () => {
    const out = JSON.parse(await asMember(() => kbQuery({ query: 'gizmo pipeline' })));
    expect(out.l1_results).toHaveLength(MEMBER_DEFAULT_LIMIT);
    for (const row of out.l1_results) {
      expect(Object.keys(row).sort()).toEqual([...MEMBER_SLIM_ROW_KEYS].sort());
      expect(row).not.toHaveProperty('content');
      expect(row.confidence).toBe('CONFIRMED');
    }
    expect(out.l2_expanded).toEqual([]);
  });

  it('explicit limit keeps its meaning: that many rows, full row shape, L2 content for the top 5', async () => {
    const out = JSON.parse(await asMember(() => kbQuery({ query: 'gizmo pipeline', limit: 10 })));
    expect(out.l1_results).toHaveLength(10);
    for (const row of out.l1_results) {
      expect(row).toHaveProperty('content');
      expect(row).toHaveProperty('tags');
      expect(row).toHaveProperty('flagged_for_review');
    }
    expect(out.l2_expanded).toHaveLength(5);
    for (const row of out.l2_expanded) expect(typeof row.content).toBe('string');
    expect(out.l2_expanded[0].content.length).toBeGreaterThan(0);
  });

  it('an explicit limit above the cap returns more rows than the default', async () => {
    const out = JSON.parse(await asMember(() => kbQuery({ query: 'gizmo pipeline', limit: 20 })));
    expect(out.l1_results).toHaveLength(12);
  });

  it('explicit confidence keeps its tiers: the own INFERRED capture is returned', async () => {
    const out = JSON.parse(await asMember(() => kbQuery({ query: 'flush window', confidence: ['CONFIRMED', 'INFERRED'] })));
    const ids = out.l1_results.map((r: { id: string }) => r.id);
    expect(ids).toContain('own-inferred');
    expect(out.l1_results.length).toBeLessThanOrEqual(MEMBER_DEFAULT_LIMIT);
    const own = out.l1_results.find((r: { id: string }) => r.id === 'own-inferred');
    expect(own.confidence).toBe('INFERRED');
    const onlyInferred = JSON.parse(await asMember(() => kbQuery({ query: 'flush window', confidence: ['INFERRED'] })));
    expect(onlyInferred.l1_results.map((r: { id: string }) => r.id)).toEqual(['own-inferred']);
  });

  it('an own_scope read keeps the full row shape (it needs tags to find what may be demoted)', async () => {
    const out = JSON.parse(await asMember(() => kbQuery({ query: 'flush window', own_scope: true, confidence: ['INFERRED'] })));
    expect(out.l1_results.map((r: { id: string }) => r.id)).toEqual(['own-inferred']);
    expect(out.l1_results[0].tags).toEqual([`member:${memberId}`]);
    expect(out.l2_expanded.map((r: { id: string }) => r.id)).toEqual(['own-inferred']);
  });

  it('a FULL session keeps the full defaults (20 rows, full shape, L2 content)', async () => {
    const providers = await getKbProviders(repo);
    await importBibleEntries(requireSqliteProject(providers.project, 'test'), Array.from({ length: 12 }, (_, i) => gizmo(i + 1)));
    const out = JSON.parse(await asFull(() => kbQuery({ query: 'gizmo pipeline' }, { folder: repo })));
    expect(out.l1_results.length).toBeGreaterThan(MEMBER_DEFAULT_LIMIT);
    expect(out.l1_results[0]).toHaveProperty('content');
    expect(out.l2_expanded).toHaveLength(5);
  });
});

function quantile(sorted: number[], q: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

describe('member kb_query result size on the real query set', () => {
  it('the default member read is much smaller than the previous default (explicit limit 20)', async () => {
    // The pinned bare bible, minus its carried hashes (they describe the
    // original files, not the stand-ins created here).
    const pinned = JSON.parse(fs.readFileSync(BARE_BIBLE_PATH, 'utf-8'));
    const bible = { version: 2, entries: pinned.entries.map(({ source_file_hashes: _h, ...e }: Record<string, unknown>) => e) };
    const repo = makeCheckout('sizes', bible);
    const agent = makeTestLocalAgent({ friendlyName: `kb-member-sizes-${RUN}`, workFolder: repo });
    addAgent(agent);
    const real = loadQueries().filter(q => q.source === 'real');
    const before: number[] = [];
    const after: number[] = [];
    await runWithSessionMember(agent.id, async () => {
      for (const q of real) {
        // limit: 20 is exactly the previous default read (explicit limits keep their meaning).
        before.push((await kbQuery({ query: q.query, limit: 20 })).length);
        after.push((await kbQuery({ query: q.query })).length);
      }
    });
    before.sort((a, b) => a - b);
    after.sort((a, b) => a - b);
    const m = { before: quantile(before, 0.5), beforeP90: quantile(before, 0.9), after: quantile(after, 0.5), afterP90: quantile(after, 0.9) };
    console.log(`[kb-member-defaults] real queries=${real.length} result chars: before median ${m.before} p90 ${m.beforeP90}; after median ${m.after} p90 ${m.afterP90}`);
    expect(m.after).toBeLessThanOrEqual(m.before / 3);
    expect(m.afterP90).toBeLessThanOrEqual(m.beforeP90 / 3);
  }, 60_000);
});
