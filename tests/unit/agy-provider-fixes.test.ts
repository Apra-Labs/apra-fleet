import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  toAgyFileUri,
  normalizeAgyUri,
  buildAgyPurgeCommand,
  buildAgyPurgeScript,
  cleanGlobalAgySettings,
  checkAgyGlobalSkillsWarning,
  checkAgyMemberSkills,
  AGY_ORCHESTRATOR_DENY_RULES,
  AGY_ORCHESTRATOR_DENIED_TOOLS,
  AGY_MEMBER_ALLOWED_TOOLS,
  AgyProvider,
  convertClaudeAllowToAgyPermissions,
  formatAgyPermissionRules,
  buildAgyNodeCommand,
} from '../../src/providers/agy.js';
import { getStrategy } from '../../src/services/strategy.js';
import { buildRequiredPerms } from '../../src/cli/install.js';
import { getProviderInstallConfig } from '../../src/cli/config.js';
import { ClaudeProvider } from '../../src/providers/claude.js';
import { CodexProvider } from '../../src/providers/codex.js';
import { CopilotProvider } from '../../src/providers/copilot.js';
import { OpenCodeProvider } from '../../src/providers/opencode.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';
import { addAgent } from '../../src/services/registry.js';
import { composePermissions } from '../../src/tools/compose-permissions.js';
import { execSync } from 'node:child_process';

const scratchDirs: string[] = [];

function makeScratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {}
  }
});

describe('AGY Fix 519 - Unit Verification Suite', { timeout: 30000 }, () => {
  describe('Finding 4: toAgyFileUri and normalizeAgyUri', () => {
    it('formats POSIX and Windows URIs with 3 slashes', () => {
      expect(toAgyFileUri('/home/user/repo')).toBe('file:///home/user/repo');
      expect(toAgyFileUri('C:\\Users\\user\\repo')).toBe('file:///C:/Users/user/repo');
      expect(toAgyFileUri('d:/projects/my-repo/')).toBe('file:///d:/projects/my-repo');
    });

    it('normalizes URIs for comparison (2 vs 3 slashes, drive letter case, trailing slashes)', () => {
      expect(normalizeAgyUri('file://C:/Users/user/repo/')).toBe('file:///c:/users/user/repo');
      expect(normalizeAgyUri('file:///c:/users/user/repo')).toBe('file:///c:/users/user/repo');
      expect(normalizeAgyUri('file:///C:/Users/user/repo')).toBe('file:///c:/users/user/repo');
      expect(normalizeAgyUri('file://d:/test')).toBe('file:///d:/test');
    });
  });

  describe('Finding 1 & 2: Purge script execution & file filtering', () => {
    it('executes generated purge command for real against scratch folder', async () => {
      const home = makeScratch('fleet-purge-home-');
      const targetDir = makeScratch('fleet-target-');
      const projectsDir = path.join(home, '.gemini', 'config', 'projects');
      fs.mkdirSync(projectsDir, { recursive: true });

      const targetUri = toAgyFileUri(targetDir);
      const keepId = 'fleet-agent-123';

      // 1. Target fleet project to keep
      fs.writeFileSync(
        path.join(projectsDir, `${keepId}.json`),
        JSON.stringify({
          id: keepId,
          projectResources: { resources: [{ folderUri: targetUri }] },
        })
      );

      // 2. Conflicting fleet project to purge (rename to .bak)
      const conflictFleetId = 'fleet-agent-old';
      const conflictFleetFile = path.join(projectsDir, `${conflictFleetId}.json`);
      fs.writeFileSync(
        conflictFleetFile,
        JSON.stringify({
          id: conflictFleetId,
          projectResources: { resources: [{ folderUri: targetUri }] },
        })
      );

      // 3. Conflicting human (non-fleet) project (must NOT be deleted or renamed)
      const humanFile = path.join(projectsDir, 'human-project.json');
      fs.writeFileSync(
        humanFile,
        JSON.stringify({
          id: 'human-project',
          projectResources: { resources: [{ folderUri: targetUri }] },
        })
      );

      const agy = new AgyProvider();
      const agent = makeTestAgent({
        id: 'agent-123',
        agentType: 'local',
        llmProvider: 'agy',
        workFolder: targetDir,
      });

      const execFn = async (cmd: string) => {
        const stdout = execSync(cmd, { encoding: 'utf-8', shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash' });
        return { code: 0, stdout, stderr: '' };
      };

      const purged = await agy.purgeConflictingProjects(
        agent,
        execFn,
        home,
        process.platform === 'win32' ? 'windows' : 'linux',
      );

      expect(purged).toContain(`${conflictFleetId}.json`);
      expect(fs.existsSync(path.join(projectsDir, `${conflictFleetId}.json.bak`))).toBe(true);
      expect(fs.existsSync(conflictFleetFile)).toBe(false);

      // Human project must be preserved
      expect(fs.existsSync(humanFile)).toBe(true);
      // Kept fleet project must be preserved
      expect(fs.existsSync(path.join(projectsDir, `${keepId}.json`))).toBe(true);
    });

    it('runs generated purge command through LocalStrategy for both Windows shells and POSIX heredoc under bash', async () => {
      const home = makeScratch('fleet-strat-home-');
      const workFolder = makeScratch('fleet-strat-work-');
      const projectsDir = path.join(home, '.gemini', 'config', 'projects');
      fs.mkdirSync(projectsDir, { recursive: true });

      const targetUri = toAgyFileUri(workFolder);
      const keepId = 'fleet-agent-keep';

      if (process.platform === 'win32') {
        // 1. Windows GitBash member (apra-fleet LocalStrategy)
        const gbAgent = makeTestAgent({
          id: 'agent-gb',
          agentType: 'local',
          llmProvider: 'agy',
          workFolder,
          os: 'windows',
          shell: 'gitbash',
        });
        const gbStrat = getStrategy(gbAgent);
        const gbCmd = buildAgyPurgeCommand(targetUri, keepId, home, 'windows', 'gitbash');
        const gbRes = await gbStrat.execCommand(gbCmd);
        expect(gbRes.code).toBe(0);
        const gbJson = JSON.parse(gbRes.stdout.trim());
        expect(gbJson).toEqual({ purged: [], warnings: [] });

        // 2. Windows PowerShell member (apra-fleet LocalStrategy)
        const psAgent = makeTestAgent({
          id: 'agent-ps',
          agentType: 'local',
          llmProvider: 'agy',
          workFolder,
          os: 'windows',
        });
        const psStrat = getStrategy(psAgent);
        const psCmd = buildAgyPurgeCommand(targetUri, keepId, home, 'windows');
        const psRes = await psStrat.execCommand(psCmd);
        expect(psRes.code).toBe(0);
        const psJson = JSON.parse(psRes.stdout.trim());
        expect(psJson).toEqual({ purged: [], warnings: [] });
      }

      // 3. POSIX heredoc path under bash (where bash is available)
      const posixCmd = buildAgyPurgeCommand('file:///home/user/repo', 'keep-id', '/tmp/nonexistent-home', 'linux');
      try {
        const bashOut = execSync('bash', { input: posixCmd, encoding: 'utf-8' });
        const posixJson = JSON.parse(bashOut.trim());
        expect(posixJson).toEqual({ purged: [], warnings: [] });
      } catch (e: any) {
        if (e.code === 'ENOENT') {
          // bash not available on this environment; skip POSIX execution
        } else {
          throw e;
        }
      }
    });

    it('runs generated cleanGlobalAgySettings and checkAgyMemberSkills through LocalStrategy on Windows', async () => {
      if (process.platform !== 'win32') return;

      const home = makeScratch('fleet-strat-clean-home-');
      const workFolder = makeScratch('fleet-strat-clean-work-');

      const gbAgent = makeTestAgent({
        id: 'agent-gb-clean',
        agentType: 'local',
        llmProvider: 'agy',
        workFolder,
        os: 'windows',
        shell: 'gitbash',
      });
      const gbStrat = getStrategy(gbAgent);

      // cleanGlobalAgySettings through strategy
      const cleaned = await cleanGlobalAgySettings(
        (cmd, t) => gbStrat.execCommand(cmd, t),
        home,
        'windows',
        'gitbash',
      );
      expect(typeof cleaned).toBe('boolean');

      // checkAgyMemberSkills through strategy
      const skillsRes = await checkAgyMemberSkills(
        (cmd, t) => gbStrat.execCommand(cmd, t),
        home,
        'windows',
        'gitbash',
      );
      expect(skillsRes.installed).toEqual([]);
      expect(skillsRes.probeFailed).toBe(false);
      expect(skillsRes.warning).toBeUndefined();
    });
  });

  describe('Finding 3: Global cleanup migration', () => {
    it('removes only fleet-authored entries/keys from global settings.json idempotently', async () => {
      const home = makeScratch('fleet-clean-home-');
      const settingsDir = path.join(home, '.gemini', 'antigravity-cli');
      fs.mkdirSync(settingsDir, { recursive: true });
      const settingsFile = path.join(settingsDir, 'settings.json');

      const installerConfig = getProviderInstallConfig('agy', home);
      const installerRules = formatAgyPermissionRules(
        convertClaudeAllowToAgyPermissions(buildRequiredPerms(installerConfig))
      );
      const skillsDirPerm = installerRules.find(r => r.includes('skills')) || `read_file(${path.join(home, '.gemini', 'antigravity-cli', 'skills').replace(/\\/g, '/')})`;

      fs.writeFileSync(
        settingsFile,
        JSON.stringify({
          defaultModel: 'gemini-3.5-flash',
          mcpServers: {
            'apra-fleet': { disabled: true },
            'user-mcp': { command: 'node user.js' },
          },
          skillOverrides: { pm: 'off', fleet: 'off', customSkill: 'off' },
          permissions: {
            allow: [
              'read_file(*)',
              'command(git)',
              'command(my-custom-cmd)',
              'mcp(apra-fleet/*)',
              skillsDirPerm,
              { action: 'read_file', target: '*' },
              'write_file(docs)',
              'mcp(apra-fleet/kb_stats)',
            ],
          },
        })
      );

      const execFn = async (cmd: string) => {
        const stdout = execSync(cmd, { encoding: 'utf-8', shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash' });
        return { code: 0, stdout, stderr: '' };
      };

      const cleaned = await cleanGlobalAgySettings(
        execFn,
        home,
        process.platform === 'win32' ? 'windows' : 'linux',
      );

      expect(cleaned).toBe(true);

      const after = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      expect(after.defaultModel).toBe('gemini-3.5-flash');
      expect(after.mcpServers['user-mcp']).toBeDefined();
      expect(after.mcpServers['apra-fleet']).toBeUndefined();
      expect(after.skillOverrides).toEqual({ customSkill: 'off' });
      expect(after.permissions.allow).toEqual([
        'read_file(*)',
        'command(git)',
        'command(my-custom-cmd)',
        'mcp(apra-fleet/*)',
        skillsDirPerm,
      ]);

      // Marker file must exist (v2)
      expect(fs.existsSync(path.join(settingsDir, '.fleet-cleaned-v2'))).toBe(true);

      // Idempotent re-run
      const cleanedAgain = await cleanGlobalAgySettings(
        execFn,
        home,
        process.platform === 'win32' ? 'windows' : 'linux',
      );
      expect(cleanedAgain).toBe(false);
    });

    it('does not modify settings.json if it contains unparseable invalid JSON', async () => {
      const home = makeScratch('fleet-clean-invalid-');
      const settingsDir = path.join(home, '.gemini', 'antigravity-cli');
      fs.mkdirSync(settingsDir, { recursive: true });
      const settingsFile = path.join(settingsDir, 'settings.json');
      const rawContent = '{ invalid json content';
      fs.writeFileSync(settingsFile, rawContent);

      const execFn = async (cmd: string) => {
        const stdout = execSync(cmd, { encoding: 'utf-8', shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash' });
        return { code: 0, stdout, stderr: '' };
      };

      const cleaned = await cleanGlobalAgySettings(
        execFn,
        home,
        process.platform === 'win32' ? 'windows' : 'linux',
      );

      expect(cleaned).toBe(false);
      expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(rawContent);
      expect(fs.existsSync(path.join(settingsDir, '.fleet-cleaned-v1'))).toBe(false);
    });
  });

  describe('Decision 18 & Finding 9: Non-AGY provider negative tests', () => {
    it('proves non-AGY providers (claude, codex, copilot, opencode) do not purge or have git-awareness flag', () => {
      const claude = new ClaudeProvider();
      const codex = new CodexProvider();
      const copilot = new CopilotProvider();
      const opencode = new OpenCodeProvider();

      expect(claude.preparePermissionsDelivery).toBeUndefined();
      expect(codex.preparePermissionsDelivery).toBeUndefined();
      expect(copilot.preparePermissionsDelivery).toBeUndefined();
      expect(opencode.preparePermissionsDelivery).toBeUndefined();

      expect(claude.requiresGitAwareness).toBeFalsy();
      expect(codex.requiresGitAwareness).toBeFalsy();
      expect(copilot.requiresGitAwareness).toBeFalsy();
      expect(opencode.requiresGitAwareness).toBeFalsy();
    });
  });

  describe('Finding 10: agy.ts fallback validation', () => {
    it('throws when agent is missing in permissionConfigPaths or composePermissionConfig', () => {
      const agy = new AgyProvider();
      expect(() => agy.permissionConfigPaths(undefined)).toThrow();
      expect(() => agy.composePermissionConfig('doer', [], undefined)).toThrow();
    });
  });

  describe('AGY ensureWorkspaceTrusted atomic staging & abort on invalid read', () => {
    it('stages settings write to temp file and moves into place via transport', async () => {
      const agy = new AgyProvider();
      const transport = {
        readHomeFile: vi.fn().mockResolvedValue({ found: true, content: '{"trustedWorkspaces":[]}' }),
        writeHomeFile: vi.fn().mockResolvedValue(undefined),
      };
      const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });

      const res = await agy.ensureWorkspaceTrusted('/tmp/work', exec, 'linux', undefined, transport as any);
      expect(res.seeded).toBe(true);

      // Writes to temp file first (not settings.json directly)
      expect(transport.writeHomeFile).toHaveBeenCalledTimes(1);
      const targetRel = transport.writeHomeFile.mock.calls[0][0];
      expect(targetRel).not.toBe('.gemini/antigravity-cli/settings.json');
      expect(targetRel).toMatch(/settings\.json\.fleet-trust-.*\.tmp/);

      // Exec moves temp file into place (mkdir + move)
      expect(exec).toHaveBeenCalledTimes(2);
      expect(exec.mock.calls[1][0]).toMatch(/mv ".*\.tmp" ".*settings\.json"/);
    });

    it('aborts rewrite when settings.json read fails or contains invalid JSON', async () => {
      const agy = new AgyProvider();
      const transport = {
        readHomeFile: vi.fn().mockResolvedValue({ found: true, content: '{invalid-json' }),
        writeHomeFile: vi.fn().mockResolvedValue(undefined),
      };
      const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
      const res = await agy.ensureWorkspaceTrusted('/tmp/work', exec, 'linux', undefined, transport as any);
      expect(res.seeded).toBe(false);
      expect(res.detail).toContain('aborted rewrite');
      expect(transport.writeHomeFile).not.toHaveBeenCalled();
    });
  });

  describe('AGY Fix 519 - FIX 2: Member Isolation & Deny Rules', () => {
    it('populates permissionGrants.deny with explicit orchestrator deny rules in composePermissionConfig', () => {
      const agy = new AgyProvider();
      const agent = makeTestAgent({
        id: 'agent-deny-test',
        agentType: 'local',
        llmProvider: 'agy',
        workFolder: '/tmp/work-folder',
      });
      const configs = agy.composePermissionConfig('doer', ['Read', 'Write'], agent, true);
      expect(configs).toHaveLength(1);
      const cfg = configs[0] as Record<string, any>;

      const denyList: string[] = cfg.permissionGrants.permissionGrants.deny;
      expect(denyList).toEqual(AGY_ORCHESTRATOR_DENY_RULES);
      expect(denyList).toContain('mcp(apra-fleet/remove_member)');
      expect(denyList).toContain('mcp(apra-fleet-member/remove_member)');
      expect(denyList).toContain('mcp(apra-fleet/execute_prompt)');
      expect(denyList).toContain('mcp(apra-fleet-member/execute_prompt)');
      expect(denyList).toContain('mcp(apra-fleet/shutdown_server)');

      // Member-needed read tools must NOT be in deny list
      expect(denyList).not.toContain('mcp(apra-fleet/kb_query)');
      expect(denyList).not.toContain('mcp(apra-fleet/code_query)');
    });

    it('detects global pm and fleet skills and returns warning via checkAgyGlobalSkillsWarning', () => {
      const home = makeScratch('fleet-skills-home-');
      const pmSkillDir = path.join(home, '.gemini', 'antigravity-cli', 'skills', 'pm');
      fs.mkdirSync(pmSkillDir, { recursive: true });

      const warn = checkAgyGlobalSkillsWarning(home);
      expect(warn).not.toBeNull();
      expect(warn).toContain('Global skill(s) [pm]');
      expect(warn).toContain('visible to AGY members');
    });

    it('executes checkAgyMemberSkills via execCommand and returns warning without throwing when global skills exist', async () => {
      const home = makeScratch('fleet-skills-exec-home-');
      const pmSkillDir = path.join(home, '.gemini', 'antigravity-cli', 'skills', 'pm');
      const fleetSkillDir = path.join(home, '.gemini', 'antigravity-cli', 'skills', 'fleet');
      fs.mkdirSync(pmSkillDir, { recursive: true });
      fs.mkdirSync(fleetSkillDir, { recursive: true });

      const execFn = async (cmd: string) => {
        const stdout = execSync(cmd, { encoding: 'utf-8', shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash' });
        return { code: 0, stdout, stderr: '' };
      };

      const result = await checkAgyMemberSkills(execFn, home, process.platform === 'win32' ? 'windows' : 'linux');
      expect(result.probeFailed).toBe(false);
      expect(result.installed).toEqual(['pm', 'fleet']);
      expect(result.warning).toContain('[fleet:warn] agy: AGY provider has no per-member skill isolation mechanism');
      expect(result.warning).toContain('Global skill(s) [pm, fleet]');
    });

    it('executes checkAgyMemberSkills and returns clean result when no global skills exist', async () => {
      const home = makeScratch('fleet-skills-clean-home-');
      const execFn = async (cmd: string) => {
        const stdout = execSync(cmd, { encoding: 'utf-8', shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash' });
        return { code: 0, stdout, stderr: '' };
      };

      const result = await checkAgyMemberSkills(execFn, home, process.platform === 'win32' ? 'windows' : 'linux');
      expect(result.probeFailed).toBe(false);
      expect(result.installed).toEqual([]);
      expect(result.warning).toBeUndefined();
    });

    it('handles probe failure branches gracefully: nonzero exit code, thrown error, empty output, and unparseable output', async () => {
      // 1. Nonzero exit code
      const failExec = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'command not found: node' });
      const res1 = await checkAgyMemberSkills(failExec, '/tmp/home', 'linux');
      expect(res1.probeFailed).toBe(true);
      expect(res1.warning).toContain('member skills check probe could not run');
      expect(res1.warning).toContain('command not found: node');

      // 2. Thrown error (e.g. timeout / connection failure)
      const throwExec = vi.fn().mockRejectedValue(new Error('SSH connection timed out after 5000ms'));
      const res2 = await checkAgyMemberSkills(throwExec, '/tmp/home', 'linux');
      expect(res2.probeFailed).toBe(true);
      expect(res2.warning).toContain('member skills check probe could not run');
      expect(res2.warning).toContain('SSH connection timed out');

      // 3. Empty stdout
      const emptyExec = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
      const res3 = await checkAgyMemberSkills(emptyExec, '/tmp/home', 'linux');
      expect(res3.probeFailed).toBe(true);
      expect(res3.warning).toContain('empty output');

      // 4. Unparseable JSON stdout
      const badJsonExec = vi.fn().mockResolvedValue({ code: 0, stdout: 'SyntaxError: unexpected token', stderr: '' });
      const res4 = await checkAgyMemberSkills(badJsonExec, '/tmp/home', 'linux');
      expect(res4.probeFailed).toBe(true);
      expect(res4.warning).toContain('unparseable output');
    });

    it('collects warnings in preparePermissionsDelivery', async () => {
      const home = makeScratch('fleet-prep-home-');
      const pmSkillDir = path.join(home, '.gemini', 'antigravity-cli', 'skills', 'pm');
      fs.mkdirSync(pmSkillDir, { recursive: true });

      const agy = new AgyProvider();
      const agent = makeTestAgent({
        id: 'agent-prep-warn',
        agentType: 'local',
        llmProvider: 'agy',
        workFolder: makeScratch('fleet-prep-work-'),
      });

      const execFn = async (cmd: string) => {
        const stdout = execSync(cmd, { encoding: 'utf-8', shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash' });
        return { code: 0, stdout, stderr: '' };
      };

      const warnings = await agy.preparePermissionsDelivery(
        agent,
        execFn,
        home,
        process.platform === 'win32' ? 'windows' : 'linux'
      );
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toContain('Global skill(s) [pm]');
    });

    it('surfaces visible warning in composePermissions result when global skills exist', async () => {
      const home = makeScratch('fleet-compose-warn-home-');
      const work = makeScratch('fleet-compose-warn-work-');
      const pmSkillDir = path.join(home, '.gemini', 'antigravity-cli', 'skills', 'pm');
      fs.mkdirSync(pmSkillDir, { recursive: true });

      const hostOs: 'windows' | 'macos' | 'linux' =
        process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
      vi.spyOn(os, 'homedir').mockReturnValue(home);
      backupAndResetRegistry();
      try {

        const member = makeTestAgent({
          friendlyName: 'agy-skills-warn',
          agentType: 'local',
          llmProvider: 'agy',
          os: hostOs,
          workFolder: work,
        });
        addAgent(member);

        // Proactive compose mode
        const resultProactive = await composePermissions({ member_id: member.id, role: 'doer' });
        expect(resultProactive).toContain('Warnings:');
        expect(resultProactive).toContain('Global skill(s) [pm]');

        // Reactive grant mode
        const resultReactive = await composePermissions({ member_id: member.id, role: 'doer', grant: ['Bash(git:*)'] });
        expect(resultReactive).toContain('Warnings:');
        expect(resultReactive).toContain('Global skill(s) [pm]');
      } finally {
        restoreRegistry();
      }
    });

    it('surfaces visible warning in composePermissions result when skills probe fails', async () => {
      const home = makeScratch('fleet-compose-probe-fail-home-');
      const work = makeScratch('fleet-compose-probe-fail-work-');

      const hostOs: 'windows' | 'macos' | 'linux' =
        process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
      vi.spyOn(os, 'homedir').mockReturnValue(home);
      backupAndResetRegistry();
      try {
        const member = makeTestAgent({
          friendlyName: 'agy-probe-fail',
          agentType: 'local',
          llmProvider: 'agy',
          os: hostOs,
          workFolder: work,
        });
        addAgent(member);

        const agy = new AgyProvider();
        vi.spyOn(agy, 'preparePermissionsDelivery').mockResolvedValue([
          '[fleet:warn] agy: member skills check probe could not run (exit code 127: node not found). Global skill isolation status unverified.'
        ]);
        const getProviderModule = await import('../../src/providers/index.js');
        const origGetProvider = getProviderModule.getProvider;
        vi.spyOn(getProviderModule, 'getProvider').mockImplementation((p) => {
          if (p === 'agy') return agy;
          return origGetProvider(p);
        });

        const result = await composePermissions({ member_id: member.id, role: 'doer' });
        expect(result).toContain('Warnings:');
        expect(result).toContain('member skills check probe could not run');
        expect(result).toContain('node not found');
      } finally {
        restoreRegistry();
      }
    });
  });

  describe('Tool registry coverage verification', () => {
    it('ensures every tool registered in tool-registry.ts is in AGY_MEMBER_ALLOWED_TOOLS or AGY_ORCHESTRATOR_DENIED_TOOLS', () => {
      const registryPath = path.resolve(__dirname, '../../src/services/tool-registry.ts');
      const content = fs.readFileSync(registryPath, 'utf8');
      const matches = [...content.matchAll(/server\.tool\s*\(\s*'([^']+)'/g)].map(m => m[1]);

      const allowedSet = new Set(AGY_MEMBER_ALLOWED_TOOLS);
      const deniedSet = new Set(AGY_ORCHESTRATOR_DENIED_TOOLS);

      const missing: string[] = [];
      const duplicates: string[] = [];

      for (const tool of matches) {
        const inAllowed = allowedSet.has(tool);
        const inDenied = deniedSet.has(tool);

        if (!inAllowed && !inDenied) {
          missing.push(tool);
        }
        if (inAllowed && inDenied) {
          duplicates.push(tool);
        }
      }

      expect(missing).toEqual([]);
      expect(duplicates).toEqual([]);
    });
  });
});
