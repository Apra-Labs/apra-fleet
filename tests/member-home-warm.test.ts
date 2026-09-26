/**
 * SF-18: the member home-dir cache must actually get warmed for Claude
 * remote members.
 *
 * `getMemberPathContext` (the probing resolver) had exactly one caller --
 * `pollDirectoryActivity`, which only runs for provisional dispatches with a
 * null logFilePath (AGY/OpenCode fresh turns). Claude sessions are
 * caller-minted, so their stall entries always carry a logFilePath and never
 * reach it: their cache stayed cold forever and the synchronous dispatch-path
 * resolver (`getCachedMemberPathContext`) permanently used the
 * username-convention GUESS -- wrong for any member with a relocated or
 * domain-suffixed home, which silently disables stall detection for it.
 *
 * The warm is fire-and-forget by design: an awaited probe on the dispatch path
 * inserts a remote round trip ahead of the dispatch's own commands, which is
 * exactly what broke ~71 tests during the #390 work.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry, decodePowerShellEncodedCommand } from './test-helpers.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: mockTestConnection,
  }),
}));

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn(async () => ({ pushed: [], skippedReason: 'test' })),
  remoteAgentsDir: () => null,
}));

vi.mock('../src/tools/compose-permissions.js', () => ({
  composePermissions: vi.fn(async () => '✅ permissions composed'),
}));

import { addAgent } from '../src/services/registry.js';
import {
  warmMemberHomeDirs,
  getCachedMemberPathContext,
  clearMemberHomeDirCache,
} from '../src/services/member-home.js';
import { registerMember } from '../src/tools/register-member.js';

/** Let the fire-and-forget probe's promise chain settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('SF-18: member home-dir cache warming', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    clearMemberHomeDirCache();
    mockExecCommand.mockReset();
    mockTestConnection.mockReset();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 1 });
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd.includes('$HOME')) return { stdout: '/export/home/bella\n', stderr: '', code: 0 };
      // Windows probe is delivered via wrapPowerShellEncoded (base64
      // -EncodedCommand), not a raw inline string -- decode to inspect it.
      const decoded = decodePowerShellEncodedCommand(cmd);
      if (decoded.includes('USERPROFILE')) return { stdout: 'D:\\Profiles\\bella', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });
  });

  afterEach(() => {
    restoreRegistry();
    clearMemberHomeDirCache();
  });

  describe('warmMemberHomeDirs', () => {
    it.each(['claude'] as const)(
      'warms a remote %s member -- the guess is replaced by the PROBED home dir',
      async provider => {
        const agent = makeTestAgent({ username: 'bella', os: 'linux', llmProvider: provider });
        addAgent(agent);

        // Before: the username-convention guess, not ground truth.
        const before = getCachedMemberPathContext(agent);
        expect(before.source).toBe('username-fallback');
        expect(before.homeDir).toBe('/home/bella');

        warmMemberHomeDirs([agent]);

        // Fire-and-forget: the call returns before the probe resolves.
        expect(getCachedMemberPathContext(agent).source).toBe('username-fallback');

        await settle();

        const after = getCachedMemberPathContext(agent);
        expect(after.source).toBe('probe');
        // The member's REAL home -- a relocated one the guess would never find.
        expect(after.homeDir).toBe('/export/home/bella');
      }
    );

    it('warms a Windows remote member with its probed USERPROFILE', async () => {
      const agent = makeTestAgent({ username: 'bella', os: 'windows', llmProvider: 'claude' });
      addAgent(agent);

      warmMemberHomeDirs([agent]);
      await settle();

      expect(getCachedMemberPathContext(agent)).toMatchObject({
        source: 'probe',
        homeDir: 'D:\\Profiles\\bella',
      });
    });

    it('never probes local members (os.homedir() is already exactly right)', async () => {
      const agent = makeTestLocalAgent({ llmProvider: 'claude' });
      addAgent(agent);

      warmMemberHomeDirs([agent]);
      await settle();

      expect(mockExecCommand).not.toHaveBeenCalled();
      expect(getCachedMemberPathContext(agent).source).toBe('local');
    });

    it.each(['codex', 'copilot', 'none'] as const)(
      'never probes a %s member -- that provider has no member-side log path to build',
      async provider => {
        const agent = makeTestAgent({ username: 'bella', os: 'linux', llmProvider: provider });
        addAgent(agent);

        warmMemberHomeDirs([agent]);
        await settle();

        expect(mockExecCommand).not.toHaveBeenCalled();
      }
    );

    it('does not re-probe a member whose home dir is already cached', async () => {
      const agent = makeTestAgent({ username: 'bella', os: 'linux', llmProvider: 'claude' });
      addAgent(agent);

      warmMemberHomeDirs([agent]);
      await settle();
      const callsAfterFirst = mockExecCommand.mock.calls.length;
      expect(callsAfterFirst).toBe(1);

      warmMemberHomeDirs([agent]);
      await settle();
      expect(mockExecCommand.mock.calls.length).toBe(callsAfterFirst);
    });

    it('a failed probe leaves the username guess in place and never throws', async () => {
      const agent = makeTestAgent({ username: 'bella', os: 'linux', llmProvider: 'claude' });
      addAgent(agent);
      mockExecCommand.mockRejectedValue(new Error('ssh: connect failed'));

      expect(() => warmMemberHomeDirs([agent])).not.toThrow();
      await settle();

      expect(getCachedMemberPathContext(agent).source).toBe('username-fallback');
    });
  });

  describe('register_member', () => {
    it('warms the home-dir cache for a newly registered remote Claude member', async () => {
      const result = await registerMember({
        friendly_name: 'sf18-remote',
        member_type: 'remote',
        host: '192.0.2.10',
        port: 22,
        username: 'bella',
        auth_type: 'key',
        key_path: '/tmp/fake-key',
        work_folder: '/export/home/bella/repo',
        llm_provider: 'claude',
      } as any);

      expect(result).toContain('registered successfully');
      await settle();

      const { getAllAgents } = await import('../src/services/registry.js');
      const agent = getAllAgents().find(a => a.friendlyName === 'sf18-remote')!;
      expect(agent).toBeDefined();

      expect(getCachedMemberPathContext(agent)).toMatchObject({
        source: 'probe',
        homeDir: '/export/home/bella',
      });
    });
  });
});
