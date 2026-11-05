import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import { importBibleEntries } from '../../src/services/knowledge/bible-import.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { getKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { requireSqliteProject } from '../../src/services/knowledge/require-sqlite-project.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

// Member kb_query defaults: with no `limit`, a MEMBER session gets at most 6
// slim L1 rows (id, title, summary, confidence, source_files) and L2 content
// for the top 3. An explicit limit always wins; a non-member (FULL) session
// keeps 20 rows, the full row shape and the top-5 L2.
//
// Isolation: tests/setup.ts points APRA_FLEET_DATA_DIR at a per-run temp dir;
// the registry is backed up and restored; the checkout lives under one
// scratch root removed in afterAll.

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const WORD = 'quorumwidget';
const BIBLE_COUNT = 24;
const SLIM_KEYS = ['confidence', 'id', 'source_files', 'summary', 'title'];

let scratch: string;
let repo: string;
let member: string;

const as = <T>(fn: () => Promise<T>): Promise<T> => runWithSessionMember(member, fn);

function bibleEntry(i: number): Record<string, unknown> {
  return {
    id: `qd-bible-${i}`, type: 'knowledge', title: `Quorumwidget confirmed fact number ${i}`,
    summary: `Fact ${i}: the ${WORD} stage batches work per tick.`,
    symbols: [`quorumSym${i}`], source_files: ['src/q.ts'],
    confidence: 'CONFIRMED', updated_at: '2026-09-01T00:00:00.000Z',
  };
}

beforeAll(async () => {
  backupAndResetRegistry();
  resetMemberBibleViews();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-member-defaults-'));
  repo = path.join(scratch, 'checkout');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'q.ts'), 'export const q = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', `https://example.test/kb-member-defaults-${RUN}.git`], { cwd: repo });
  const agent = makeTestLocalAgent({ friendlyName: `kb-defaults-${RUN}`, workFolder: repo });
  addAgent(agent);
  member = agent.id;

  const entries = Array.from({ length: BIBLE_COUNT }, (_, i) => bibleEntry(i));
  fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.fleet', 'kb-canonical.json'), JSON.stringify({ version: 2, entries }), 'utf-8');

  // The same entries in the per-repo DB, which a non-member (anchored) read uses.
  const db = requireSqliteProject((await getKbProviders(repo)).project, 'test');
  await importBibleEntries(db, entries, { verbatim: true });

  // The member's own INFERRED captures, for the mixed-tier read.
  for (let i = 0; i < 4; i++) {
    await as(() => kbCapture({
      type: 'knowledge', title: `Quorumwidget own capture ${i}`,
      summary: `Own ${i}: the ${WORD} stage retries per tick.`,
      content: `Own ${i}: the ${WORD} stage retries per tick, seen in src/q.ts.`,
      source_files: ['src/q.ts'], symbols: [`ownSym${i}`],
    } as Parameters<typeof kbCapture>[0]));
  }
});

afterAll(() => {
  resetMemberBibleViews();
  restoreRegistry();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('kb_query defaults by session kind', () => {
  it('MEMBER, no limit: 6 slim rows and 3 expanded entries', async () => {
    const out = JSON.parse(await as(() => kbQuery({ query: WORD })));
    expect(out.l1_results).toHaveLength(6);
    for (const row of out.l1_results) expect(Object.keys(row).sort()).toEqual(SLIM_KEYS);
    expect(out.l2_expanded).toHaveLength(3);
    // The expanded entries are full entries (they carry content).
    for (const e of out.l2_expanded) expect(typeof e.content).toBe('string');
    expect(out.l2_expanded.map((e: { id: string }) => e.id)).toEqual(out.l1_results.slice(0, 3).map((r: { id: string }) => r.id));
  });

  it('MEMBER with limit 9: 9 rows (explicit limit wins; row shape stays full)', async () => {
    const out = JSON.parse(await as(() => kbQuery({ query: WORD, limit: 9 })));
    expect(out.l1_results).toHaveLength(9);
    expect(Object.keys(out.l1_results[0]).length).toBeGreaterThan(SLIM_KEYS.length);
    expect(out.l2_expanded).toHaveLength(5);
  });

  it('MEMBER mixed-tier read (CONFIRMED + INFERRED): the defaults apply to the merged result', async () => {
    const out = JSON.parse(await as(() => kbQuery({ query: WORD, confidence: ['CONFIRMED', 'INFERRED'] })));
    // Per side the limit is 6; the project side merges the bible view and the own half.
    expect(out.l1_results.length).toBeLessThanOrEqual(6);
    expect(out.l1_results.length).toBeGreaterThan(0);
    for (const row of out.l1_results) expect(Object.keys(row).sort()).toEqual(SLIM_KEYS);
    expect(out.l2_expanded.length).toBeLessThanOrEqual(3);
  });

  it('MEMBER mixed-tier read with limit 9 returns up to 9 rows', async () => {
    const out = JSON.parse(await as(() => kbQuery({ query: WORD, limit: 9, confidence: ['CONFIRMED', 'INFERRED'] })));
    expect(out.l1_results.length).toBeGreaterThan(6);
    expect(out.l1_results.length).toBeLessThanOrEqual(9);
  });

  it('non-member (anchored) read, no limit: up to 20 rows, full row shape, 5 expanded entries', async () => {
    const out = JSON.parse(await kbQuery({ query: WORD }, { folder: repo }));
    expect(out.l1_results).toHaveLength(20);
    expect(Object.keys(out.l1_results[0]).length).toBeGreaterThan(SLIM_KEYS.length);
    expect(out.l1_results[0]).toHaveProperty('flagged_for_review');
    expect(out.l2_expanded).toHaveLength(5);
  });

  it('non-member read with an explicit limit keeps its shape', async () => {
    const out = JSON.parse(await kbQuery({ query: WORD, limit: 3 }, { folder: repo }));
    expect(out.l1_results).toHaveLength(3);
    expect(out.l1_results[0]).toHaveProperty('flagged_for_review');
  });
});
