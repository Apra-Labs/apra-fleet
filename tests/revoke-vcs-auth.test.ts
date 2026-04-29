import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { revokeVcsAuth } from '../src/tools/revoke-vcs-auth.js';
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

describe('revokeVcsAuth', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('returns not found for invalid member ID', async () => {
    const result = await revokeVcsAuth({ member_id: 'nonexistent', provider: 'github' });
    expect(result).toContain('not found');
  });

  it('fails when member is offline', async () => {
    const member = makeTestAgent({ friendlyName: 'offline' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: false, latencyMs: 0, error: 'Timeout' });

    const result = await revokeVcsAuth({ member_id: member.id, provider: 'bitbucket' });
    expect(result).toContain('❌');
    expect(result).toContain('offline');
  });

  for (const provider of ['github', 'bitbucket', 'azure-devops'] as const) {
    it(`${provider}: revokes credentials successfully`, async () => {
      const member = makeTestAgent({ friendlyName: `revoke-${provider}` });
      addAgent(member);
      mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
      mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

      const result = await revokeVcsAuth({ member_id: member.id, provider });
      expect(result).toContain('✅');
      expect(result).toContain('revoked');

      const cmd = mockExecCommand.mock.calls[0][0];
      expect(cmd).toContain('fleet-git-credential');
      expect(cmd).toContain('credential.https://');
    });
  }

  it('revoke with label targets only that label credential file', async () => {
    const member = makeTestAgent({ friendlyName: 'label-revoke' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await revokeVcsAuth({ member_id: member.id, provider: 'github', label: 'work-gh' });
    expect(result).toContain('✅');

    const cmd = mockExecCommand.mock.calls[0][0];
    expect(cmd).toContain('fleet-git-credential-work-gh');
    expect(cmd).not.toMatch(/fleet-git-credential[^-]/);
  });

  it('revoke without label defaults to provider-named label', async () => {
    const member = makeTestAgent({ friendlyName: 'default-label' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await revokeVcsAuth({ member_id: member.id, provider: 'bitbucket' });
    expect(result).toContain('✅');

    const cmd = mockExecCommand.mock.calls[0][0];
    expect(cmd).toContain('fleet-git-credential-bitbucket');
  });

  it('handles exec failure gracefully', async () => {
    const member = makeTestAgent({ friendlyName: 'fail-revoke' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockRejectedValue(new Error('SSH channel closed'));

    const result = await revokeVcsAuth({ member_id: member.id, provider: 'github' });
    expect(result).toContain('❌');
    expect(result).toContain('SSH channel closed');
  });
});
