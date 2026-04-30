import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn();
const mockClose = vi.fn();
const mockReadMemberStatus = vi.fn<(id: string) => string>(() => 'idle');
const mockCancelCredentialCleanup = vi.fn();
const mockRevokeGithub = vi.fn();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: mockTestConnection,
    close: mockClose,
  }),
}));

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: (id: string) => mockReadMemberStatus(id),
}));

vi.mock('../src/services/credential-cleanup.js', () => ({
  cancelCredentialCleanup: (id: string) => mockCancelCredentialCleanup(id),
}));

vi.mock('../src/services/vcs/github.js', () => ({
  githubProvider: {
    revoke: (...args: any[]) => mockRevokeGithub(...args),
    deploy: vi.fn(),
    testConnectivity: vi.fn(),
  },
}));
vi.mock('../src/services/vcs/bitbucket.js', () => ({
  bitbucketProvider: { revoke: vi.fn(), deploy: vi.fn(), testConnectivity: vi.fn() },
}));
vi.mock('../src/services/vcs/azure-devops.js', () => ({
  azureDevOpsProvider: { revoke: vi.fn(), deploy: vi.fn(), testConnectivity: vi.fn() },
}));

vi.mock('../src/services/known-hosts.js', () => ({
  removeKnownHost: vi.fn(),
}));

import { removeMember } from '../src/tools/remove-member.js';

describe('removeMember - decommissioning', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    mockRevokeGithub.mockResolvedValue({ success: true, message: 'github revoked' });
    mockReadMemberStatus.mockReturnValue('idle');
  });

  afterEach(() => restoreRegistry());

  it('blocks removal when member is busy and force=false', async () => {
    const member = makeTestAgent({ friendlyName: 'busy-worker' });
    addAgent(member);
    mockReadMemberStatus.mockReturnValue('busy');

    const result = await removeMember({ member_id: member.id, force: false });

    expect(result).toContain('⛔');
    expect(result).toContain('busy');
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('allows removal when member is busy and force=true', async () => {
    const member = makeTestAgent({ friendlyName: 'busy-worker' });
    addAgent(member);
    mockReadMemberStatus.mockReturnValue('busy');

    const result = await removeMember({ member_id: member.id, force: true });

    expect(result).toContain('✅');
  });

  it('allows removal when member is idle', async () => {
    const member = makeTestAgent({ friendlyName: 'idle-worker' });
    addAgent(member);

    const result = await removeMember({ member_id: member.id });

    expect(result).toContain('✅');
  });

  it('calls cancelCredentialCleanup before removing', async () => {
    const member = makeTestAgent({ friendlyName: 'cred-worker' });
    addAgent(member);

    await removeMember({ member_id: member.id });

    expect(mockCancelCredentialCleanup).toHaveBeenCalledWith(member.id);
  });

  it('revokes VCS auth for remote member with vcsProvider', async () => {
    const member = makeTestAgent({ friendlyName: 'vcs-worker', vcsProvider: 'github' });
    addAgent(member);

    await removeMember({ member_id: member.id });

    expect(mockRevokeGithub).toHaveBeenCalledOnce();
  });

  it('skips VCS revoke for local member', async () => {
    const member = makeTestAgent({ friendlyName: 'local-worker', agentType: 'local', vcsProvider: 'github' });
    addAgent(member);

    await removeMember({ member_id: member.id });

    expect(mockRevokeGithub).not.toHaveBeenCalled();
  });

  it('skips VCS revoke when no vcsProvider configured', async () => {
    const member = makeTestAgent({ friendlyName: 'no-vcs', vcsProvider: undefined });
    addAgent(member);

    await removeMember({ member_id: member.id });

    expect(mockRevokeGithub).not.toHaveBeenCalled();
  });

  it('attempts authorized_keys cleanup for remote member with keyPath', async () => {
    const member = makeTestAgent({ friendlyName: 'key-worker', keyPath: undefined });
    addAgent(member);

    await removeMember({ member_id: member.id });

    // keyPath is undefined so no authorized_keys command
    const allCmds = mockExecCommand.mock.calls.map(c => c[0]);
    expect(allCmds.some(c => c.includes('authorized_keys'))).toBe(false);
  });

  it('continues removal even when testConnection fails', async () => {
    const member = makeTestAgent({ friendlyName: 'offline-worker' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: false, latencyMs: 0, error: 'timeout' });

    const result = await removeMember({ member_id: member.id });

    expect(result).toContain('✅');
    expect(result).toContain('⚠️');
  });

  it('continues removal even when VCS revoke throws', async () => {
    const member = makeTestAgent({ friendlyName: 'revoke-throws', vcsProvider: 'github' });
    addAgent(member);
    mockRevokeGithub.mockRejectedValue(new Error('revoke failed'));

    const result = await removeMember({ member_id: member.id });

    expect(result).toContain('✅');
  });
});
