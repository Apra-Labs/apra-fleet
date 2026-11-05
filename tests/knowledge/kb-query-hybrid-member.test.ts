import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import { kbQuery, kbQuerySchema } from '../../src/tools/kb-query.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

// Hybrid kb_query inputs in a real MEMBER session (no kb-self stubs): the
// CONFIRMED-only read (member checkout bible view) and the member split read
// (CONFIRMED from the bible view + the member's own INFERRED captures) both
// accept files / symbols / error_text, pass them to every half, and keep the
// fixed bible-then-own merge order.
//
// Isolation: tests/setup.ts points APRA_FLEET_DATA_DIR at a per-run temp dir;
// the registry is backed up and restored; the checkout lives under one
// scratch root removed in afterAll.

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const SCOPE_ERROR = 'Resource not accessible by integration';
const TITLE = 'Harbor ledger settlement order';
const SUMMARY = 'harbor ledger settles inbound before outbound';

let scratch: string;
let repo: string;
let member: string;
let ownErrorId: string;

const as = <T>(fn: () => Promise<T>): Promise<T> => runWithSessionMember(member, fn);
type Out = { l1_results: Array<{ id: string }>; l2_expanded: Array<{ id: string }> };
const memberQuery = async (args: Record<string, unknown>): Promise<Out> =>
  JSON.parse(await as(() => kbQuery(kbQuerySchema.parse(args))));
const ids = (o: Out) => o.l1_results.map(r => r.id);

function bibleEntry(id: string, file: string): Record<string, unknown> {
  return {
    id, type: 'knowledge', title: TITLE, summary: SUMMARY,
    symbols: [], source_files: [file], confidence: 'CONFIRMED', updated_at: '2026-09-01T00:00:00.000Z',
  };
}

beforeAll(async () => {
  backupAndResetRegistry();
  resetMemberBibleViews();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-hybrid-member-'));
  repo = path.join(scratch, 'checkout');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  for (const f of ['m.ts', 'n.ts', 'o.ts']) fs.writeFileSync(path.join(repo, 'src', f), `export const v = '${f}';\n`);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', `https://example.test/kb-hybrid-member-${RUN}.git`], { cwd: repo });
  const agent = makeTestLocalAgent({ friendlyName: `kb-hybrid-${RUN}`, workFolder: repo });
  addAgent(agent);
  member = agent.id;

  // Target first in the bible, decoys after: equal text, different files.
  const entries = [
    bibleEntry('hm-target', 'src/m.ts'),
    bibleEntry('hm-decoy-1', 'src/n.ts'),
    bibleEntry('hm-decoy-2', 'src/n.ts'),
  ];
  fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.fleet', 'kb-canonical.json'), JSON.stringify({ version: 2, entries }), 'utf-8');

  // The member's own INFERRED capture explaining the scope error.
  const own = JSON.parse(await as(() => kbCapture({
    type: 'learning', title: 'Re-mint the VCS token with push+pr',
    summary: 'A push-only token cannot open pull requests; provision it again with push+pr access.',
    content: 'A push-only token cannot open pull requests; provision it again with push+pr access.',
    source_files: ['src/o.ts'], symbols: [], error_signatures: [SCOPE_ERROR],
  } as Parameters<typeof kbCapture>[0])));
  ownErrorId = own.id;
});

afterAll(() => {
  resetMemberBibleViews();
  restoreRegistry();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('hybrid kb_query in a MEMBER session', () => {
  it('CONFIRMED-only read (bible view): files ranks the anchored entry first', async () => {
    const out = await memberQuery({ query: 'harbor ledger', files: ['src/m.ts'], limit: 10 });
    expect(ids(out)[0]).toBe('hm-target');
    expect(ids(out)).toEqual(expect.arrayContaining(['hm-decoy-1', 'hm-decoy-2']));
    const other = await memberQuery({ query: 'harbor ledger', files: ['src/n.ts'], limit: 10 });
    expect(ids(other)[0]).not.toBe('hm-target');
  });

  it('member split read accepts files, symbols and error_text; bible half first, own half after', async () => {
    const out = await memberQuery({
      query: 'harbor ledger', files: ['src/m.ts'], symbols: ['Nothing.here'], error_text: SCOPE_ERROR,
      confidence: ['CONFIRMED', 'INFERRED'], limit: 20,
    });
    const got = ids(out);
    // Bible half (CONFIRMED) in its own hybrid order: the anchored entry first.
    expect(got[0]).toBe('hm-target');
    // Own half: the INFERRED capture found through error_text, after the bible half.
    expect(got).toContain(ownErrorId);
    const lastBible = Math.max(...['hm-target', 'hm-decoy-1', 'hm-decoy-2'].map(id => got.indexOf(id)));
    expect(got.indexOf(ownErrorId)).toBeGreaterThan(lastBible);
  });

  it('member split read with only error_text (no query) returns the own capture', async () => {
    const out = await memberQuery({ error_text: SCOPE_ERROR, confidence: ['CONFIRMED', 'INFERRED'], limit: 5 });
    expect(ids(out)).toContain(ownErrorId);
  });
});
