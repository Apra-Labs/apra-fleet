import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { getGlobalKbProvider } from '../../src/services/knowledge/kb-providers.js';
import { resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

// A MEMBER flagged_only kb_query reads the shared global KB, where every
// member's capture is tagged member:<id>. Another member's non-CONFIRMED
// flagged entry must not be served; the caller's own and untagged (FULL
// session) entries stay. A FULL session sees all three.

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let scratch: string;
let memberA: string;
let memberB: string;
let aId: string;
let bId: string;
let fullId: string;

const as = <T>(member: string | undefined, fn: () => Promise<T>): Promise<T> => runWithSessionMember(member, fn);

function flaggedInput(title: string, symbol: string, tags: string[]): KBEntryInput {
  return {
    type: 'knowledge', title, summary: `${title}: flagged global entry ${RUN}.`,
    content: `${title}: flagged global entry ${RUN}, distinct enough to avoid AUDN linking.`,
    source_files: [`src/${symbol}.ts`], symbols: [symbol], tags,
    content_hash: '', content_hash_type: 'sha256',
    flagged_for_review: true, author: 'doer', source: 'session', confidence: 'INFERRED',
  } as KBEntryInput;
}

beforeAll(async () => {
  backupAndResetRegistry();
  resetMemberBibleViews();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-member-flagged-'));
  const repo = path.join(scratch, 'checkout');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', `https://example.test/kb-member-flagged-${RUN}.git`], { cwd: repo });
  const a = makeTestLocalAgent({ friendlyName: `kb-flag-a-${RUN}`, workFolder: repo });
  const b = makeTestLocalAgent({ friendlyName: `kb-flag-b-${RUN}`, workFolder: repo });
  addAgent(a);
  addAgent(b);
  memberA = a.id;
  memberB = b.id;
  const global = await getGlobalKbProvider();
  aId = (await global.capture(flaggedInput(`Flagged alpha ${RUN}`, `flagA${RUN.replace(/\W/g, '')}`, [`member:${memberA}`]))).id;
  bId = (await global.capture(flaggedInput(`Flagged bravo ${RUN}`, `flagB${RUN.replace(/\W/g, '')}`, [`member:${memberB}`]))).id;
  fullId = (await global.capture(flaggedInput(`Flagged full ${RUN}`, `flagF${RUN.replace(/\W/g, '')}`, []))).id;
});

afterAll(() => {
  vi.restoreAllMocks();
  resetMemberBibleViews();
  restoreRegistry();
  fs.rmSync(scratch, { recursive: true, force: true });
});

const flaggedIds = async (member: string | undefined): Promise<string[]> =>
  (JSON.parse(await as(member, () => kbQuery({ flagged_only: true }))).flagged_entries as Array<{ id: string }>).map(e => e.id);

describe('kb_query flagged_only over the global KB in a MEMBER session', () => {
  it('hides another member\'s flagged global capture; keeps the caller\'s own and the untagged one', async () => {
    const got = await flaggedIds(memberA);
    expect(got).not.toContain(bId);
    expect(got).toContain(aId);
    expect(got).toContain(fullId);
  });

  it('member B symmetrically hides A\'s', async () => {
    const got = await flaggedIds(memberB);
    expect(got).not.toContain(aId);
    expect(got).toContain(bId);
    expect(got).toContain(fullId);
  });

  it('a FULL session is unchanged: all three', async () => {
    const got = await flaggedIds(undefined);
    expect(got).toEqual(expect.arrayContaining([aId, bId, fullId]));
  });
});
