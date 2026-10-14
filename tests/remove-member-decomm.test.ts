import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent, getKeysDir } from '../src/services/registry.js';
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

  // Regression: revoke must be called with the SAME label/scopeUrl that was
  // actually persisted at provision time -- omitting them (the old 3-arg
  // shape) targets the unlabeled/default-host credential-helper file/
  // config-key pair instead of the real one, leaving the token file
  // orphaned, unrevoked, on a machine being decommissioned.
  it('revokes VCS auth using the member\'s persisted vcsCredentialLabel/vcsCredentialScopeUrl', async () => {
    const member = makeTestAgent({
      friendlyName: 'vcs-labeled-worker',
      vcsProvider: 'github',
      vcsCredentialLabel: 'work-github',
      vcsCredentialScopeUrl: 'https://github.com/my-org',
    });
    addAgent(member);

    await removeMember({ member_id: member.id });

    expect(mockRevokeGithub).toHaveBeenCalledWith(
      expect.objectContaining({ id: member.id }),
      expect.anything(),
      expect.any(Function),
      'work-github',
      'https://github.com/my-org',
    );
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

  it('runs the member-side config cleanup BEFORE removing the fleet key from authorized_keys', async () => {
    // Fleet-generated key (under the fleet keys dir): remove_member only
    // touches authorized_keys for those, never for a user-supplied key.
    fs.mkdirSync(getKeysDir(), { recursive: true });
    const dir = fs.mkdtempSync(path.join(getKeysDir(), 'rm-order-'));
    try {
      const keyPath = path.join(dir, 'id_ed25519');
      fs.writeFileSync(keyPath, 'PRIVATE');
      fs.writeFileSync(`${keyPath}.pub`, 'ssh-ed25519 AAAAC3Nza fleet@test');
      const member = makeTestAgent({ friendlyName: 'order-worker', keyPath, os: 'linux', workFolder: '/home/u/proj' });
      addAgent(member);

      await removeMember({ member_id: member.id });

      const allCmds = mockExecCommand.mock.calls.map(c => c[0]);
      const configIdx = allCmds.findIndex(c => c.includes('/home/u/proj/.claude/settings.local.json'));
      const keyIdx = allCmds.findIndex(c => c.includes('authorized_keys'));
      expect(configIdx).toBeGreaterThanOrEqual(0);
      expect(keyIdx).toBeGreaterThan(configIdx);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a composed config it could not remove, and still removes the member', async () => {
    const member = makeTestAgent({ friendlyName: 'locked-worker', os: 'linux', workFolder: '/home/u/proj' });
    addAgent(member);
    mockExecCommand.mockImplementation(async (cmd: string) =>
      cmd.includes('settings.local.json') && cmd.includes('cat ')
        ? { stdout: '', stderr: 'Permission denied', code: 1 }
        : { stdout: '', stderr: '', code: 0 });

    const result = await removeMember({ member_id: member.id });

    expect(result).toContain('has been removed');
    expect(result).toContain("Could not remove the member's composed config");
    expect(result).toContain('E-MEMBER-CONFIG-UNREADABLE');
  });

  it('reports that the composed config was NOT removed when the member is unreachable', async () => {
    const member = makeTestAgent({ friendlyName: 'gone-worker' });
    addAgent(member);
    mockTestConnection.mockResolvedValue({ ok: false, latencyMs: 0, error: 'timeout' });

    const result = await removeMember({ member_id: member.id });

    expect(result).toContain('has been removed');
    expect(result).toMatch(/unreachable \(timeout\) -- its composed config[^\n]*was NOT removed/);
  });

  it('continues removal even when VCS revoke throws', async () => {
    const member = makeTestAgent({ friendlyName: 'revoke-throws', vcsProvider: 'github' });
    addAgent(member);
    mockRevokeGithub.mockRejectedValue(new Error('revoke failed'));

    const result = await removeMember({ member_id: member.id });

    expect(result).toContain('✅');
  });
});

describe('removeMember - agy project cleanup', () => {
  const PROJECT_ID = '1afd6dbb-498f-4918-a9d9-6da64b75a204';
  const isDeleteCmd = (cmd: string) => cmd.includes('FLEET_AGY_PROJECT_DELETE_EOF');

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    mockReadMemberStatus.mockReturnValue('idle');
  });

  afterEach(() => restoreRegistry());

  it('deletes the agy project file for an agy member', async () => {
    const member = makeTestAgent({ friendlyName: 'agy-worker', llmProvider: 'agy', agyProjectId: PROJECT_ID });
    addAgent(member);
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (isDeleteCmd(cmd)) {
        return { stdout: `FLEET_AGY_PROJECT_DELETE:${JSON.stringify({ deleted: [`${PROJECT_ID}.json`], errors: [] })}`, stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    const result = await removeMember({ member_id: member.id });

    expect(result).toContain('\u2705');
    expect(result).not.toContain('agy project');
    expect(mockExecCommand.mock.calls.some(c => isDeleteCmd(c[0]))).toBe(true);
  });

  it('is fine when the agy project file is already missing', async () => {
    const member = makeTestAgent({ friendlyName: 'agy-worker', llmProvider: 'agy', agyProjectId: PROJECT_ID });
    addAgent(member);
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (isDeleteCmd(cmd)) {
        return { stdout: `FLEET_AGY_PROJECT_DELETE:${JSON.stringify({ deleted: [], errors: [] })}`, stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    const result = await removeMember({ member_id: member.id });

    expect(result).toContain('\u2705');
    expect(result).not.toContain('agy project');
  });

  it('warns but still removes the member when the agy project delete fails/times out', async () => {
    const member = makeTestAgent({ friendlyName: 'agy-worker', llmProvider: 'agy', agyProjectId: PROJECT_ID });
    addAgent(member);
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (isDeleteCmd(cmd)) throw new Error('timed out');
      return { stdout: '', stderr: '', code: 0 };
    });

    const result = await removeMember({ member_id: member.id });

    expect(result).toContain('\u2705');
    expect(result).toContain('\u26A0\uFE0F');
    expect(result).toContain('agy project');
  });

  it('skips the delete when another member shares the same agyProjectId', async () => {
    const member = makeTestAgent({ friendlyName: 'agy-worker-1', llmProvider: 'agy', agyProjectId: PROJECT_ID });
    const sibling = makeTestAgent({ friendlyName: 'agy-worker-2', llmProvider: 'agy', agyProjectId: PROJECT_ID });
    addAgent(member);
    addAgent(sibling);

    const result = await removeMember({ member_id: member.id });

    expect(result).toContain('\u2705');
    expect(mockExecCommand.mock.calls.some(c => isDeleteCmd(c[0]))).toBe(false);
  });

  it('issues no agy project exec for a non-agy member', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-worker', llmProvider: 'claude' });
    addAgent(member);

    const result = await removeMember({ member_id: member.id });

    expect(result).toContain('\u2705');
    expect(mockExecCommand.mock.calls.some(c => isDeleteCmd(c[0]))).toBe(false);
  });
});

// Regression: remove_member used to delete whatever key_path a member was
// registered with (incl. a user's personal ~/.ssh/id_ed25519) and strip it
// from the member's authorized_keys. Only fleet-generated keys (under the
// fleet keys dir) may be touched.
describe('removeMember - SSH key ownership', () => {
  const pubKeyLine = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIkeyownership000000000000000000000000000 user@host';
  const dirs: string[] = [];
  const makeKey = (parent: string): string => {
    const dir = fs.mkdtempSync(path.join(parent, 'rm-key-test-'));
    dirs.push(dir);
    const keyPath = path.join(dir, 'id_ed25519');
    fs.writeFileSync(keyPath, 'PRIVATE KEY', 'utf-8');
    fs.writeFileSync(`${keyPath}.pub`, `${pubKeyLine}\n`, 'utf-8');
    return keyPath;
  };
  const akCmds = () => mockExecCommand.mock.calls.map(c => c[0]).filter(c => c.includes('authorized_keys'));

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    mockReadMemberStatus.mockReturnValue('idle');
  });

  afterEach(() => {
    restoreRegistry();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('leaves a user-supplied key (outside the fleet keys dir) and its authorized_keys entry untouched', async () => {
    const keyPath = makeKey(os.tmpdir());
    const member = makeTestAgent({ friendlyName: 'user-key', os: 'linux' as any, keyPath });
    addAgent(member);

    const result = await removeMember({ member_id: member.id });

    expect(result).toContain('\u2705');
    expect(fs.existsSync(keyPath)).toBe(true);
    expect(fs.existsSync(`${keyPath}.pub`)).toBe(true);
    expect(akCmds()).toHaveLength(0);
  });

  it('deletes an unshared fleet-generated key and removes it from authorized_keys', async () => {
    const keyPath = makeKey(getKeysDir());
    const member = makeTestAgent({ friendlyName: 'fleet-key', os: 'linux' as any, keyPath });
    addAgent(member);

    await removeMember({ member_id: member.id });

    expect(fs.existsSync(keyPath)).toBe(false);
    expect(fs.existsSync(`${keyPath}.pub`)).toBe(false);
    expect(akCmds()).toHaveLength(1);
  });

  it('keeps a fleet-generated key still used by another member', async () => {
    const keyPath = makeKey(getKeysDir());
    const member = makeTestAgent({ friendlyName: 'fleet-key-1', os: 'linux' as any, keyPath });
    const sibling = makeTestAgent({ friendlyName: 'fleet-key-2', os: 'linux' as any, keyPath });
    addAgent(member);
    addAgent(sibling);

    await removeMember({ member_id: member.id });

    expect(fs.existsSync(keyPath)).toBe(true);
    expect(fs.existsSync(`${keyPath}.pub`)).toBe(true);
  });
});
