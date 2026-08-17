/**
 * apra-fleet-b4g.6: execute_prompt's auto-harvest must forward repo_remote_url
 * to kb_harvest whenever the dispatched member's registration record already
 * carries a genuine git remote URL (agent.gitRepos[0] already looks like a
 * URL) -- and must NOT forward anything, guess, or derive one, when it does
 * not (the common case today: gitRepos holds a bare "owner/repo" access
 * identifier, not a URL). See knownRepoRemoteUrl() in
 * src/tools/execute-prompt.ts.
 *
 * Style matches tests/execute-prompt-kb-harvest-repo-path.test.ts: spies on
 * the real kb-harvest module so it fails if the wiring regresses.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt, knownRepoRemoteUrl } from '../src/tools/execute-prompt.js';
import type { SSHExecResult } from '../src/types.js';

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: vi.fn().mockReturnValue('.claude/agents/pm'),
}));

const mockExecCommand = vi.fn<(cmd: string, timeout?: number, maxTotalMs?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

const mockKbHarvest = vi.fn().mockResolvedValue(JSON.stringify({ entries_captured: 0, entries_updated: 0, entries_skipped: 0 }));

vi.mock('../src/tools/kb-harvest.js', () => ({
  kbHarvest: mockKbHarvest,
}));

const successResponse = JSON.stringify({ result: 'session output to harvest', session_id: 'sess-harvest' });

// Fire-and-forget: `void import('./kb-harvest.js').then(...)` is not awaited
// by execute_prompt, so give the microtask queue a turn after executePrompt
// resolves before asserting on the spy.
async function flushMicrotasks(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 10));
}

describe('knownRepoRemoteUrl()', () => {
  it('forwards a gitRepos entry that already looks like a URL (https)', () => {
    const agent = makeTestAgent({ gitRepos: ['https://github.com/acme/repo.git'] });
    expect(knownRepoRemoteUrl(agent)).toBe('https://github.com/acme/repo.git');
  });

  it('forwards a gitRepos entry that already looks like a URL (ssh)', () => {
    const agent = makeTestAgent({ gitRepos: ['git@github.com:acme/repo.git'] });
    expect(knownRepoRemoteUrl(agent)).toBe('git@github.com:acme/repo.git');
  });

  it('does not derive a URL from a bare "owner/repo" access identifier', () => {
    const agent = makeTestAgent({ gitRepos: ['Apra-Labs/apra-fleet'] });
    expect(knownRepoRemoteUrl(agent)).toBeUndefined();
  });

  // apra-fleet-b4g.14: gitRepos is an access list, not an origin field -- a
  // multi-entry list whose first element happens to look like a URL is
  // ambiguous (it could be an access grant to an unrelated repo), so it must
  // NOT be forwarded even though the plain "first entry looks like a URL"
  // check alone would accept it.
  it('does not forward a URL when gitRepos has MULTIPLE entries, even if the first looks like a URL for an unrelated repo', () => {
    const agent = makeTestAgent({
      gitRepos: ['https://github.com/acme/unrelated-repo.git', 'Apra-Labs/apra-fleet'],
    });
    expect(knownRepoRemoteUrl(agent)).toBeUndefined();
  });

  it('returns undefined when gitRepos is absent', () => {
    const agent = makeTestAgent({ gitRepos: undefined });
    expect(knownRepoRemoteUrl(agent)).toBeUndefined();
  });

  it('returns undefined when gitRepos is empty', () => {
    const agent = makeTestAgent({ gitRepos: [] });
    expect(knownRepoRemoteUrl(agent)).toBeUndefined();
  });
});

describe('execute_prompt auto-harvest repo_remote_url wiring (apra-fleet-b4g.6)', () => {
  let tmpDir: string;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockKbHarvest.mockResolvedValue(JSON.stringify({ entries_captured: 0, entries_updated: 0, entries_skipped: 0 }));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-kb-harvest-url-test-'));
  });

  afterEach(() => {
    restoreRegistry();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // The forwarded-when-known assertion: must go red if the repo_remote_url
  // argument is dropped from the kb-harvest call site.
  it('forwards repo_remote_url when the member registration record already carries a genuine URL', async () => {
    const member = makeTestAgent({
      friendlyName: 'kb-harvest-remote-known-url',
      workFolder: 'C:\\Users\\member\\work\\repo',
      gitRepos: ['https://github.com/acme/repo.git'],
    });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: successResponse, stderr: '', code: 0 });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    await flushMicrotasks();

    expect(mockKbHarvest).toHaveBeenCalledTimes(1);
    expect(mockKbHarvest.mock.calls[0][0]).toMatchObject({
      repo_path: 'C:\\Users\\member\\work\\repo',
      repo_remote_url: 'https://github.com/acme/repo.git',
      session_id: 'sess-harvest',
    });
  });

  it('omits repo_remote_url when the member only carries a bare "owner/repo" access identifier', async () => {
    const member = makeTestAgent({
      friendlyName: 'kb-harvest-remote-bare-repo',
      workFolder: 'C:\\Users\\member\\work\\repo',
      gitRepos: ['Apra-Labs/apra-fleet'],
    });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: successResponse, stderr: '', code: 0 });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    await flushMicrotasks();

    expect(mockKbHarvest).toHaveBeenCalledTimes(1);
    expect(mockKbHarvest.mock.calls[0][0].repo_remote_url).toBeUndefined();
  });

  it('omits repo_remote_url when the member has no gitRepos at all (today\'s behaviour preserved)', async () => {
    const member = makeTestLocalAgent({
      friendlyName: 'kb-harvest-local-no-url',
      workFolder: tmpDir,
      os: 'linux',
      gitRepos: undefined,
    });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: successResponse, stderr: '', code: 0 });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    await flushMicrotasks();

    expect(mockKbHarvest).toHaveBeenCalledTimes(1);
    expect(mockKbHarvest.mock.calls[0][0]).toMatchObject({ repo_path: tmpDir });
    expect(mockKbHarvest.mock.calls[0][0].repo_remote_url).toBeUndefined();
  });
});
