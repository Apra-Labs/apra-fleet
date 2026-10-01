import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';

// A MEMBER session for a NON-local (ssh) member reads its checkout bible over
// the member transport. The transport is stubbed with a strategy that runs the
// exact commands the view builds in a real local shell, against a temp folder
// standing in for the member's host.

const execLog: string[] = [];
let transport: 'ok' | 'reject' | 'nonzero' = 'ok';
vi.mock('../../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: (command: string) => new Promise((resolve, reject) => {
      execLog.push(command);
      if (transport === 'reject') { reject(new Error('connect ETIMEDOUT')); return; }
      if (transport === 'nonzero') { resolve({ stdout: '', stderr: 'ssh: host unreachable', code: 255 }); return; }
      exec(command, { shell: '/bin/sh' }, (err, stdout, stderr) =>
        resolve({ stdout, stderr, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0 }));
    }),
  }),
}));

import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { kbStats } from '../../src/tools/kb-stats.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let scratch: string;
let folder: string;
let memberId: string;

function entry(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, type: 'knowledge',
    title: `Sprocket gearbox fact ${id}`,
    summary: `Sprocket gearbox fact recorded as ${id}; the sprocket stage batches work.`,
    symbols: [], source_files: ['src/sprocket.ts'],
    confidence: 'CONFIRMED', updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}
const bible = () => path.join(folder, '.fleet', 'kb-canonical.json');
const writeBible = (entries: unknown[]) =>
  fs.writeFileSync(bible(), JSON.stringify({ version: 2, entries }), 'utf-8');
const asMember = <T>(fn: () => Promise<T>) => runWithSessionMember(memberId, fn);
const ids = (rows: Array<{ id: string }>) => rows.map(r => r.id).sort();

beforeAll(() => {
  backupAndResetRegistry();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-remote-bible-'));
  folder = path.join(scratch, 'remote-checkout');
  fs.mkdirSync(path.join(folder, '.fleet'), { recursive: true });
  const agent = makeTestAgent({
    friendlyName: `kb-remote-${RUN}`, workFolder: folder, os: 'linux',
    gitRepos: [`https://example.test/kb-remote-bible-${RUN}.git`],
  });
  addAgent(agent);
  memberId = agent.id;
});
afterAll(() => {
  resetMemberBibleViews();
  restoreRegistry();
  fs.rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => { resetMemberBibleViews(); execLog.length = 0; transport = 'ok'; });

describe('MEMBER session on a remote (non-local) member reads its checkout bible', () => {
  it('kb_query and kb_stats serve the bible CONFIRMED set, no E-MEMBER-VIEW-REMOTE', async () => {
    writeBible([entry('r-1'), entry('r-2'), entry('r-inferred', { confidence: 'INFERRED' })]);
    const out = JSON.parse(await asMember(() => kbQuery({ query: 'sprocket gearbox' })));
    expect(ids(out.l1_results)).toEqual(['r-1', 'r-2']);
    const stats = await asMember(() => kbStats({}));
    expect(stats).not.toContain('E-MEMBER-VIEW-REMOTE');
    expect(JSON.parse(stats).totals.by_confidence.CONFIRMED).toBe(2);
  });

  it('refetches the bible only when mtime/size changed (one stat per read)', async () => {
    writeBible([entry('r-1')]);
    await asMember(() => kbQuery({ query: 'sprocket gearbox' }));
    const catsAfterFirst = execLog.filter(c => c.startsWith('cat ')).length;
    expect(catsAfterFirst).toBe(1);
    await asMember(() => kbQuery({ query: 'sprocket gearbox' }));
    expect(execLog.filter(c => c.startsWith('cat ')).length).toBe(1);

    writeBible([entry('r-1'), entry('r-3')]);
    const out = JSON.parse(await asMember(() => kbQuery({ query: 'sprocket gearbox' })));
    expect(ids(out.l1_results)).toEqual(['r-1', 'r-3']);
    expect(execLog.filter(c => c.startsWith('cat ')).length).toBe(2);
  });

  it('a malformed bible fails loudly instead of falling back to the per-repo DB', async () => {
    fs.rmSync(path.join(folder, '.fleet'), { recursive: true, force: true });
    fs.mkdirSync(path.join(folder, '.fleet'));
    fs.writeFileSync(bible(), '{ not json', 'utf-8');
    await expect(asMember(() => kbQuery({ query: 'sprocket' }))).rejects.toThrow(/E-BIBLE-MALFORMED|not valid JSON/);
  });

  it.each(['reject', 'nonzero'] as const)('an unreachable member (%s) fails with E-MEMBER-VIEW-REMOTE and never reads the per-repo DB', async mode => {
    writeBible([entry('r-1')]);
    transport = mode;
    await expect(asMember(() => kbQuery({ query: 'sprocket gearbox' }))).rejects.toThrow(/E-MEMBER-VIEW-REMOTE/);
    await expect(asMember(() => kbStats({}))).rejects.toThrow(/E-MEMBER-VIEW-REMOTE/);
    expect(execLog.every(c => !c.startsWith('cat '))).toBe(true);
  });
});
