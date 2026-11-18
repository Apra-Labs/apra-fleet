import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent, getKeysDir } from '../src/services/registry.js';
import type { SSHExecResult } from '../src/types.js';
import { SSH_PUBLIC_KEYS, truncatedKeys } from './fixtures/ssh-public-keys.js';

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
      fs.writeFileSync(`${keyPath}.pub`, `${SSH_PUBLIC_KEYS.ed25519} fleet@test`);
      const member = makeTestAgent({ friendlyName: 'order-worker', keyPath, os: 'linux', workFolder: '/home/u/proj' });
      addAgent(member);
      // The key removal needs the member home (getMemberHomeDir probe).
      mockExecCommand.mockImplementation(async (cmd: string) => (
        cmd.includes('"$HOME"')
          ? { stdout: '/home/u', stderr: '', code: 0 }
          : { stdout: '', stderr: '', code: 0 }
      ));

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
  const pubKeyLine = `${SSH_PUBLIC_KEYS.rsa4096} user@host`;
  const dirs: string[] = [];
  const makeKey = (parent: string): string => {
    const dir = fs.mkdtempSync(path.join(parent, 'rm-key-test-'));
    dirs.push(dir);
    const keyPath = path.join(dir, 'id_ed25519');
    fs.writeFileSync(keyPath, 'PRIVATE KEY', 'utf-8');
    fs.writeFileSync(`${keyPath}.pub`, `${pubKeyLine}\n`, 'utf-8');
    return keyPath;
  };
  // A Windows (PowerShell) command travels as -EncodedCommand <utf16le base64>;
  // decode it so the authorized_keys seam sees its script text.
  const decoded = (cmd: string): string => {
    const m = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(cmd);
    return m ? Buffer.from(m[1], 'base64').toString('utf16le') : cmd;
  };
  const akCmds = () => mockExecCommand.mock.calls.map(c => decoded(c[0])).filter(c => c.includes('authorized_keys'));

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    // The member home probe (getMemberHomeDir) answers with a POSIX home;
    // every other command succeeds silently.
    mockExecCommand.mockImplementation(async (cmd: string) => {
      const text = decoded(cmd);
      if (text.includes('"$HOME"')) return { stdout: '/home/testuser', stderr: '', code: 0 };
      if (text.includes('[Console]::Out.Write($env:USERPROFILE)')) return { stdout: 'C:\\Users\\testuser', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });
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

    const result = await removeMember({ member_id: member.id });

    expect(fs.existsSync(keyPath)).toBe(true);
    expect(fs.existsSync(`${keyPath}.pub`)).toBe(true);
    // Same host and username: the key stays authorized for the sibling.
    expect(akCmds()).toHaveLength(0);
    expect(result).toContain('stays in authorized_keys');
    expect(result).toContain('"fleet-key-2"');
  });

  it('treats host names case-insensitively when deciding the key is shared', async () => {
    const keyPath = makeKey(getKeysDir());
    const member = makeTestAgent({ friendlyName: 'case-1', os: 'linux' as any, keyPath, host: 'Build-Box.example' });
    const sibling = makeTestAgent({ friendlyName: 'case-2', os: 'linux' as any, keyPath, host: 'build-box.EXAMPLE' });
    addAgent(member);
    addAgent(sibling);

    await removeMember({ member_id: member.id });

    expect(akCmds()).toHaveLength(0);
  });

  it('still revokes a shared key from a member on a different host', async () => {
    const keyPath = makeKey(getKeysDir());
    const member = makeTestAgent({ friendlyName: 'host-a', os: 'linux' as any, keyPath, host: '10.0.0.1' });
    const sibling = makeTestAgent({ friendlyName: 'host-b', os: 'linux' as any, keyPath, host: '10.0.0.2' });
    addAgent(member);
    addAgent(sibling);

    const result = await removeMember({ member_id: member.id });

    expect(akCmds()).toHaveLength(1);
    expect(result).not.toContain('stays in authorized_keys');
    // The local key pair is still in use by host-b, so it is kept.
    expect(fs.existsSync(keyPath)).toBe(true);
  });

  it('still revokes a shared key from a member on the same host with a different username', async () => {
    const keyPath = makeKey(getKeysDir());
    const member = makeTestAgent({ friendlyName: 'user-a', os: 'linux' as any, keyPath, username: 'alice' });
    const sibling = makeTestAgent({ friendlyName: 'user-b', os: 'linux' as any, keyPath, username: 'bob' });
    addAgent(member);
    addAgent(sibling);

    await removeMember({ member_id: member.id });

    expect(akCmds()).toHaveLength(1);
  });

  it('revokes an unshared fleet key from a Windows member (PowerShell)', async () => {
    const keyPath = makeKey(getKeysDir());
    const member = makeTestAgent({ friendlyName: 'win-solo', os: 'windows' as any, keyPath });
    addAgent(member);

    await removeMember({ member_id: member.id });

    const cmds = akCmds();
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain('C:\\Users\\testuser\\.ssh\\authorized_keys');
    expect(cmds[0]).toContain('administrators_authorized_keys');
  });

  it('keeps a fleet key shared by two Windows members on the same host and user', async () => {
    const keyPath = makeKey(getKeysDir());
    const member = makeTestAgent({ friendlyName: 'win-1', os: 'windows' as any, keyPath });
    const sibling = makeTestAgent({ friendlyName: 'win-2', os: 'windows' as any, keyPath });
    addAgent(member);
    addAgent(sibling);

    const result = await removeMember({ member_id: member.id });

    expect(akCmds()).toHaveLength(0);
    expect(result).toContain('"win-2"');
  });

  it('sends no authorized_keys command and warns when the member home cannot be resolved', async () => {
    const keyPath = makeKey(getKeysDir());
    const member = makeTestAgent({ friendlyName: 'no-home', os: 'linux' as any, keyPath });
    addAgent(member);
    mockExecCommand.mockImplementation(async (cmd: string) => (
      cmd.includes('"$HOME"')
        ? { stdout: '', stderr: 'probe failed', code: 1 }
        : { stdout: '', stderr: '', code: 0 }
    ));

    const result = await removeMember({ member_id: member.id });

    expect(akCmds()).toHaveLength(0);
    expect(result).toContain('home directory');
    expect(result).toContain('NOT removed from authorized_keys');
    // Never a ~/ fallback anywhere in what was sent.
    expect(mockExecCommand.mock.calls.some(c => c[0].includes('~/.ssh/authorized_keys'))).toBe(false);
  });

  // An empty, truncated or type-only .pub would match every authorized_keys
  // line (or every key sharing its prefix): no command touching authorized_keys
  // may be sent, and the result must say the file was left untouched.
  const OS_CASES: Array<[string, Record<string, unknown>]> = [
    ['linux', { os: 'linux' }],
    ['macos', { os: 'macos' }],
    ['windows powershell', { os: 'windows' }],
    ['windows gitbash', { os: 'windows', shell: 'gitbash' }],
  ];
  const BAD_PUBS: Array<[string, string]> = [
    ['empty', ''],
    ['one-word', 'ssh-rsa\n'],
    ['garbage', 'not a key at all\n'],
  ];
  for (const [osName, fields] of OS_CASES) {
    for (const [pubName, pub] of BAD_PUBS) {
      it(`${osName}: ${pubName} fleet .pub -> no command touches authorized_keys, warning returned`, async () => {
        const keyPath = makeKey(getKeysDir());
        fs.writeFileSync(`${keyPath}.pub`, pub, 'utf-8');
        const member = makeTestAgent({ friendlyName: `bad-pub-${osName}-${pubName}`.replace(/\s/g, '-'), keyPath, ...fields } as any);
        addAgent(member);

        const result = await removeMember({ member_id: member.id });

        expect(akCmds()).toHaveLength(0);
        expect(result).toContain('is not a valid SSH public key');
        expect(result).toContain('authorized_keys was left untouched');
      });
    }
    // A truncated .pub (crash or full disk mid-write) is a prefix of every
    // key sharing its header, so it must never be used to revoke.
    for (const [keyName, key] of Object.entries(SSH_PUBLIC_KEYS)) {
      it(`${osName}: truncated ${keyName} fleet .pub (every cut) -> no command touches authorized_keys`, async () => {
        for (const [cut, truncated] of truncatedKeys(key)) {
          const keyPath = makeKey(getKeysDir());
          fs.writeFileSync(`${keyPath}.pub`, `${truncated} fleet@test\n`, 'utf-8');
          const member = makeTestAgent({ friendlyName: `trunc-${osName}-${keyName}`.replace(/\s/g, '-'), keyPath, ...fields } as any);
          addAgent(member);

          const result = await removeMember({ member_id: member.id });

          expect(akCmds(), cut).toHaveLength(0);
          expect(result, cut).toContain('is not a valid SSH public key');
        }
      });
    }
    it(`${osName}: valid fleet .pub -> exactly one revocation command`, async () => {
      const keyPath = makeKey(getKeysDir());
      const member = makeTestAgent({ friendlyName: `good-pub-${osName}`.replace(/\s/g, '-'), keyPath, ...fields } as any);
      addAgent(member);

      const result = await removeMember({ member_id: member.id });

      expect(akCmds()).toHaveLength(1);
      expect(result).not.toContain('is not a valid SSH public key');
    });
  }

  it('sends the revocation built from the resolved home, never ~/ or sed -i', async () => {
    const keyPath = makeKey(getKeysDir());
    const member = makeTestAgent({ friendlyName: 'posix-home', os: 'linux' as any, keyPath });
    addAgent(member);

    await removeMember({ member_id: member.id });

    const cmds = akCmds();
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain("'/home/testuser/.ssh/authorized_keys'");
    expect(cmds[0]).not.toContain('~/');
    expect(cmds[0]).not.toContain('sed -i');
  });
});
