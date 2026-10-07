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
let transport: 'ok' | 'reject' | 'nonzero' | 'badshell' = 'ok';
vi.mock('../../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: (command: string) => new Promise((resolve, reject) => {
      execLog.push(command);
      if (transport === 'reject') { reject(new Error('connect ETIMEDOUT')); return; }
      if (transport === 'nonzero') { resolve({ stdout: '', stderr: 'ssh: host unreachable', code: 255 }); return; }
      const shell = transport === 'badshell' ? '/nonexistent/sh' : '/bin/sh';
      exec(command, { shell }, (err, stdout, stderr) => {
        // A spawn failure (non-numeric err.code, e.g. ENOENT) is a transport
        // error, not an exit status: surface it as a rejection.
        if (err && typeof err.code !== 'number') { reject(new Error(`spawn ${shell} ${String(err.code)}`)); return; }
        resolve({ stdout, stderr, code: err ? (err.code as number) : 0 });
      });
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

// The member is os linux and the stub execs POSIX commands via /bin/sh, which
// does not exist on win32: skip there (PowerShell branch is covered separately).
describe.skipIf(process.platform === 'win32')('MEMBER session on a remote (non-local) member reads its checkout bible', () => {
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

  // The REMOTE half of the tombstone rule; the local half and the two-clone
  // import live in tests/knowledge/kb-tombstone-import.test.ts. A demotion must
  // not be visible on one transport and invisible on the other.
  it('omits an entry carrying a demotion tombstone, over the member transport', async () => {
    fs.writeFileSync(bible(), JSON.stringify({
      version: 2,
      entries: [entry('r-keep'), entry('r-gone')],
      demotions: [{ id: 'r-gone', demoted_at: '2026-03-03T00:00:00.000Z' }],
    }), 'utf-8');

    const out = JSON.parse(await asMember(() => kbQuery({ query: 'sprocket gearbox' })));
    expect(ids(out.l1_results)).toEqual(['r-keep']);
    expect(ids(out.l1_results)).not.toContain('r-gone');
    // The tombstoned entry is not merely ranked lower: it is not in the view at
    // all, so it cannot be reached by any other read either.
    expect(JSON.parse(await asMember(() => kbStats({}))).totals.by_confidence.CONFIRMED).toBe(1);
  });

  it('a bible REWRITTEN to add a tombstone is re-fetched, not served from the cached slot', async () => {
    // What forces the reload: the remote view caches on the (mtime, size) the
    // member's stat command reports, and rebuilds when EITHER differs. SIZE is
    // the signal that can be relied on here -- recording a tombstone changes the
    // file length, whereas the POSIX stat branch reports mtime in whole SECONDS
    // (`stat -c '%Y %s'`), so two writes inside one second share an mtime.
    fs.writeFileSync(bible(), JSON.stringify({ version: 2, entries: [entry('r-keep'), entry('r-gone')] }), 'utf-8');
    const first = JSON.parse(await asMember(() => kbQuery({ query: 'sprocket gearbox' })));
    expect(ids(first.l1_results)).toEqual(['r-gone', 'r-keep']);
    const catsAfterFirst = execLog.filter(c => c.startsWith('cat ')).length;

    fs.writeFileSync(bible(), JSON.stringify({
      version: 2,
      entries: [entry('r-keep')],
      demotions: [{ id: 'r-gone', demoted_at: '2026-03-03T00:00:00.000Z' }],
    }), 'utf-8');

    const second = JSON.parse(await asMember(() => kbQuery({ query: 'sprocket gearbox' })));
    expect(execLog.filter(c => c.startsWith('cat ')).length).toBe(catsAfterFirst + 1);
    expect(ids(second.l1_results)).toEqual(['r-keep']);
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

  it('a spawn failure (missing shell) is reported as a spawn/reach error, not exit 1', async () => {
    writeBible([entry('r-1')]);
    transport = 'badshell';
    const err = await asMember(() => kbQuery({ query: 'sprocket gearbox' })).then(() => null, e => e as Error);
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/E-MEMBER-VIEW-REMOTE/);
    expect(err!.message).toMatch(/Could not reach member/);
    expect(err!.message).toMatch(/ENOENT/);
    expect(err!.message).not.toContain('exit 1');
  });
});
