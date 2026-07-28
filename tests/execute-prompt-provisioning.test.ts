/**
 * Covers the 0.3.4 -> 0.3.5 upgrade path: #336's agent-provisioner only ran
 * inside register_member/update_member, so an already-registered remote member
 * kept stale/absent agent files until the operator manually ran update_member.
 * execute_prompt now auto-provisions on first dispatch to a remote member,
 * caching the result per member per server process so the SSH probe cost is
 * paid once, not on every call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry, resultText } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt, provisionedRemoteAgents } from '../src/tools/execute-prompt.js';
import type { SSHExecResult } from '../src/types.js';

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
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

const mockProvisionAgents = vi.fn();
const mockRemoteAgentsDir = vi.fn();
vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: (...args: any[]) => mockProvisionAgents(...args),
  remoteAgentsDir: (...args: any[]) => mockRemoteAgentsDir(...args),
}));

const OK_RESPONSE: SSHExecResult = {
  stdout: JSON.stringify({ result: 'ok', session_id: 'sess-ok' }),
  stderr: '',
  code: 0,
};

describe('execute_prompt: auto-provision stale remote agent files on dispatch', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    provisionedRemoteAgents.clear();
    mockExecCommand.mockResolvedValue(OK_RESPONSE);
    mockRemoteAgentsDir.mockReturnValue('.claude/agents/pm');
    mockProvisionAgents.mockResolvedValue({ pushed: ['planner.md'] });
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('provisions agent files on first dispatch to a stale remote member', async () => {
    const member = makeTestAgent({ friendlyName: 'stale-remote' });
    addAgent(member);

    const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });

    expect(resultText(result)).toContain('ok');
    expect(mockProvisionAgents).toHaveBeenCalledTimes(1);
    expect(mockProvisionAgents).toHaveBeenCalledWith(expect.objectContaining({ id: member.id }));
  });

  it('skips provisioning on the second dispatch to the same member (per-process cache)', async () => {
    const member = makeTestAgent({ friendlyName: 'cached-remote' });
    addAgent(member);

    await executePrompt({ member_id: member.id, prompt: 'first', resume: false, timeout_s: 5 });
    await executePrompt({ member_id: member.id, prompt: 'second', resume: false, timeout_s: 5 });

    expect(mockProvisionAgents).toHaveBeenCalledTimes(1);
  });

  it('re-provisions a different member independently (cache is per member id)', async () => {
    const memberA = makeTestAgent({ friendlyName: 'remote-a' });
    const memberB = makeTestAgent({ friendlyName: 'remote-b' });
    addAgent(memberA);
    addAgent(memberB);

    await executePrompt({ member_id: memberA.id, prompt: 'hi', resume: false, timeout_s: 5 });
    await executePrompt({ member_id: memberB.id, prompt: 'hi', resume: false, timeout_s: 5 });

    expect(mockProvisionAgents).toHaveBeenCalledTimes(2);
  });

  it('skips provisioning entirely for local members', async () => {
    const member = makeTestLocalAgent({ friendlyName: 'local-member' });
    fs.mkdirSync(member.workFolder, { recursive: true });
    addAgent(member);

    const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });

    expect(resultText(result)).toContain('ok');
    expect(mockProvisionAgents).not.toHaveBeenCalled();

    fs.rmSync(member.workFolder, { recursive: true, force: true });
  });

  it('skips provisioning for providers with no remote agents dir (e.g. codex, copilot)', async () => {
    mockRemoteAgentsDir.mockReturnValue(null);
    const member = makeTestAgent({ friendlyName: 'codex-remote', llmProvider: 'codex' as any });
    addAgent(member);

    const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });

    expect(resultText(result)).toContain('ok');
    expect(mockRemoteAgentsDir).toHaveBeenCalledWith('codex');
    expect(mockProvisionAgents).not.toHaveBeenCalled();
  });

  it('proceeds with dispatch when provisioning throws', async () => {
    mockProvisionAgents.mockRejectedValue(new Error('SSH probe blew up'));
    const member = makeTestAgent({ friendlyName: 'provision-throws' });
    addAgent(member);

    const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });

    expect(resultText(result)).toContain('ok');
    expect(mockProvisionAgents).toHaveBeenCalledTimes(1);
  });

  it('retries provisioning on the next dispatch after a transient throw (cache must not poison)', async () => {
    mockProvisionAgents.mockRejectedValue(new Error('SSH probe blew up'));
    const member = makeTestAgent({ friendlyName: 'provision-throws-retried' });
    addAgent(member);

    await executePrompt({ member_id: member.id, prompt: 'first', resume: false, timeout_s: 5 });
    await executePrompt({ member_id: member.id, prompt: 'second', resume: false, timeout_s: 5 });

    expect(mockProvisionAgents).toHaveBeenCalledTimes(2);
  });

  it('retries provisioning on the next dispatch after a warning result (probe/upload failure)', async () => {
    mockProvisionAgents.mockResolvedValue({ pushed: [], warning: 'Could not verify remote agent files -- skipped provisioning (probe failed)' });
    const member = makeTestAgent({ friendlyName: 'provision-warns-retried' });
    addAgent(member);

    await executePrompt({ member_id: member.id, prompt: 'first', resume: false, timeout_s: 5 });
    await executePrompt({ member_id: member.id, prompt: 'second', resume: false, timeout_s: 5 });

    expect(mockProvisionAgents).toHaveBeenCalledTimes(2);
  });

  it('stays cached on genuine success (no warning) -- skipped on next dispatch', async () => {
    mockProvisionAgents.mockResolvedValue({ pushed: ['planner.md'] });
    const member = makeTestAgent({ friendlyName: 'provision-success-cached' });
    addAgent(member);

    await executePrompt({ member_id: member.id, prompt: 'first', resume: false, timeout_s: 5 });
    await executePrompt({ member_id: member.id, prompt: 'second', resume: false, timeout_s: 5 });

    expect(mockProvisionAgents).toHaveBeenCalledTimes(1);
  });

  it('does not run provisioning when the dispatch is rejected as busy', async () => {
    const member = makeTestAgent({ friendlyName: 'busy-remote' });
    addAgent(member);

    // Simulate a live in-flight session so the second call is rejected as busy.
    let resolveFirst: (() => void) | undefined;
    mockExecCommand.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFirst = () => resolve(OK_RESPONSE);
    }));

    const firstCall = executePrompt({ member_id: member.id, prompt: 'first', resume: false, timeout_s: 5 });

    // Let the first call get far enough to claim inFlightAgents before firing the second.
    await new Promise((r) => setTimeout(r, 0));

    const secondResult = await executePrompt({ member_id: member.id, prompt: 'second', resume: false, timeout_s: 5 });
    expect(resultText(secondResult)).toContain('already running');

    resolveFirst?.();
    await firstCall;

    // Only the first (non-busy) dispatch should have triggered provisioning.
    expect(mockProvisionAgents).toHaveBeenCalledTimes(1);
  });
});
