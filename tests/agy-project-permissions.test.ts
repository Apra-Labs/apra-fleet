import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgyProvider } from '../src/providers/agy.js';
import { detectIsGit, deepMerge } from '../src/tools/compose-permissions.js';
import type { Agent } from '../src/types.js';

describe('AGY Project Permissions & User Journeys', () => {
  const provider = new AgyProvider();

  const mockAgent: Agent = {
    id: 'agent-toy-1',
    friendlyName: 'toy-agy',
    llmProvider: 'agy',
    workFolder: '/home/testuser/work/my-project',
    agentType: 'local',
    status: 'idle',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  describe('Deterministic Project Configuration Path', () => {
    it('computes deterministic project path based on fleet-<agent-id>', () => {
      const paths = provider.permissionConfigPaths(mockAgent);
      expect(paths).toEqual(['~/.gemini/config/projects/fleet-agent-toy-1.json']);
    });

    it('falls back to fleet-default when agent is omitted', () => {
      const paths = provider.permissionConfigPaths();
      expect(paths).toEqual(['~/.gemini/config/projects/fleet-default.json']);
    });
  });

  describe('Journey A & B: Pre-existing / Cloned Git Repository', () => {
    it('emits gitFolder resource with folderUri and allowWrite', () => {
      const allow = ['Read', 'Write', 'Bash(git:*)', 'Bash(npm:*)'];
      const configs = provider.composePermissionConfig('doer', allow, mockAgent, true);
      expect(configs).toHaveLength(1);

      const cfg = configs[0] as Record<string, any>;
      expect(cfg.id).toBe('fleet-agent-toy-1');
      expect(cfg.name).toBe('/home/testuser/work/my-project');

      const resources = cfg.projectResources.resources;
      expect(resources).toHaveLength(1);
      expect(resources[0]).toEqual({
        gitFolder: {
          folderUri: 'file:///home/testuser/work/my-project',
          allowWrite: true,
        },
      });

      // Protobuf oneof safety: folderUri MUST NOT be a sibling of gitFolder
      expect(resources[0].folderUri).toBeUndefined();

      // Permission grants shape
      expect(cfg.permissionGrants.allow).toEqual([
        'read_file(*)',
        'write_file(*)',
        'command(git)',
        'command(npm)',
      ]);
    });
  });

  describe('Journey C: Greenfield Scratch Directory & Dynamic Git Mutation', () => {
    const scratchAgent: Agent = {
      ...mockAgent,
      id: 'agent-scratch',
      workFolder: '/tmp/greenfield-scratch',
    };

    it('emits folderUri resource for non-git scratch directory', () => {
      const allow = ['Read', 'Write'];
      const configs = provider.composePermissionConfig('doer', allow, scratchAgent, false);
      expect(configs).toHaveLength(1);

      const cfg = configs[0] as Record<string, any>;
      expect(cfg.id).toBe('fleet-agent-scratch');
      expect(cfg.name).toBe('/tmp/greenfield-scratch');

      const resources = cfg.projectResources.resources;
      expect(resources).toHaveLength(1);
      expect(resources[0]).toEqual({
        folderUri: 'file:///tmp/greenfield-scratch',
      });

      // Protobuf oneof safety: gitFolder MUST NOT exist for non-git
      expect(resources[0].gitFolder).toBeUndefined();
    });

    it('morphs in-place from folderUri to gitFolder via deepMerge without duplicate roots', () => {
      const initialConfigs = provider.composePermissionConfig('doer', ['Read'], scratchAgent, false);
      const existingOnDisk = initialConfigs[0] as Record<string, any>;

      expect(existingOnDisk.projectResources.resources[0].folderUri).toBe('file:///tmp/greenfield-scratch');
      expect(existingOnDisk.projectResources.resources[0].gitFolder).toBeUndefined();

      // Agent initializes git mid-sprint -> new compose call with isGit=true
      const upgradedConfigs = provider.composePermissionConfig('doer', ['Read', 'Write', 'Bash(git:*)'], scratchAgent, true);
      const incomingUpdate = upgradedConfigs[0] as Record<string, any>;

      const merged = deepMerge(existingOnDisk, incomingUpdate) as Record<string, any>;

      // Verify clean in-place replacement: exactly 1 resource, now gitFolder
      expect(merged.projectResources.resources).toHaveLength(1);
      expect(merged.projectResources.resources[0]).toEqual({
        gitFolder: {
          folderUri: 'file:///tmp/greenfield-scratch',
          allowWrite: true,
        },
      });
      expect(merged.projectResources.resources[0].folderUri).toBeUndefined();
      expect(merged.permissionGrants.allow).toContain('command(git)');
    });
  });

  describe('Claim and Purge of Conflicting Project Configs', () => {
    it('executes node cleanup script targeting matching URI while keeping fleet-<id>', async () => {
      const mockExec = vi.fn().mockResolvedValue({
        code: 0,
        stdout: JSON.stringify(['old-uuid-12345.json']),
        stderr: '',
      });

      const purged = await provider.purgeConflictingProjects(mockAgent, mockExec, '/home/testuser');

      expect(purged).toEqual(['old-uuid-12345.json']);
      expect(mockExec).toHaveBeenCalledTimes(1);

      const executedCmd = mockExec.mock.calls[0][0] as string;
      expect(executedCmd).toContain('node -e');
      expect(executedCmd).toContain('file:///home/testuser/work/my-project');
      expect(executedCmd).toContain('fleet-agent-toy-1');
    });

    it('returns empty array when no conflicting project files exist', async () => {
      const mockExec = vi.fn().mockResolvedValue({
        code: 0,
        stdout: '[]',
        stderr: '',
      });

      const purged = await provider.purgeConflictingProjects(mockAgent, mockExec);
      expect(purged).toEqual([]);
    });
  });

  describe('Workspace Trust Seeding', () => {
    it('seeds trustedWorkspaces in settings.json when missing', async () => {
      let remoteSettings = JSON.stringify({
        defaultModel: 'gemini-3.5-flash',
        trustedWorkspaces: ['/other/path'],
      });

      const mockExec = vi.fn().mockImplementation(async (cmd: string) => {
        if (cmd.includes('cat >') || cmd.includes('WriteAllText')) {
          const match = cmd.match(/<< 'FLEET_AGY_SETTINGS_EOF'\n([\s\S]*?)\nFLEET_AGY_SETTINGS_EOF/);
          if (match) remoteSettings = match[1];
          return { code: 0, stdout: '', stderr: '' };
        }
        if (cmd.includes('cat ') || cmd.includes('Get-Content')) {
          return { code: 0, stdout: remoteSettings, stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      });

      const result = await provider.ensureWorkspaceTrusted(
        '/home/testuser/work/my-project',
        mockExec,
        'linux',
      );

      expect(result.seeded).toBe(true);
      expect(result.detail).toContain('added "/home/testuser/work/my-project" to trustedWorkspaces');

      const parsed = JSON.parse(remoteSettings);
      expect(parsed.trustedWorkspaces).toContain('/other/path');
      expect(parsed.trustedWorkspaces).toContain('/home/testuser/work/my-project');
    });

    it('no-ops when workFolder is already in trustedWorkspaces', async () => {
      const remoteSettings = JSON.stringify({
        trustedWorkspaces: ['/home/testuser/work/my-project'],
      });

      const mockExec = vi.fn().mockResolvedValue({
        code: 0,
        stdout: remoteSettings,
        stderr: '',
      });

      const result = await provider.ensureWorkspaceTrusted(
        '/home/testuser/work/my-project',
        mockExec,
        'linux',
      );

      expect(result.seeded).toBe(false);
      expect(result.detail).toContain('already in trustedWorkspaces');
      // No write command should be executed
      expect(mockExec.mock.calls.some(c => (c[0] as string).includes('FLEET_AGY_SETTINGS_EOF'))).toBe(false);
    });
  });
});
