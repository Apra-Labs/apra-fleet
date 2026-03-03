import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { revokeGitAuth } from '../src/tools/revoke-git-auth.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn<() => Promise<{ ok: boolean; latencyMs: number; error?: string }>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: mockTestConnection,
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

describe('revokeGitAuth', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('returns not found for invalid agent ID', async () => {
    const result = await revokeGitAuth({ agent_id: 'nonexistent' });
    expect(result).toContain('not found');
  });

  it('fails when agent is offline', async () => {
    const agent = makeTestAgent({ friendlyName: 'offline' });
    addAgent(agent);
    mockTestConnection.mockResolvedValue({ ok: false, latencyMs: 0, error: 'Timeout' });

    const result = await revokeGitAuth({ agent_id: agent.id });
    expect(result).toContain('❌');
    expect(result).toContain('offline');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('removes credentials successfully', async () => {
    const agent = makeTestAgent({ friendlyName: 'revoke-target' });
    addAgent(agent);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await revokeGitAuth({ agent_id: agent.id });
    expect(result).toContain('✅');
    expect(result).toContain('revoked');

    const cmd = mockExecCommand.mock.calls[0][0];
    expect(cmd).toContain('fleet-git-credential');
    expect(cmd).toContain('credential.helper');
  });

  it('reports warning when removal has stderr', async () => {
    const agent = makeTestAgent({ friendlyName: 'warn-agent' });
    addAgent(agent);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: 'warning: key not found', code: 1 });

    const result = await revokeGitAuth({ agent_id: agent.id });
    expect(result).toContain('⚠️');
    expect(result).toContain('warnings');
  });

  it('handles exec failure gracefully', async () => {
    const agent = makeTestAgent({ friendlyName: 'fail-agent' });
    addAgent(agent);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockRejectedValue(new Error('SSH channel closed'));

    const result = await revokeGitAuth({ agent_id: agent.id });
    expect(result).toContain('❌');
    expect(result).toContain('SSH channel closed');
  });
});
