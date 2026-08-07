/**
 * SF-17: register_member / update_member must reject a work_folder that is not
 * fully qualified for REMOTE members.
 *
 * A remote member's work_folder is used verbatim in commands run on the
 * MEMBER's machine -- `~` and relative paths are never resolved for it (only
 * local members go through resolveTilde, deliberately, because the hub's home
 * dir is not the member's). Rejecting at registration/update time means an
 * LLM-driven caller simply re-issues the call with an absolute path, instead of
 * the system inventing a runtime resolution.
 *
 * Local members must be UNAFFECTED: `~` is already correct for them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent, getAllAgents } from '../src/services/registry.js';
import { updateMember } from '../src/tools/update-member.js';
import { registerMember } from '../src/tools/register-member.js';
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

const FQ_ERROR = 'work_folder must be a fully-qualified path for remote members';

function remoteRegisterInput(work_folder: string) {
  return {
    friendly_name: 'sf17-remote',
    member_type: 'remote',
    host: '192.0.2.10',
    port: 22,
    username: 'bella',
    auth_type: 'key',
    key_path: '/tmp/fake-key',
    work_folder,
    llm_provider: 'claude',
  } as any;
}

describe('SF-17: work_folder must be fully qualified for remote members', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    mockExecCommand.mockReset();
    mockTestConnection.mockReset();
    // Connection always fails: registration that gets PAST validation stops at
    // the connectivity check, which is all these tests need to distinguish.
    mockTestConnection.mockResolvedValue({ ok: false, error: 'Connection refused' });
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 1 });
  });

  afterEach(() => {
    restoreRegistry();
  });

  describe('register_member', () => {
    it.each([
      ['~/repo', 'tilde-relative'],
      ['~bella/repo', 'tilde-user-relative'],
      ['repo/sub', 'plain relative'],
      ['./repo', 'dot-relative'],
    ])('rejects %s (%s) and registers nothing', async (workFolder) => {
      const result = await registerMember(remoteRegisterInput(workFolder));

      expect(result).toContain(FQ_ERROR);
      expect(result).toContain(`got "${workFolder}"`);
      expect(result).toContain('Member was NOT registered.');
      expect(getAllAgents()).toHaveLength(0);
      // Rejected before any member-side work is attempted.
      expect(mockTestConnection).not.toHaveBeenCalled();
      expect(mockExecCommand).not.toHaveBeenCalled();
    });

    it.each([
      '/home/bella/repo',
      'C:\\Users\\bella\\repo',
      'C:/Users/bella/repo',
      '\\\\fileserver\\share\\repo',
    ])('accepts the fully-qualified path %s (validation passes; failure is the connectivity check)', async (workFolder) => {
      const result = await registerMember(remoteRegisterInput(workFolder));

      expect(result).not.toContain(FQ_ERROR);
      expect(result).toContain('Failed to connect');
      expect(mockTestConnection).toHaveBeenCalled();
    });

    it('does NOT apply the rule to local members -- a ~-relative work_folder is still accepted', async () => {
      // Local members resolve `~` against this process's own home dir
      // (resolveTilde), so the restriction must not leak onto them. Asserted at
      // the validation boundary: the FQ rejection is what must not appear.
      const result = await registerMember({
        friendly_name: 'sf17-local',
        member_type: 'local',
        work_folder: '~/sf17-local-never-created',
        llm_provider: 'claude',
      } as any);

      expect(result).not.toContain(FQ_ERROR);
    });
  });

  describe('update_member', () => {
    it.each([
      ['~/repo', 'tilde-relative'],
      ['repo/sub', 'plain relative'],
    ])('rejects %s (%s) for a remote member and leaves the stored folder unchanged', async (workFolder) => {
      const member = makeTestAgent({ workFolder: '/home/testuser/project' });
      addAgent(member);

      const result = await updateMember({ member_id: member.id, work_folder: workFolder });

      expect(result).toContain(FQ_ERROR);
      expect(result).toContain(`got "${workFolder}"`);
      expect(result).toContain('Member was NOT updated.');
      expect(getAllAgents()[0].workFolder).toBe('/home/testuser/project');
    });

    it('accepts a fully-qualified path for a remote member', async () => {
      const member = makeTestAgent({ workFolder: '/home/testuser/project' });
      addAgent(member);

      const result = await updateMember({ member_id: member.id, work_folder: '/srv/work/repo' });

      expect(result).not.toContain(FQ_ERROR);
      expect(getAllAgents()[0].workFolder).toBe('/srv/work/repo');
    });

    it('does NOT apply the rule to local members -- a ~-relative work_folder still updates', async () => {
      const member = makeTestLocalAgent();
      addAgent(member);

      const result = await updateMember({ member_id: member.id, work_folder: '~/local-repo' });

      expect(result).not.toContain(FQ_ERROR);
      expect(getAllAgents()[0].workFolder).toBe('~/local-repo');
    });
  });
});
