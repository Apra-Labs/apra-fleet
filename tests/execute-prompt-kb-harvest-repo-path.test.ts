/**
 * apra-fleet-tm7.2: execute_prompt's auto-harvest must pass the member's
 * resolvedWorkFolder as the explicit KB anchor folder (kbHarvest's second
 * argument) -- for BOTH local and remote members -- so the harvest never
 * falls back to the calling session's own folder, which would route it into
 * the fleet server's own repo KB (apra-fleet-tm7).
 *
 * This spies on the real kb-harvest module (rather than grepping source
 * text) so it fails if the wiring regresses to omitting the anchor for
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

describe('execute_prompt auto-harvest anchor folder wiring (apra-fleet-tm7.2)', () => {
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

  it('passes the local member resolvedWorkFolder as the anchor folder', async () => {
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
    expect(mockKbHarvest.mock.calls[0][0]).toMatchObject({ session_id: 'sess-harvest' });
    expect(mockKbHarvest.mock.calls[0][1]).toMatchObject({ folder: tmpDir });
  });

  it('passes the remote member workFolder as the anchor folder (not undefined)', async () => {
    const member = makeTestAgent({
      friendlyName: 'kb-harvest-remote',
      workFolder: '/home/remoteuser/project',
    });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: successResponse, stderr: '', code: 0 });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    await flushMicrotasks();

    expect(mockKbHarvest).toHaveBeenCalledTimes(1);
    expect(mockKbHarvest.mock.calls[0][0]).toMatchObject({ session_id: 'sess-harvest' });
    expect(mockKbHarvest.mock.calls[0][1]).toMatchObject({ folder: '/home/remoteuser/project' });
    // The defect this guards against: omitting the anchor for remote members
    // makes kb_harvest resolve the calling session's own folder -- the fleet
    // server's -- silently routing the harvest into the server's own repo KB.
    expect(mockKbHarvest.mock.calls[0][1]).not.toBeUndefined();
    // The anchor never leaks into the tool input as a scope field.
    expect(mockKbHarvest.mock.calls[0][0].repo_path).toBeUndefined();
  });
});

/**
 * apra-fleet-4wz.8: the auto-harvest result used to be discarded entirely, so
 * entries_rejected -- the fail-closed signal -- was invisible on the highest
 * volume KB writer. Rejections are EXPECTED to dominate here (harvest's regex
 * extraction frequently yields no file paths at all, and an entry with no basis
 * is refused by design), so the count must be observable rather than silently
 * swallowed.
 */
describe('auto-harvest reports its counters (apra-fleet-4wz.8)', () => {
  let tmpDir: string;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-kb-harvest-counters-'));
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    restoreRegistry();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function logged(): string {
    return errSpy.mock.calls.map(c => c.join(' ')).join('\n');
  }

  it('logs the rejected count so the fail-closed signal is visible', async () => {
    const member = makeTestLocalAgent({ friendlyName: 'counters-visible', workFolder: tmpDir, os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: successResponse, stderr: '', code: 0 });
    mockKbHarvest.mockResolvedValue(JSON.stringify({
      entries_captured: 1, entries_updated: 0, entries_skipped: 0, entries_rejected: 7,
    }));

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    await flushMicrotasks();

    expect(logged()).toContain('rejected=7');
    expect(logged()).toContain('captured=1');
  });

  it('stays quiet when the harvest produced nothing at all', async () => {
    const member = makeTestLocalAgent({ friendlyName: 'counters-quiet', workFolder: tmpDir, os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: successResponse, stderr: '', code: 0 });
    mockKbHarvest.mockResolvedValue(JSON.stringify({
      entries_captured: 0, entries_updated: 0, entries_skipped: 0, entries_rejected: 0,
    }));

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    await flushMicrotasks();

    expect(logged()).not.toContain('auto-harvest: captured=');
  });

  it('a non-JSON harvest payload never breaks the fire-and-forget path', async () => {
    const member = makeTestLocalAgent({ friendlyName: 'counters-garbage', workFolder: tmpDir, os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: successResponse, stderr: '', code: 0 });
    mockKbHarvest.mockResolvedValue('not json at all');

    await expect(
      executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 })
    ).resolves.toBeDefined();
    await flushMicrotasks();
  });
});
