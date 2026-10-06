import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { runInstall, _setSeaOverride, _setManifestOverride, MEMBER_INSTALL_NEXT_STEP } from '../src/cli/install.js';

// `apra-fleet install --member`: server + user-mode auto-start only. Runs
// against an in-memory filesystem rooted at a fake HOME (os/fs/child_process
// are mocked -- same pattern as install-service.test.ts), a stub service
// manager and a stubbed `claude` CLI, so nothing real is registered or
// written. "State" asserted here is the in-memory file map, the recorded
// shell commands and the stub service manager's calls.

const { mockSvcMgr } = vi.hoisted(() => ({
  mockSvcMgr: {
    register: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ installed: false, running: false }),
    isInstalled: vi.fn().mockResolvedValue(false),
    unregister: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  },
}));

vi.mock('node:os', () => ({ default: { homedir: vi.fn(() => '/mock/home'), platform: vi.fn(() => 'linux') } }));
vi.mock('node:fs');
vi.mock('node:child_process');
vi.mock('../src/services/service-manager/index.js', () => ({
  getServiceManager: vi.fn(async () => mockSvcMgr),
}));
vi.mock('../src/cli/install.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/cli/install.js')>();
  return { ...orig, isApraFleetRunning: vi.fn().mockReturnValue(false) };
});

const HOME = '/mock/home';
const CLAUDE_MD = `${HOME}/.claude/CLAUDE.md`;
const SETTINGS = `${HOME}/.claude/settings.json`;
const USER_CLAUDE_MD = '# my own rules\nBe terse.\n';
const USER_SETTINGS = JSON.stringify({ permissions: { allow: ['Read(/x)'] }, theme: 'dark' }, null, 2);

let files: Map<string, string>;
let shellCmds: string[];

function installMemFs() {
  files = new Map([[CLAUDE_MD, USER_CLAUDE_MD], [SETTINGS, USER_SETTINGS]]);
  const key = (p: any) => p.toString().replace(/\\/g, '/');
  vi.mocked(fs.existsSync).mockImplementation((p: any) => {
    const k = key(p);
    if (k.includes('version.json') || k.includes('hooks-config.json')) return true;
    return files.has(k);
  });
  vi.mocked(fs.readFileSync).mockImplementation(((p: any) => {
    const k = key(p);
    if (files.has(k)) return files.get(k)!;
    if (k.includes('version.json')) return JSON.stringify({ version: '0.1.0' });
    if (k.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }) as any);
  vi.mocked(fs.writeFileSync).mockImplementation(((p: any, d: any) => { files.set(key(p), String(d)); }) as any);
  vi.mocked(fs.appendFileSync).mockImplementation(((p: any, d: any) => { files.set(key(p), (files.get(key(p)) ?? '') + String(d)); }) as any);
  vi.mocked(fs.readdirSync).mockReturnValue([] as any);
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
  vi.mocked(fs.chmodSync).mockImplementation(() => {});
  vi.mocked(fs.copyFileSync).mockImplementation(() => {});
  vi.mocked(fs.rmSync).mockImplementation(() => undefined);
}

const writtenPaths = () => vi.mocked(fs.writeFileSync).mock.calls.map(c => String(c[0]).replace(/\\/g, '/'));
const mcpAdds = () => shellCmds.filter(c => c.includes('claude mcp add'));

beforeEach(() => {
  vi.clearAllMocks();
  mockSvcMgr.register.mockResolvedValue(undefined);
  vi.mocked(os.homedir).mockReturnValue(HOME);
  installMemFs();
  shellCmds = [];
  vi.mocked(execSync).mockImplementation(((cmd: string) => { shellCmds.push(cmd); return Buffer.from(''); }) as any);
  _setManifestOverride({
    version: '0.1.0', hooks: {}, scripts: {},
    skills: { 'SKILL.md': 'x' }, fleetSkills: { 'SKILL.md': 'x' },
    workflows: { 'auto-sprint.js': 'x' },
  } as any);
  _setSeaOverride(true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  _setSeaOverride(null);
  _setManifestOverride(null);
  process.exitCode = undefined;
});

describe('install --member', () => {
  it('installs no skills and no workflows', async () => {
    await runInstall(['--transport', 'http', '--member']);
    const w = writtenPaths();
    expect(w.filter(p => p.includes('/skills/'))).toEqual([]);
    expect(w.filter(p => p.includes('/workflows/') || p.includes('auto-sprint'))).toEqual([]);
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).not.toMatch(/Installing (fleet|PM) skill|Installing workflow runtime/);
  });

  it('leaves ~/.claude/CLAUDE.md and the permission settings byte-identical', async () => {
    await runInstall(['--transport', 'http', '--member']);
    expect(files.get(CLAUDE_MD)).toBe(USER_CLAUDE_MD);
    expect(files.get(SETTINGS)).toBe(USER_SETTINGS);
  });

  it('writes no user-scope apra-fleet MCP entry', async () => {
    await runInstall(['--transport', 'http', '--member']);
    expect(mcpAdds()).toEqual([]);
    for (const [p, content] of files) {
      if (p.endsWith('.json') && p.startsWith(`${HOME}/.claude`)) expect(content).not.toContain('"apra-fleet"');
    }
  });

  it('registers no supervisor service -- only the server auto-start', async () => {
    await runInstall(['--transport', 'http', '--member']);
    expect(mockSvcMgr.register).toHaveBeenCalledTimes(1);
    expect(mockSvcMgr.register).toHaveBeenCalledWith(expect.stringContaining('apra-fleet'), ['--transport', 'http'], expect.any(String));
    expect(mockSvcMgr.start).toHaveBeenCalledTimes(1);
    expect(shellCmds.filter(c => /supervisor/i.test(c))).toEqual([]);
  });

  it('--skill none WITHOUT --member still registers the user-scope MCP entry', async () => {
    // --workflows none: v0.5 registers a fleet-supervisor service with workflows, which this test does not stub.
    await runInstall(['--transport', 'http', '--skill', 'none', '--workflows', 'none']);
    expect(mcpAdds().length).toBe(1);
    expect(mcpAdds()[0]).toContain('apra-fleet');
  });

  it('reports a typed non-success status when the auto-start cannot be registered', async () => {
    mockSvcMgr.register.mockRejectedValueOnce(new Error('systemd --user unavailable'));
    await runInstall(['--transport', 'http', '--member']);
    expect(process.exitCode).toBe(1);
    const err = vi.mocked(console.error).mock.calls.flat().join('\n');
    expect(err).toContain('E-MEMBER-AUTOSTART');
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).not.toContain('installed successfully');
  });

  it('fails with E-MEMBER-AUTOSTART for --transport stdio and installs nothing', async () => {
    await runInstall(['--transport', 'stdio', '--member']);
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('E-MEMBER-AUTOSTART');
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).not.toContain('installed successfully');
    expect(mockSvcMgr.register).not.toHaveBeenCalled();
    expect(mcpAdds()).toEqual([]);
  });

  it('fails with E-MEMBER-AUTOSTART for a non-SEA install', async () => {
    _setSeaOverride(false);
    await runInstall(['--transport', 'http', '--member']);
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toContain('E-MEMBER-AUTOSTART');
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).not.toContain('installed successfully');
    expect(mockSvcMgr.register).not.toHaveBeenCalled();
  });

  it('summary names only what it did plus the member next step (no settings, /mcp or restart lines)', async () => {
    for (const extra of [[], ['--force']]) {
      vi.mocked(console.log).mockClear();
      await runInstall(['--transport', 'http', '--member', ...extra]);
      const out = vi.mocked(console.log).mock.calls.flat().join('\n');
      expect(out).toContain('installed successfully');
      expect(out).not.toContain('Settings:');
      expect(out).not.toContain('Run /mcp');
      expect(out).not.toMatch(/Restart Claude Code/);
      expect(out).toContain(MEMBER_INSTALL_NEXT_STEP);
    }
  });

  it('a full install still prints the settings file and the /mcp step', async () => {
    // --workflows none: v0.5 registers a fleet-supervisor service with workflows, which this test does not stub.
    await runInstall(['--transport', 'http', '--skill', 'none', '--workflows', 'none']);
    const out = vi.mocked(console.log).mock.calls.flat().join('\n');
    expect(out).toContain('Settings:');
    expect(out).toContain('Run /mcp in Claude Code');
    expect(out).not.toContain(MEMBER_INSTALL_NEXT_STEP);
  });
});
