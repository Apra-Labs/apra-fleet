/**
 * apra-fleet-tm7.2: execute_prompt's auto-harvest must pass the member's
 * resolvedWorkFolder as repo_path -- for BOTH local and remote members --
 * so kb_harvest never falls back to getKbProviders(undefined), which would
 * route the harvest into the fleet server's own repo KB (apra-fleet-tm7).
 *
 * This spies on the real kb-harvest module (rather than grepping source
 * text) so it fails if the wiring regresses to omitting repo_path for
 * remote members, or to a second/independent computation of the work
 * folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt } from '../src/tools/execute-prompt.js';
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

describe('execute_prompt auto-harvest repo_path wiring (apra-fleet-tm7.2)', () => {
  let tmpDir: string;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockKbHarvest.mockResolvedValue(JSON.stringify({ entries_captured: 0, entries_updated: 0, entries_skipped: 0 }));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-kb-harvest-test-'));
  });

  afterEach(() => {
    restoreRegistry();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes the local member resolvedWorkFolder as repo_path', async () => {
    const member = makeTestLocalAgent({
      friendlyName: 'kb-harvest-local',
      workFolder: tmpDir,
      os: 'linux',
    });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: successResponse, stderr: '', code: 0 });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    await flushMicrotasks();

    expect(mockKbHarvest).toHaveBeenCalledTimes(1);
    expect(mockKbHarvest.mock.calls[0][0]).toMatchObject({
      repo_path: tmpDir,
      session_id: 'sess-harvest',
    });
  });

  it('passes the remote member workFolder as repo_path (not undefined)', async () => {
    const member = makeTestAgent({
      friendlyName: 'kb-harvest-remote',
      workFolder: '/home/remoteuser/project',
    });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: successResponse, stderr: '', code: 0 });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    await flushMicrotasks();

    expect(mockKbHarvest).toHaveBeenCalledTimes(1);
    expect(mockKbHarvest.mock.calls[0][0]).toMatchObject({
      repo_path: '/home/remoteuser/project',
      session_id: 'sess-harvest',
    });
    // The defect this guards against: omitting repo_path for remote members
    // makes getKbProviders(undefined) fall back to the fleet server's own
    // cwd, silently routing the harvest into the server's own repo KB.
    expect(mockKbHarvest.mock.calls[0][0].repo_path).not.toBeUndefined();
  });
});
