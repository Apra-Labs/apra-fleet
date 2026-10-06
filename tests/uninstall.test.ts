import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import * as readline from 'node:readline/promises';
import { runUninstall } from '../src/cli/uninstall.js';
import * as config from '../src/cli/config.js';
import * as install from '../src/cli/install.js';
import { serverVersion } from '../src/version.js';
import {
  normalizeCommandSurfaceOutput,
  readCommandSurfaceFixture,
  fillFixturePlaceholders,
} from './helpers/regression-command-surface.js';

vi.mock('node:fs');
vi.mock('node:child_process');
vi.mock('../src/cli/install.js', () => ({
  isApraFleetRunning: vi.fn().mockReturnValue(false),
}));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(),
}));
// The MCP-server service manager is stubbed so a test that stubs
// process.platform does not drive the real per-OS manager (its graceful
// server.json stop would poll). The supervisor cleanup does not use it.
const mcpSvcMgr = vi.hoisted(() => ({
  unregister: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('../src/services/service-manager/index.js', () => ({
  getServiceManager: vi.fn(async () => mcpSvcMgr),
}));

/** fleet-supervisor unit/plist/wrapper paths (any OS). */
function isSupervisorRegistrationPath(p: unknown): boolean {
  if (typeof p !== 'string') return false;
  const s = p.replace(/\\/g, '/');
  return /\/(fleet-supervisor|apra-fleet-supervisor)\.service$/.test(s)
    || s.endsWith('/com.apra-fleet.supervisor.plist')
    || /\/apra-fleet-supervisor-service\.(bat|js)$/.test(s);
}

describe('uninstall', () => {
  const home = '/home/user';
  const fleetBase = path.join(home, '.apra-fleet');
  const installConfigPath = path.join(fleetBase, 'data', 'install-config.json');

  beforeEach(() => {
    vi.clearAllMocks();
    mcpSvcMgr.unregister.mockResolvedValue(undefined);
    mcpSvcMgr.stop.mockResolvedValue(true);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    
    // Default mocks for fs. Every path "exists" EXCEPT the fleet-supervisor
    // service registrations, so the default scenario (and the byte-for-byte
    // dry-run fixture) sees no supervisor unit on any host OS.
    vi.spyOn(fs, 'existsSync').mockImplementation((p: any) => !isSupervisorRegistrationPath(p));
    // ...and no ApraFleetSupervisor scheduled task on win32 (schtasks /Query
    // exits non-zero for a missing task).
    vi.mocked(execFileSync).mockImplementation(((cmd: string, args?: readonly string[]) => {
      if (cmd === 'schtasks' && args?.includes('/Query')) throw new Error('ERROR: The system cannot find the file specified.');
      return '' as any;
    }) as any);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ providers: { claude: { skill: 'all' } } }));
    // No built-in/user workflow dirs by default; individual tests override this.
    vi.spyOn(fs, 'readdirSync').mockReturnValue([]);

    // Default mock for readline
    (readline.createInterface as any).mockReturnValue({
      question: vi.fn().mockResolvedValue('y'),
      close: vi.fn(),
    });
  });

  it('shows help', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(runUninstall(['--help'])).rejects.toThrow('exit');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });

  it('aborts if user says no', async () => {
    (readline.createInterface as any).mockReturnValue({
      question: vi.fn().mockResolvedValue('n'),
      close: vi.fn(),
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(runUninstall([])).rejects.toThrow('exit');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Aborted.'));
    expect(fs.rmSync).not.toHaveBeenCalled();
  });

  it('performs dry-run without deleting files', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runUninstall(['--dry-run', '--yes']);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('(DRY RUN)'));
    expect(fs.rmSync).not.toHaveBeenCalled();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  // Regression guard (apra-fleet-7pm.14): uninstall --dry-run output must stay
  // byte-for-byte unchanged versus
  // tests/fixtures/regression-command-surface/uninstall-dry-run.txt after this
  // epic's install.ts/uninstall.ts/update.ts/index.ts edits land. Relies on
  // the default beforeEach mocks (single claude provider, skill 'all', no
  // settings changes, empty workflows dir listing) which reproduce the exact
  // scenario the fixture was captured from.
  // The same fixture must hold on every host OS (the default mocks report no
  // fleet-supervisor registration whatever process.platform says).
  it.each(['host', 'linux', 'darwin', 'win32'] as const)('--dry-run output is byte-for-byte unchanged versus its fixture (apra-fleet-7pm.14) [platform: %s]', async (platform) => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    if (platform !== 'host') Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    onTestFinished(() => { Object.defineProperty(process, 'platform', origPlatform); });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runUninstall(['--dry-run', '--yes']);

    const claudePaths = config.getProviderInstallConfig('claude');
    const actual = normalizeCommandSurfaceOutput(consoleSpy.mock.calls.map(c => c.join(' ')).join('\n'));
    const expected = fillFixturePlaceholders(readCommandSurfaceFixture('uninstall-dry-run.txt'), {
      VERSION: serverVersion,
      PM_SKILLS_DIR: claudePaths.skillsDir,
      ARGS_SKILL_DIR: path.join(claudePaths.configDir, 'skills', 'auto-sprint-args'),
      CLI_SKILL_DIR: path.join(claudePaths.configDir, 'skills', 'fleet-sprint-cli'),
      SUPERVISOR_SKILL_DIR: path.join(claudePaths.configDir, 'skills', 'fleet-supervisor'),
      AGENTS_DIR: claudePaths.agentsDir!,
      FLEET_SKILLS_DIR: claudePaths.fleetSkillsDir,
      NODE_MODULES_DIR: config.NODE_MODULES_DIR,
      SCHEMAS_DIR: config.SCHEMAS_DIR,
      WORKFLOWS_DIR: config.WORKFLOWS_DIR,
      FLEET_DATA_DIR: path.join(config.FLEET_BASE, 'data'),
      FLEET_KEY_PATH: path.join(config.FLEET_BASE, 'fleet.key'),
    });
    expect(actual).toBe(normalizeCommandSurfaceOutput(expected));
  });

  it('removes recorded providers by default', async () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({
      providers: {
        claude: { skill: 'all' },
        agy: { skill: 'fleet' }
      }
    }));
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runUninstall(['--yes']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Cleaning up Claude...'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Cleaning up Antigravity...'));
    expect(fs.rmSync).toHaveBeenCalled();
  });

  it('calls Claude CLI to remove MCP', async () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ 
      providers: { claude: { skill: 'all' } } 
    }));
    
    await runUninstall(['--yes']);
    
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('claude mcp remove apra-fleet'),
      expect.any(Object)
    );
  });

  it('removes only specific skills if requested', async () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({
      providers: { agy: { skill: 'all' } }
    }));
    
    // Only PM skills
    await runUninstall(['--skill', 'pm', '--yes']);
    expect(fs.rmSync).toHaveBeenCalledWith(expect.stringMatching(/[\\/]pm$/), expect.any(Object));
    expect(fs.rmSync).not.toHaveBeenCalledWith(expect.stringMatching(/[\\/]fleet$/), expect.any(Object));

    vi.clearAllMocks();
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    // Only Fleet skills
    await runUninstall(['--skill', 'fleet', '--yes']);
    expect(fs.rmSync).not.toHaveBeenCalledWith(expect.stringMatching(/[\\/]pm$/), expect.any(Object));
    expect(fs.rmSync).toHaveBeenCalledWith(expect.stringMatching(/[\\/]fleet$/), expect.any(Object));
  });

  it('removes specific LLM only', async () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({
      providers: {
        claude: { skill: 'all' },
        agy: { skill: 'fleet' }
      }
    }));
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runUninstall(['--llm', 'agy', '--yes']);

    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Cleaning up Claude...'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Cleaning up Antigravity...'));
  });

  it('cleans up settings keys', async () => {
    const mockSettings = {
      mcpServers: { 'apra-fleet': {} },
      permissions: { allow: ['mcp__apra-fleet__*', 'other'] },
      hooks: { PostToolUse: [{ matcher: 'apra-fleet' }, { matcher: 'other' }] },
      statusLine: { command: 'fleet-statusline.sh' }
    };
    vi.spyOn(fs, 'readFileSync').mockImplementation((p: any) => {
      if (typeof p === 'string' && p.includes('settings.json')) return JSON.stringify(mockSettings);
      return JSON.stringify({ providers: { claude: { skill: 'all' } } });
    });
    const writeSpy = vi.spyOn(fs, 'writeFileSync');

    await runUninstall(['--yes']);

    expect(writeSpy).toHaveBeenCalled();
    const saved = JSON.parse(writeSpy.mock.calls[0][1] as string);
    expect(saved.mcpServers['apra-fleet']).toBeUndefined();
    expect(saved.permissions.allow).toEqual(['other']);
    expect(saved.hooks.PostToolUse).toEqual([{ matcher: 'other' }]);
    expect(saved.statusLine).toBeUndefined();
  });

  it('removes defaultModel only if it matches fleet standard', async () => {
    const standardModel = config.PROVIDER_STANDARD_MODELS.claude;
    
    // Case 1: Matches standard
    vi.spyOn(fs, 'readFileSync').mockImplementation((p: any) => {
      if (typeof p === 'string' && p.includes('settings.json')) return JSON.stringify({ defaultModel: standardModel });
      return JSON.stringify({ providers: { claude: { skill: 'all' } } });
    });
    let writeSpy = vi.spyOn(fs, 'writeFileSync');
    await runUninstall(['--yes']);
    let saved = JSON.parse(writeSpy.mock.calls[0][1] as string);
    expect(saved.defaultModel).toBeUndefined();

    vi.clearAllMocks();
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    // Case 2: Custom model (should be preserved)
    vi.spyOn(fs, 'readFileSync').mockImplementation((p: any) => {
      if (typeof p === 'string' && p.includes('settings.json')) {
        return JSON.stringify({ 
          mcpServers: { 'apra-fleet': {} }, // Trigger a change
          defaultModel: 'custom-model' 
        });
      }
      return JSON.stringify({ providers: { claude: { skill: 'all' } } });
    });
    writeSpy = vi.spyOn(fs, 'writeFileSync');
    await runUninstall(['--yes']);
    saved = JSON.parse(writeSpy.mock.calls[0][1] as string);
    expect(saved.defaultModel).toBe('custom-model');
  });

  it('migrates old install-config format', async () => {
    // Mock old format
    vi.spyOn(fs, 'readFileSync').mockImplementation((p: any) => {
      if (typeof p === 'string' && p.includes('install-config.json')) {
        return JSON.stringify({ llm: 'agy', skill: 'pm' });
      }
      return '{}';
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runUninstall(['--yes']);

    // Should clean up Antigravity (agy)
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Cleaning up Antigravity...'));
  });

  it('falls back to scanning if no config exists', async () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p: any) => {
      if (p === installConfigPath) return false;
      return true;
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((p: any) => {
      if (p === installConfigPath) throw new Error('not found');
      return '{}';
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runUninstall(['--yes']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No recorded installations found'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Cleaning up Claude...'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Cleaning up Codex...'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Cleaning up Copilot...'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Cleaning up Antigravity...'));
  });

  describe('--skill workflows', () => {
    const workflowsDir = config.WORKFLOWS_DIR;
    const nodeModulesDir = config.NODE_MODULES_DIR;
    const schemasDir = config.SCHEMAS_DIR;

    function mockWorkflowsLayout(userDirs: string[]) {
      const builtinDirs = ['fleet-sprint', 'hello-world'];
      const allDirs = [...builtinDirs, ...userDirs];
      vi.spyOn(fs, 'readFileSync').mockImplementation((p: any) => {
        if (typeof p === 'string' && p.includes('.installed.json')) {
          return JSON.stringify({ version: '1.0.0', builtin: builtinDirs });
        }
        return JSON.stringify({ providers: { claude: { skill: 'all' } } });
      });
      vi.spyOn(fs, 'readdirSync').mockImplementation((p: any) => {
        if (p === workflowsDir) {
          return allDirs.map(name => ({ name, isDirectory: () => true })) as any;
        }
        return [] as any;
      });
    }

    it('removes builtin workflows and the empty workflows/ root (empty-after case)', async () => {
      mockWorkflowsLayout([]);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runUninstall(['--skill', 'workflows', '--yes']);

      expect(fs.rmSync).toHaveBeenCalledWith(nodeModulesDir, expect.any(Object));
      expect(fs.rmSync).toHaveBeenCalledWith(schemasDir, expect.any(Object));
      expect(fs.rmSync).toHaveBeenCalledWith(path.join(workflowsDir, 'fleet-sprint'), expect.any(Object));
      expect(fs.rmSync).toHaveBeenCalledWith(path.join(workflowsDir, 'hello-world'), expect.any(Object));
      expect(fs.rmSync).toHaveBeenCalledWith(workflowsDir, expect.any(Object));
      expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('kept user workflows'));
    });

    it('keeps user-authored workflows and the workflows/ root (non-empty-after case)', async () => {
      mockWorkflowsLayout(['my-custom']);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runUninstall(['--skill', 'workflows', '--yes']);

      expect(fs.rmSync).toHaveBeenCalledWith(path.join(workflowsDir, 'fleet-sprint'), expect.any(Object));
      expect(fs.rmSync).toHaveBeenCalledWith(path.join(workflowsDir, 'hello-world'), expect.any(Object));
      expect(fs.rmSync).not.toHaveBeenCalledWith(workflowsDir, expect.any(Object));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('kept user workflows: my-custom'));
    });

    it('--dry-run prints the identical plan for both cases without deleting anything', async () => {
      mockWorkflowsLayout(['my-custom']);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runUninstall(['--skill', 'workflows', '--dry-run', '--yes']);

      expect(fs.rmSync).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(`Removing workflow runtime: ${nodeModulesDir}`));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(`Removing workflow schemas: ${schemasDir}`));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(`Removing built-in workflow: ${path.join(workflowsDir, 'fleet-sprint')}`));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(`Removing built-in workflow: ${path.join(workflowsDir, 'hello-world')}`));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('kept user workflows: my-custom'));
    });

    it('is included in --skill all', async () => {
      mockWorkflowsLayout([]);

      await runUninstall(['--yes']);

      expect(fs.rmSync).toHaveBeenCalledWith(nodeModulesDir, expect.any(Object));
      expect(fs.rmSync).toHaveBeenCalledWith(workflowsDir, expect.any(Object));
    });
  });

  it('removes the auto-sprint-args skill for claude PM uninstall (GAP B)', async () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({
      providers: { claude: { skill: 'all' } }
    }));

    await runUninstall(['--skill', 'pm', '--yes']);

    expect(fs.rmSync).toHaveBeenCalledWith(expect.stringMatching(/[\\/]auto-sprint-args$/), expect.any(Object));
  });

  it('does not remove auto-sprint-args skill for non-claude providers', async () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({
      providers: { agy: { skill: 'all' } }
    }));

    await runUninstall(['--skill', 'pm', '--yes']);

    const rmCalls = vi.mocked(fs.rmSync).mock.calls.map(c => c[0].toString());
    expect(rmCalls.some(p => p.includes('auto-sprint-args'))).toBe(false);
  });

  it('removes PM agent files (agentsDir) for claude PM uninstall', async () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({
      providers: { claude: { skill: 'all' } }
    }));

    await runUninstall(['--skill', 'pm', '--yes']);

    expect(fs.rmSync).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]agents$/),
      expect.objectContaining({ recursive: true, force: true })
    );
  });

  it('does not remove agentsDir for providers with no agent files (codex, copilot)', async () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({
      providers: { codex: { skill: 'pm' } }
    }));

    await runUninstall(['--llm', 'codex', '--skill', 'pm', '--yes']);

    const rmCalls = vi.mocked(fs.rmSync).mock.calls.map(c => c[0].toString());
    expect(rmCalls.some(p => p.endsWith('agents'))).toBe(false);
  });

  it('does not remove agentsDir when only fleet skills are requested', async () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({
      providers: { claude: { skill: 'all' } }
    }));

    await runUninstall(['--skill', 'fleet', '--yes']);

    const rmCalls = vi.mocked(fs.rmSync).mock.calls.map(c => c[0].toString());
    expect(rmCalls.some(p => p.endsWith('agents'))).toBe(false);
  });

  describe('fleet-supervisor OS service removal and Kept section', () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const unitDir = path.join(home, '.config', 'systemd', 'user');
    const plistPath = path.join(home, 'Library', 'LaunchAgents', 'com.apra-fleet.supervisor.plist');
    const wrapperBat = path.join(config.BIN_DIR, 'apra-fleet-supervisor-service.bat');
    const wrapperJs = path.join(config.BIN_DIR, 'apra-fleet-supervisor-service.js');
    const installedServeMjs = path.join(config.WORKFLOWS_DIR, 'fleet-sprint', 'bin', 'serve.mjs');
    const devServeMjs = '/path/to/apra-fleet/packages/apra-fleet-se/bin/serve.mjs';
    const MUTATING = new Set(['systemctl', 'launchctl', 'taskkill', 'powershell']);

    function setPlatform(p: NodeJS.Platform) {
      Object.defineProperty(process, 'platform', { value: p, configurable: true });
    }

    afterEach(() => {
      Object.defineProperty(process, 'platform', origPlatform);
    });

    /** execFileSync calls as [cmd, ...args] arrays. */
    function execCalls(): string[][] {
      return vi.mocked(execFileSync).mock.calls.map(c => [String(c[0]), ...((c[1] as string[] | undefined) ?? [])]);
    }

    function mutatingCalls(): string[][] {
      return execCalls().filter(([cmd, ...args]) =>
        MUTATING.has(cmd) || (cmd === 'schtasks' && !args.includes('/Query')));
    }

    function callOrder(pred: (args: string[]) => boolean): number {
      const mock = vi.mocked(execFileSync).mock;
      const i = mock.calls.findIndex(c => pred([String(c[0]), ...((c[1] as string[] | undefined) ?? [])]));
      expect(i).toBeGreaterThanOrEqual(0);
      return mock.invocationCallOrder[i];
    }

    function rmOrder(p: string): number {
      const mock = vi.mocked(fs.rmSync).mock;
      const i = mock.calls.findIndex(c => c[0] === p);
      expect(i).toBeGreaterThanOrEqual(0);
      return mock.invocationCallOrder[i];
    }

    function unitText(execStart: string): string {
      return ['[Unit]', 'Description=Apra Fleet Sprint Supervisor', '', '[Service]', `ExecStart=${execStart}`, '', '[Install]', 'WantedBy=default.target', ''].join('\n');
    }

    function plistText(args: string[]): string {
      return [
        '<?xml version="1.0" encoding="UTF-8"?>', '<plist version="1.0">', '<dict>',
        '    <key>Label</key>', '    <string>com.apra-fleet.supervisor</string>',
        '    <key>ProgramArguments</key>', '    <array>',
        ...args.map(a => `        <string>${a}</string>`),
        '    </array>', '</dict>', '</plist>', '',
      ].join('\n');
    }

    function taskXml(command: string, args: string): string {
      return `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2"><Actions Context="Author"><Exec><Command>${command}</Command><Arguments>${args}</Arguments></Exec></Actions></Task>`;
    }

    /**
     * Stateful fs: `files` maps an existing path to its content; every other
     * path exists unless it is a supervisor registration path or was removed.
     */
    function mockFs(files: Record<string, string>, opts: { topLevel?: string[]; workflowDirs?: string[] } = {}) {
      const removed = new Set<string>();
      vi.spyOn(fs, 'existsSync').mockImplementation((p: any) => {
        if (removed.has(p)) return false;
        if (p in files) return true;
        return !isSupervisorRegistrationPath(p);
      });
      vi.spyOn(fs, 'readFileSync').mockImplementation((p: any) => {
        if (p in files) return files[p];
        if (typeof p === 'string' && p.includes('.installed.json')) {
          return JSON.stringify({ version: '1.0.0', builtin: ['fleet-sprint', 'hello-world'] });
        }
        return JSON.stringify({ providers: { claude: { skill: 'all' } } });
      });
      vi.spyOn(fs, 'readdirSync').mockImplementation((p: any) => {
        if (p === config.WORKFLOWS_DIR) {
          return (opts.workflowDirs ?? ['fleet-sprint']).map(name => ({ name, isDirectory: () => true })) as any;
        }
        if (p === config.FLEET_BASE) return (opts.topLevel ?? []) as any;
        return [] as any;
      });
      vi.mocked(fs.rmSync).mockImplementation(((p: any) => { removed.add(p); }) as any);
      vi.mocked(fs.unlinkSync).mockImplementation(((p: any) => { removed.add(p); }) as any);
      return removed;
    }

    function mockExec(overrides: (cmd: string, args: string[]) => unknown) {
      vi.mocked(execFileSync).mockImplementation(((cmd: string, args?: readonly string[]) => {
        const out = overrides(cmd, [...(args ?? [])]);
        if (out !== undefined) return out as any;
        if (cmd === 'schtasks' && args?.includes('/Query')) throw new Error('ERROR: The system cannot find the file specified.');
        return '' as any;
      }) as any);
    }

    function logged(spy: ReturnType<typeof vi.spyOn>): string {
      return spy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    }

    it.each(['fleet-supervisor.service', 'apra-fleet-supervisor.service'])(
      'linux: disables --now, unlinks and daemon-reloads an installed-tree %s on full uninstall',
      async (unit) => {
        setPlatform('linux');
        const unitPath = path.join(unitDir, unit);
        const removed = mockFs({ [unitPath]: unitText(`/usr/bin/node ${installedServeMjs}`) });
        mockExec(() => undefined);
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await runUninstall(['--yes']);

        expect(execCalls()).toContainEqual(['systemctl', '--user', 'disable', '--now', unit]);
        expect(removed.has(unitPath)).toBe(true);
        const disable = callOrder(a => a.join(' ') === `systemctl --user disable --now ${unit}`);
        const reload = callOrder(a => a.join(' ') === 'systemctl --user daemon-reload');
        expect(reload).toBeGreaterThan(disable);
        expect(logged(consoleSpy)).toContain(`  - Removing fleet-supervisor service registration: ${unit}`);
      },
    );

    it('linux: removes the v0.5 shape (BIN_DIR/apra-fleet supervisor) too', async () => {
      setPlatform('linux');
      const unitPath = path.join(unitDir, 'fleet-supervisor.service');
      const removed = mockFs({ [unitPath]: unitText(`${path.join(config.BIN_DIR, 'apra-fleet')} supervisor --managed-service`) });
      mockExec(() => undefined);
      vi.spyOn(console, 'log').mockImplementation(() => {});

      await runUninstall(['--yes']);

      expect(execCalls()).toContainEqual(['systemctl', '--user', 'disable', '--now', 'fleet-supervisor.service']);
      expect(removed.has(unitPath)).toBe(true);
    });

    it('darwin: boots out com.apra-fleet.supervisor and unlinks its plist', async () => {
      setPlatform('darwin');
      const removed = mockFs({ [plistPath]: plistText([path.join(config.BIN_DIR, 'apra-fleet'), 'supervisor', '--managed-service']) });
      mockExec(() => undefined);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runUninstall(['--yes']);

      const bootout = execCalls().filter(([cmd, sub]) => cmd === 'launchctl' && sub === 'bootout');
      expect(bootout).toHaveLength(1);
      expect(bootout[0][2]).toMatch(/^gui\/\d+\/com\.apra-fleet\.supervisor$/);
      expect(removed.has(plistPath)).toBe(true);
      expect(logged(consoleSpy)).toContain('  - Removing fleet-supervisor service registration: com.apra-fleet.supervisor');
    });

    it('darwin: a plist that exists but is not loaded is not a failure', async () => {
      setPlatform('darwin');
      const removed = mockFs({ [plistPath]: plistText(['/usr/local/bin/node', installedServeMjs]) });
      mockExec((cmd) => {
        if (cmd === 'launchctl') throw Object.assign(new Error('Boot-out failed: 3: No such process'), { status: 3 });
        return undefined;
      });
      vi.spyOn(console, 'log').mockImplementation(() => {});

      await runUninstall(['--yes']);

      expect(removed.has(plistPath)).toBe(true);
      expect(process.exit).not.toHaveBeenCalled();
    });

    it('win32: tree-kills the wrapper process, then deletes ApraFleetSupervisor and the wrapper', async () => {
      setPlatform('win32');
      const removed = mockFs({ [wrapperBat]: '@echo off', [wrapperJs]: '// launcher' });
      mockExec((cmd, args) => {
        if (cmd === 'schtasks' && args.includes('/Query')) {
          return taskXml('C:\\Windows\\System32\\wscript.exe', `//B //Nologo //E:JScript "${wrapperJs}"`);
        }
        if (cmd === 'powershell') return '4242\r\n';
        return undefined;
      });
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runUninstall(['--yes']);

      expect(execCalls()).toContainEqual(['taskkill', '/F', '/T', '/PID', '4242']);
      expect(execCalls()).toContainEqual(['schtasks', '/Delete', '/TN', 'ApraFleetSupervisor', '/F']);
      const kill = callOrder(a => a[0] === 'taskkill');
      const del = callOrder(a => a[0] === 'schtasks' && a.includes('/Delete'));
      expect(kill).toBeLessThan(del);
      expect(removed.has(wrapperBat)).toBe(true);
      expect(logged(consoleSpy)).toContain('  - Removing fleet-supervisor service registration: ApraFleetSupervisor');
    });

    it('--skill workflows removes the supervisor unit before deleting workflows/fleet-sprint', async () => {
      setPlatform('linux');
      const unitPath = path.join(unitDir, 'fleet-supervisor.service');
      mockFs({ [unitPath]: unitText(`/usr/bin/node ${installedServeMjs}`) });
      mockExec(() => undefined);
      vi.spyOn(console, 'log').mockImplementation(() => {});

      await runUninstall(['--skill', 'workflows', '--yes']);

      const disable = callOrder(a => a.join(' ') === 'systemctl --user disable --now fleet-supervisor.service');
      expect(disable).toBeLessThan(rmOrder(path.join(config.WORKFLOWS_DIR, 'fleet-sprint')));
      expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith(unitPath);
    });

    it('removing only a supervisor registration does not print "Nothing to remove"', async () => {
      setPlatform('linux');
      const unitPath = path.join(unitDir, 'fleet-supervisor.service');
      mockFs({ [unitPath]: unitText(`/usr/bin/node ${installedServeMjs}`) });
      // Nothing else is installed: only the unit exists.
      vi.spyOn(fs, 'existsSync').mockImplementation((p: any) => p === unitPath);
      mockExec(() => undefined);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runUninstall(['--skill', 'workflows', '--yes']);

      expect(logged(consoleSpy)).toContain('Removing fleet-supervisor service registration: fleet-supervisor.service');
      expect(logged(consoleSpy)).not.toContain('Nothing to remove');
    });

    it.each(['linux', 'darwin', 'win32'] as const)('%s: --dry-run prints the planned removal and runs no mutating command', async (platform) => {
      setPlatform(platform);
      const files: Record<string, string> = platform === 'linux'
        ? { [path.join(unitDir, 'fleet-supervisor.service')]: unitText(`/usr/bin/node ${installedServeMjs}`) }
        : platform === 'darwin'
          ? { [plistPath]: plistText(['/usr/local/bin/node', installedServeMjs]) }
          : { [wrapperBat]: '@echo off' };
      mockFs(files);
      mockExec((cmd, args) => (cmd === 'schtasks' && args.includes('/Query')
        ? taskXml(wrapperBat, '') : undefined));
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runUninstall(['--dry-run', '--yes']);

      expect(logged(consoleSpy)).toMatch(/ {2}- Removing fleet-supervisor service registration: (fleet-supervisor\.service|com\.apra-fleet\.supervisor|ApraFleetSupervisor)/);
      expect(mutatingCalls()).toEqual([]);
      expect(fs.unlinkSync).not.toHaveBeenCalled();
      expect(fs.rmSync).not.toHaveBeenCalled();
    });

    it.each(['linux', 'darwin', 'win32'] as const)('%s: no supervisor registration -> no supervisor command and nothing extra printed', async (platform) => {
      setPlatform(platform);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await runUninstall(['--yes']);

      expect(mutatingCalls()).toEqual([]);
      expect(logged(consoleSpy)).not.toContain('fleet-supervisor service');
      expect(errSpy).not.toHaveBeenCalled();
      expect(process.exit).not.toHaveBeenCalled();
    });

    it('a stop/remove failure on an existing registration names the unit and exits non-zero', async () => {
      setPlatform('linux');
      const unitPath = path.join(unitDir, 'fleet-supervisor.service');
      mockFs({ [unitPath]: unitText(`/usr/bin/node ${installedServeMjs}`) });
      mockExec((cmd, args) => {
        if (cmd === 'systemctl' && args.includes('disable')) throw new Error('Failed to disable unit: Access denied');
        return undefined;
      });
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(runUninstall(['--yes'])).rejects.toThrow('exit');

      expect(process.exit).toHaveBeenCalledWith(1);
      const errors = logged(errSpy);
      expect(errors).toContain('fleet-supervisor.service');
      expect(errors).toContain('Access denied');
    });

    it.each([
      ['linux', 'apra-fleet-supervisor.service'],
      ['darwin', 'com.apra-fleet.supervisor'],
      ['win32', 'ApraFleetSupervisor'],
    ] as const)('%s: a known-name registration pointing at a dev checkout (%s) is kept, not removed, and listed in Kept', async (platform, name) => {
      setPlatform(platform);
      const files: Record<string, string> = platform === 'linux'
        ? { [path.join(unitDir, name)]: unitText(`/usr/bin/node ${devServeMjs}`) }
        : platform === 'darwin'
          ? { [plistPath]: plistText(['/usr/local/bin/node', devServeMjs]) }
          : {};
      const removed = mockFs(files);
      mockExec((cmd, args) => (cmd === 'schtasks' && args.includes('/Query')
        ? taskXml('node', devServeMjs) : undefined));
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runUninstall(['--yes']);

      expect(mutatingCalls()).toEqual([]);
      for (const p of Object.keys(files)) expect(removed.has(p)).toBe(false);
      const out = logged(consoleSpy);
      expect(out).not.toContain('Removing fleet-supervisor service registration');
      const kept = out.slice(out.indexOf('Kept (intentionally):'));
      expect(out).toContain('Kept (intentionally):');
      expect(kept).toContain(`fleet-supervisor service registration ${name} (target: `);
      expect(kept).toContain(devServeMjs);
      expect(kept).toContain('not installed by apra-fleet, left in place');
    });

    it('full uninstall prints a Kept section naming fleet.key, data/, user workflows and leftovers; nothing remaining is unlisted', async () => {
      const topLevel = ['bin', 'hooks', 'scripts', 'node_modules', 'schemas', 'workflows', 'data', 'fleet.key', 'supervisor', 'settle-it'];
      const removed = mockFs({}, { topLevel, workflowDirs: ['fleet-sprint', 'hello-world', 'my-custom'] });
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runUninstall(['--yes']);

      const out = logged(consoleSpy);
      expect(out).toContain('Kept (intentionally):');
      const kept = out.slice(out.indexOf('Kept (intentionally):'));
      const keyPath = path.join(config.FLEET_BASE, 'fleet.key');
      expect(kept).toContain(`  - ${keyPath}: JWT signing key -- lives OUTSIDE data/`);
      expect(kept).toContain(`  - ${path.join(config.FLEET_BASE, 'data')}: registry, logs and credentials`);
      expect(kept).toContain(`  - ${config.WORKFLOWS_DIR}: user-authored workflows: my-custom`);
      expect(kept).toContain(`  - ${path.join(config.FLEET_BASE, 'supervisor')}: left in place`);
      expect(kept).toContain(`  - ${path.join(config.FLEET_BASE, 'settle-it')}: left in place`);
      // Falsifiable property: every top-level entry was removed or is listed.
      for (const name of topLevel) {
        const abs = path.join(config.FLEET_BASE, name);
        expect(removed.has(abs) || kept.includes(`  - ${abs}: `), `${name} neither removed nor listed`).toBe(true);
      }
    });

    it('--dry-run Kept section lists only what the plan leaves, without mutating anything', async () => {
      const topLevel = ['bin', 'hooks', 'scripts', 'node_modules', 'schemas', 'workflows', 'data', 'fleet.key', 'supervisor'];
      mockFs({}, { topLevel, workflowDirs: ['fleet-sprint'] });
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runUninstall(['--dry-run', '--yes']);

      const out = logged(consoleSpy);
      const kept = out.slice(out.indexOf('Kept (intentionally):'));
      expect(kept).toContain(path.join(config.FLEET_BASE, 'fleet.key'));
      expect(kept).toContain(path.join(config.FLEET_BASE, 'supervisor'));
      for (const gone of ['bin', 'hooks', 'scripts', 'node_modules', 'schemas', 'workflows']) {
        expect(kept).not.toContain(`  - ${path.join(config.FLEET_BASE, gone)}: `);
      }
      expect(fs.rmSync).not.toHaveBeenCalled();
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it('partial uninstall (--llm) prints no Kept section', async () => {
      mockFs({}, { topLevel: ['data', 'fleet.key'] });
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await runUninstall(['--llm', 'claude', '--skill', 'pm', '--yes']);

      expect(logged(consoleSpy)).not.toContain('Kept (intentionally):');
    });

    it('leaves the MCP-server unregister path unchanged', async () => {
      await runUninstall(['--yes']);
      expect(mcpSvcMgr.unregister).toHaveBeenCalledTimes(1);
    });
  });

  it('aborts if apra-fleet server is running', async () => {
    vi.mocked(install.isApraFleetRunning).mockReturnValue(true);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    await expect(runUninstall(['--yes'])).rejects.toThrow('exit');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('server is currently running'));
  });
});
