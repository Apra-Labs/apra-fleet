import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
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
  describe('Non-AGY providers are unchanged by project binding', () => {
    it('claude, codex, copilot and opencode have no project flag and no pre-delivery hook', () => {
      for (const p of [new ClaudeProvider(), new CodexProvider(), new CopilotProvider(), new OpenCodeProvider()]) {
        expect((p as any).preparePermissionsDelivery).toBeUndefined();
        expect((p as any).projectFlag).toBeUndefined();
        expect((p as any).requiresGitAwareness).toBeUndefined();
      }
    });

    it('their POSIX prompt commands never carry --project, even when a projectId is supplied', () => {
      for (const p of [new ClaudeProvider(), new CodexProvider(), new CopilotProvider(), new OpenCodeProvider()]) {
        const opts = { folder: '/w', promptFile: 'p.md' };
        expect(p.buildPromptCommand({ ...opts, projectId: 'x' } as any)).toBe(p.buildPromptCommand(opts));
      }
    });
  });

  describe('AGY requires a project id for permission config', () => {
    it('throws when the agent or its agyProjectId is missing', () => {
      const agy = new AgyProvider();
      expect(() => agy.permissionConfigPaths(undefined)).toThrow();
      expect(() => agy.composePermissionConfig('doer', [], undefined)).toThrow();
      const noId = makeTestAgent({ llmProvider: 'agy', workFolder: '/tmp/w' });
      expect(() => agy.composePermissionConfig('doer', [], noId)).toThrow(/no agy project id/);
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
        agyProjectId: '1afd6dbb-498f-4918-a9d9-6da64b75a204',
      });
      const configs = agy.composePermissionConfig('doer', ['Read', 'Write'], agent);
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

    it('runs checkAgyMemberSkills through LocalStrategy for a Windows gitbash member', async () => {
      if (process.platform !== 'win32') return;
      const home = makeScratch('fleet-strat-skills-home-');
      const gbAgent = makeTestAgent({
        id: 'agent-gb-skills',
        agentType: 'local',
        llmProvider: 'agy',
        workFolder: makeScratch('fleet-strat-skills-work-'),
        os: 'windows',
        shell: 'gitbash',
      });
      const gbStrat = getStrategy(gbAgent);
      const skillsRes = await checkAgyMemberSkills((cmd, t) => gbStrat.execCommand(cmd, t), home, 'windows', 'gitbash');
      expect(skillsRes.installed).toEqual([]);
      expect(skillsRes.probeFailed).toBe(false);
      expect(skillsRes.warning).toBeUndefined();
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

        const pid = '1afd6dbb-498f-4918-a9d9-6da64b75a204';
        const projDir = path.join(home, '.gemini', 'config', 'projects');
        fs.mkdirSync(projDir, { recursive: true });
        fs.writeFileSync(path.join(projDir, pid + '.json'), JSON.stringify({ id: pid, name: 'w' }));
        const member = makeTestAgent({
          friendlyName: 'agy-skills-warn',
          agentType: 'local',
          llmProvider: 'agy',
          os: hostOs,
          workFolder: work,
          agyProjectId: pid,
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
        const pid = '1afd6dbb-498f-4918-a9d9-6da64b75a204';
        const projDir = path.join(home, '.gemini', 'config', 'projects');
        fs.mkdirSync(projDir, { recursive: true });
        fs.writeFileSync(path.join(projDir, pid + '.json'), JSON.stringify({ id: pid, name: 'w' }));
        const member = makeTestAgent({
          friendlyName: 'agy-probe-fail',
          agentType: 'local',
          llmProvider: 'agy',
          os: hostOs,
          workFolder: work,
          agyProjectId: pid,
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
