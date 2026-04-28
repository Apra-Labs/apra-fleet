import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { setStoredPid, clearStoredPid, getStoredPid, isAgentStopped, clearAgentStopped } from '../src/utils/agent-helpers.js';
import { stopPrompt } from '../src/tools/stop-prompt.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

describe('stop_prompt (T8)', () => {
  let agentId: string;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
    if (agentId) {
      clearStoredPid(agentId);
      clearAgentStopped(agentId);
    }
  });

  it('returns not-found error for unknown member', async () => {
    const result = await stopPrompt({ member_id: 'nonexistent-id' });
    expect(result).toContain('not found');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('kills active PID and sets stopped flag when PID is stored', async () => {
    const agent = makeTestAgent({ friendlyName: 'kill-me' });
    agentId = agent.id;
    addAgent(agent);
    setStoredPid(agentId, 9999);

    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }); // kill

    const result = await stopPrompt({ member_id: agentId });

    // Kill command should have been issued
    expect(mockExecCommand).toHaveBeenCalledTimes(1);
    expect(mockExecCommand.mock.calls[0][0]).toContain('9999');

    // PID cleared, stopped flag set
    expect(getStoredPid(agentId)).toBeUndefined();
    expect(isAgentStopped(agentId)).toBe(true);

    // Response mentions PID
    expect(result).toContain('9999');
    expect(result).toContain('stopped');
  });

  it('sets stopped flag even when no PID is stored', async () => {
    const agent = makeTestAgent({ friendlyName: 'idle-agent' });
    agentId = agent.id;
    addAgent(agent);
    // no PID stored

    const result = await stopPrompt({ member_id: agentId });

    expect(mockExecCommand).not.toHaveBeenCalled();
    expect(isAgentStopped(agentId)).toBe(true);
    expect(result).toContain('stopped');
  });

  it('resolves member by friendly name', async () => {
    const agent = makeTestAgent({ friendlyName: 'name-lookup-agent' });
    agentId = agent.id;
    addAgent(agent);

    const result = await stopPrompt({ member_name: 'name-lookup-agent' });

    expect(result).toContain('name-lookup-agent');
    expect(isAgentStopped(agentId)).toBe(true);
  });

  it('kill command uses 5000ms timeout', async () => {
    const agent = makeTestAgent({ friendlyName: 'kill-timeout-agent' });
    agentId = agent.id;
    addAgent(agent);
    setStoredPid(agentId, 1234);

    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    await stopPrompt({ member_id: agentId });

    expect(mockExecCommand.mock.calls[0][1]).toBe(5000);
  });
});
