import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// A MEMBER mixed-tier read whose per-repo KB is NOT sqlite (a remote HTTP KB
// selected by the KB config). The documented choice (kb-self.ts
// getMemberSplitRead): keep the typed refusal naming the tool, rather than
// answering with the bible half alone and silently dropping the tiers the
// caller asked for. A CONFIRMED-only request is unaffected (bible view).
//
// getKbProviders is wrapped so its `project` is a non-SqliteProvider object
// for this file only; everything else (bible view, global KB) is real.

const state = vi.hoisted(() => ({ nonSqlite: false }));

vi.mock('../../src/services/knowledge/kb-providers.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/knowledge/kb-providers.js')>();
  return {
    ...real,
    getKbProviders: async (...args: Parameters<typeof real.getKbProviders>) => {
      const providers = await real.getKbProviders(...args);
      if (!state.nonSqlite) return providers;
      const remote = new Proxy({}, {
        get: () => () => { throw new Error('the remote per-repo KB must not be queried'); },
      });
      return { ...providers, project: remote as typeof providers.project };
    },
  };
});

import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { kbList } from '../../src/tools/kb-list.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const MIXED = ['CONFIRMED', 'INFERRED'] as const;
const REFUSAL = /: this operation is not supported when the KB is backed by a remote HTTP provider/;

let scratch: string;
let memberId: string;
const asMember = <T>(fn: () => Promise<T>): Promise<T> => runWithSessionMember(memberId, fn);

beforeAll(() => {
  backupAndResetRegistry();
  resetMemberBibleViews();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-member-mixed-remote-'));
  const repo = path.join(scratch, 'checkout');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'cog.ts'), 'export const cog = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', `https://example.test/kb-member-mixed-remote-${RUN}.git`], { cwd: repo });
  fs.writeFileSync(path.join(repo, '.fleet', 'kb-canonical.json'), JSON.stringify({
    version: 2,
    entries: [{
      id: 'bible-cog', type: 'knowledge', title: 'Cogmix confirmed bible fact',
      summary: 'Cogmix confirmed bible fact: the cogmix stage batches work.',
      symbols: [], source_files: ['src/cog.ts'], confidence: 'CONFIRMED',
    }],
  }), 'utf-8');
  const agent = makeTestLocalAgent({ friendlyName: `kb-mixed-remote-${RUN}`, workFolder: repo });
  addAgent(agent);
  memberId = agent.id;
  state.nonSqlite = true;
});

afterAll(() => {
  state.nonSqlite = false;
  resetMemberBibleViews();
  restoreRegistry();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('MEMBER mixed-tier read over a non-sqlite per-repo KB: typed refusal', () => {
  it('kb_query refuses, naming the tool', async () => {
    const err = await asMember(() => kbQuery({ query: 'cogmix', confidence: [...MIXED] })).catch(e => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^kb_query/);
    expect(err.message).toMatch(REFUSAL);
  });

  it('kb_list refuses, naming the tool', async () => {
    const err = await asMember(() => kbList({ confidence: [...MIXED] })).catch(e => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^kb_list/);
    expect(err.message).toMatch(REFUSAL);
  });

  it('a CONFIRMED-only request still answers from the bible view', async () => {
    const q = JSON.parse(await asMember(() => kbQuery({ query: 'cogmix', confidence: ['CONFIRMED'] })));
    expect(q.l1_results.map((e: { id: string }) => e.id)).toEqual(['bible-cog']);
    const l = JSON.parse(await asMember(() => kbList({})));
    expect(l.results.map((e: { id: string }) => e.id)).toEqual(['bible-cog']);
  });
});
