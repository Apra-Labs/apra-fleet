import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';

// win32-only: the remote bible view's PowerShell stat/cat branch for an os
// windows member. The stub runs the exact encoded-powershell commands the view
// builds through the host default shell (cmd.exe), against a real temp folder.
// Skipped (not failed) on linux/macos; the POSIX branch is covered by
// kb-remote-member-bible-view.test.ts.

const execLog: string[] = [];
vi.mock('../../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: (command: string) => new Promise((resolve, reject) => {
      execLog.push(command);
      exec(command, (err, stdout, stderr) => {
        if (err && typeof err.code !== 'number') { reject(new Error(`spawn ${String(err.code)}`)); return; }
        resolve({ stdout, stderr, code: err ? (err.code as number) : 0 });
      });
    }),
  }),
}));

import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let scratch: string;
let folder: string;
let memberId: string;

function entry(id: string): Record<string, unknown> {
  return {
    id, type: 'knowledge',
    title: `Sprocket gearbox fact ${id}`,
    summary: `Sprocket gearbox fact recorded as ${id}; the sprocket stage batches work.`,
    symbols: [], source_files: ['src/sprocket.ts'],
    confidence: 'CONFIRMED', updated_at: '2026-09-01T00:00:00.000Z',
  };
}
const bible = () => path.join(folder, '.fleet', 'kb-canonical.json');
const writeBible = (entries: unknown[]) =>
  fs.writeFileSync(bible(), JSON.stringify({ version: 2, entries }), 'utf-8');
const asMember = <T>(fn: () => Promise<T>) => runWithSessionMember(memberId, fn);
const ids = (rows: Array<{ id: string }>) => rows.map(r => r.id).sort();
const psCommands = () => execLog.filter(c => c.startsWith('powershell -EncodedCommand '));
const decode = (c: string) => Buffer.from(c.slice('powershell -EncodedCommand '.length), 'base64').toString('utf16le');
const cats = () => execLog.filter(c => decode(c).includes('ReadAllText')).length;

describe.skipIf(process.platform !== 'win32')('remote member bible view, PowerShell branch (os windows)', () => {
  beforeAll(() => {
    backupAndResetRegistry();
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-remote-bible-win-'));
    folder = path.join(scratch, 'remote-checkout');
    fs.mkdirSync(path.join(folder, '.fleet'), { recursive: true });
    const agent = makeTestAgent({
      friendlyName: `kb-remote-win-${RUN}`, workFolder: folder, os: 'windows', shell: 'powershell5',
      gitRepos: [`https://example.test/kb-remote-bible-win-${RUN}.git`],
    });
    addAgent(agent);
    memberId = agent.id;
  });
  afterAll(() => {
    resetMemberBibleViews();
    restoreRegistry();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  beforeEach(() => { resetMemberBibleViews(); execLog.length = 0; });

  it('uses encoded powershell commands, serves the bible, refetches only on change', async () => {
    writeBible([entry('w-1'), entry('w-2')]);
    const out = JSON.parse(await asMember(() => kbQuery({ query: 'sprocket gearbox' })));
    expect(ids(out.l1_results)).toEqual(['w-1', 'w-2']);
    expect(execLog.length).toBeGreaterThan(0);
    expect(psCommands().length).toBe(execLog.length);
    expect(execLog.some(c => c.startsWith('cat '))).toBe(false);
    expect(cats()).toBe(1);

    await asMember(() => kbQuery({ query: 'sprocket gearbox' }));
    expect(cats()).toBe(1);

    writeBible([entry('w-1'), entry('w-2'), entry('w-3')]);
    const out2 = JSON.parse(await asMember(() => kbQuery({ query: 'sprocket gearbox' })));
    expect(ids(out2.l1_results)).toEqual(['w-1', 'w-2', 'w-3']);
    expect(cats()).toBe(2);
  });
});
