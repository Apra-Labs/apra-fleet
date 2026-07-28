import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { parse as parseToml } from 'smol-toml';
import { runInstall } from '../src/cli/install.js';
import { normalizeCommandSurfaceOutput, readCommandSurfaceFixture } from './helpers/regression-command-surface.js';

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/mock/home'),
    platform: vi.fn(() => 'linux'),
  }
}));
vi.mock('node:fs');
vi.mock('node:child_process');

describe('runInstall multi-provider', () => {
  const mockHome = '/mock/home';
  const mockProjectRoot = '/mock/project';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    
    const fileState = new Map<string, string>();

    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return true;
      if (ps.includes('hooks-config.json')) return true;
      if (fileState.has(ps)) return true;
      return false;
    });

    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (fileState.has(ps)) return fileState.get(ps)!;
      if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.3_62ec2e' });
      if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
      return '';
    });

    vi.mocked(fs.writeFileSync).mockImplementation((p: any, content: any) => {
      fileState.set(p.toString(), content.toString());
    });

    vi.mocked(fs.readdirSync).mockReturnValue([] as any);
  });

  it('installs for Claude by default', async () => {
    await runInstall([]);
    
    // Check if Claude paths are used
    const claudeSettings = path.join(mockHome, '.claude', 'settings.json');
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      expect.stringContaining(claudeSettings),
      expect.any(String)
    );

    // Check if Claude MCP command is run
    expect(vi.mocked(execSync)).toHaveBeenCalledWith(
      expect.stringContaining('claude mcp add'),
      expect.any(Object)
    );
  });

  it('installs for Gemini when --llm gemini is passed', async () => {
    await runInstall(['--llm', 'gemini']);
    
    // Check if Gemini paths are used
    const geminiSettings = path.join(mockHome, '.gemini', 'settings.json');
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      expect.stringContaining(geminiSettings),
      expect.any(String)
    );

    // Should NOT run claude mcp add
    const claudeCmd = vi.mocked(execSync).mock.calls.find(c => c[0].toString().includes('claude mcp add'));
    expect(claudeCmd).toBeUndefined();

    // Should have written to Gemini settings with trust: true
    const geminiWrite = vi.mocked(fs.writeFileSync).mock.calls.filter(c => c[0].toString().includes(geminiSettings)).at(-1);
    expect(geminiWrite).toBeDefined();
    expect(geminiWrite![1].toString()).toContain('"trust": true');
  });

  it('installs for Codex when --llm codex is passed', async () => {
    await runInstall(['--llm', 'codex']);
    
    // Check if Codex paths are used
    const codexConfig = path.join(mockHome, '.codex', 'config.toml');
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      expect.stringContaining(codexConfig),
      expect.any(String)
    );

    // Should have written to Codex config with [mcp_servers.apra-fleet]
    const codexWrite = vi.mocked(fs.writeFileSync).mock.calls.filter(c => c[0].toString().includes(codexConfig)).at(-1);
    expect(codexWrite).toBeDefined();
    expect(codexWrite![1].toString()).toMatch(/\[mcp_servers\.apra-fleet\]/);
  });

  it('installs for Copilot when --llm copilot is passed', async () => {
    await runInstall(['--llm', 'copilot']);
    
    // Check if Copilot paths are used
    const copilotSettings = path.join(mockHome, '.copilot', 'settings.json');
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      expect.stringContaining(copilotSettings),
      expect.any(String)
    );

    // Should have written to Copilot settings
    const copilotWrite = vi.mocked(fs.writeFileSync).mock.calls.filter(c => c[0].toString().includes(copilotSettings)).at(-1);
    expect(copilotWrite).toBeDefined();
    expect(copilotWrite![1].toString()).toContain('apra-fleet');
  });

  it('installs skills to Gemini directory when --skill --llm gemini is passed', async () => {
    // Mock readdirSync for copyDirSync in dev mode
    vi.mocked(fs.readdirSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('skills') && ps.includes('pm')) {
        return [{ name: 'SKILL.md', isDirectory: () => false }] as any;
      }
      return [];
    });

    await runInstall(['--skill', '--llm', 'gemini']);
    
    // Check if Gemini skill directory is created
    const geminiSkillsDir = path.join(mockHome, '.gemini', 'skills', 'pm');
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(
      expect.stringContaining(geminiSkillsDir),
      expect.any(Object)
    );

    // Check if skill file is copied to Gemini directory
    expect(vi.mocked(fs.copyFileSync)).toHaveBeenCalledWith(
      expect.stringContaining('SKILL.md'),
      expect.stringContaining(geminiSkillsDir)
    );

    // Check if Gemini settings include the correct skill path in permissions
    const geminiSettings = path.join(mockHome, '.gemini', 'settings.json');
    const geminiWrite = vi.mocked(fs.writeFileSync).mock.calls.filter(c => c[0].toString().includes(geminiSettings)).at(-1);
    expect(geminiWrite).toBeDefined();
    expect(geminiWrite![1].toString()).toContain('skills/pm');
  });

  it('errors on unsupported provider', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runInstall(['--llm=unsupported'])).rejects.toThrow('exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('errors on unsupported provider via space form (--llm badprovider)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runInstall(['--llm', 'badprovider'])).rejects.toThrow('exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('accepts --llm=gemini (equals form) and writes to ~/.gemini/', async () => {
    await runInstall(['--llm=gemini']);

    const geminiSettings = path.join(mockHome, '.gemini', 'settings.json');
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      expect.stringContaining(geminiSettings),
      expect.any(String)
    );
  });

  it('accepts --llm=codex (equals form) and writes to ~/.codex/config.toml', async () => {
    await runInstall(['--llm=codex']);

    const codexConfig = path.join(mockHome, '.codex', 'config.toml');
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      expect.stringContaining(codexConfig),
      expect.any(String)
    );
  });

  it('creates configDir for each provider via mkdirSync', async () => {
    for (const [llm, dir] of [
      ['claude', path.join(mockHome, '.claude')],
      ['gemini', path.join(mockHome, '.gemini')],
      ['codex', path.join(mockHome, '.codex')],
      ['copilot', path.join(mockHome, '.copilot')],
    ] as [string, string][]) {
      vi.clearAllMocks();
      vi.mocked(os.homedir).mockReturnValue(mockHome);

      const fileState = new Map<string, string>();
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const ps = p.toString();
        if (ps.includes('version.json')) return true;
        if (ps.includes('hooks-config.json')) return true;
        if (fileState.has(ps)) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        const ps = p.toString();
        if (fileState.has(ps)) return fileState.get(ps)!;
        if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.3_62ec2e' });
        if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
        return '';
      });
      vi.mocked(fs.writeFileSync).mockImplementation((p: any, content: any) => {
        fileState.set(p.toString(), content.toString());
      });
      vi.mocked(fs.readdirSync).mockReturnValue([] as any);

      await runInstall(['--llm', llm]);

      expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(
        expect.stringContaining(dir),
        expect.objectContaining({ recursive: true })
      );
    }
  });

  it('Claude MCP registration uses --scope user flag', async () => {
    await runInstall([]);

    const calls = vi.mocked(execSync).mock.calls.map(c => c[0].toString());
    const addCall = calls.find(c => c.includes('claude mcp add'));
    expect(addCall).toBeDefined();
    expect(addCall).toContain('--scope user');
  });

  it('Gemini MCP registration embeds mcpServers.apra-fleet with trust:true', async () => {
    await runInstall(['--llm', 'gemini']);

    const geminiSettings = path.join(mockHome, '.gemini', 'settings.json');
    const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
      c[0].toString().includes(geminiSettings)
    );
    expect(writes.length).toBeGreaterThan(0);
    const lastWrite = writes.at(-1)![1].toString();
    const parsed = JSON.parse(lastWrite);
    const serverKey = Object.keys(parsed.mcpServers).find(k => k === 'apra-fleet');
        expect(serverKey).toBeDefined();
        expect(parsed.mcpServers[serverKey!].trust).toBe(true);
      });

      it('Codex MCP registration writes [mcp_servers.apra-fleet] TOML section', async () => {
        await runInstall(['--llm', 'codex']);

        const codexConfig = path.join(mockHome, '.codex', 'config.toml');
        const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
          c[0].toString().includes(codexConfig)
        );
        expect(writes.length).toBeGreaterThan(0);
        const lastWrite = writes.at(-1)![1].toString();
        expect(lastWrite).toMatch(/\[mcp_servers\.apra-fleet\]/);
        expect(lastWrite).toMatch(/command\s*=/);
      });

  it('installs skills to Codex directory when --skill --llm codex is passed', async () => {
    vi.mocked(fs.readdirSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('skills') && ps.includes('pm')) {
        return [{ name: 'SKILL.md', isDirectory: () => false }] as any;
      }
      return [];
    });

    await runInstall(['--skill', '--llm', 'codex']);

    const codexSkillsDir = path.join(mockHome, '.codex', 'skills', 'pm');
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(
      expect.stringContaining(codexSkillsDir),
      expect.any(Object)
    );

    expect(vi.mocked(fs.copyFileSync)).toHaveBeenCalledWith(
      expect.stringContaining('SKILL.md'),
      expect.stringContaining(codexSkillsDir)
    );
  });

  it('permissions include provider-specific skill path', async () => {
    for (const [llm, skillsDir] of [
      ['gemini', path.join(mockHome, '.gemini', 'skills', 'pm')],
      ['codex', path.join(mockHome, '.codex', 'skills', 'pm')],
    ] as [string, string][]) {
      vi.clearAllMocks();
      vi.mocked(os.homedir).mockReturnValue(mockHome);

      const fileState = new Map<string, string>();
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const ps = p.toString();
        if (ps.includes('version.json')) return true;
        if (ps.includes('hooks-config.json')) return true;
        if (fileState.has(ps)) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        const ps = p.toString();
        if (fileState.has(ps)) return fileState.get(ps)!;
        if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.3_62ec2e' });
        if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
        return '';
      });
      vi.mocked(fs.writeFileSync).mockImplementation((p: any, content: any) => {
        fileState.set(p.toString(), content.toString());
      });
      vi.mocked(fs.readdirSync).mockReturnValue([] as any);

      await runInstall(['--llm', llm]);

      // Find the last write to the settings/config file for this provider
      const allWrites = vi.mocked(fs.writeFileSync).mock.calls;
      const settingsWrites = allWrites.filter(c => {
        const p = c[0].toString();
        if (llm === 'codex') {
          return p.endsWith('config.toml');
        }
        return p.endsWith('settings.json');
      });
      expect(settingsWrites.length).toBeGreaterThan(0);

      // The permissions write is the last one
      const lastContent = settingsWrites.at(-1)![1].toString();
      const normalizedSkillsDir = skillsDir.replace(/\\/g, '/');
      expect(lastContent).toContain(normalizedSkillsDir);
    }
  });

  it('writes defaultModel for Claude (bare "sonnet" alias) to settings.json', async () => {
    await runInstall([]);

    const claudeSettings = path.join(mockHome, '.claude', 'settings.json');
    const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
      c[0].toString().includes(claudeSettings)
    );
    expect(writes.length).toBeGreaterThan(0);
    // Find the write that contains defaultModel
    const defaultModelWrite = writes.find(c => c[1].toString().includes('"defaultModel"'));
    expect(defaultModelWrite).toBeDefined();
    const parsed = JSON.parse(defaultModelWrite![1].toString());
    // "sonnet" auto-resolves to the current generation (confirmed via `claude --settings`
    // and `claude --help`) instead of a pinned dated ID that goes stale on each release.
    expect(parsed.defaultModel).toBe('sonnet');
  });

  it('writes defaultModel for Gemini (gemini-3.5-flash) to settings.json', async () => {
    await runInstall(['--llm', 'gemini']);

    const geminiSettings = path.join(mockHome, '.gemini', 'settings.json');
    const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
      c[0].toString().includes(geminiSettings)
    );
    expect(writes.length).toBeGreaterThan(0);
    const defaultModelWrite = writes.find(c => c[1].toString().includes('"defaultModel"'));
    expect(defaultModelWrite).toBeDefined();
    const parsed = JSON.parse(defaultModelWrite![1].toString());
    expect(parsed.defaultModel).toBe('gemini-3.5-flash');
  });

  it('writes defaultModel for Codex (gpt-5.4) to config.toml', async () => {
    await runInstall(['--llm', 'codex']);

    const codexConfig = path.join(mockHome, '.codex', 'config.toml');
    const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
      c[0].toString().includes(codexConfig)
    );
    expect(writes.length).toBeGreaterThan(0);
    const defaultModelWrite = writes.find(c => c[1].toString().includes('defaultModel'));
    expect(defaultModelWrite).toBeDefined();
    expect(defaultModelWrite![1].toString()).toContain('gpt-5.4');
  });

  it('Codex config.toml is valid TOML (HTTP transport, url key)', async () => {
    await runInstall(['--llm', 'codex']);

    const codexConfig = path.join(mockHome, '.codex', 'config.toml');
    const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
      c[0].toString().includes(codexConfig)
    );
    expect(writes.length).toBeGreaterThan(0);
    const finalContent = writes.at(-1)![1].toString();

    // Regression guard for #115: no bare/backslash-prefixed scalars.
    expect(finalContent).not.toMatch(/=\s*\\/);
    expect(finalContent).toMatch(/defaultModel\s*=\s*"gpt-5\.4"/);

    // Parsing back with smol-toml must succeed and round-trip.
    const parsed = parseToml(finalContent) as any;
    expect(parsed.defaultModel).toBe('gpt-5.4');
    // HTTP transport: url key, no command/args.
    expect(typeof parsed.mcp_servers['apra-fleet'].url).toBe('string');
    expect(parsed.mcp_servers['apra-fleet'].url).toContain('/mcp');
  });

  it('Codex config.toml is valid TOML — command/args for stdio transport (#115)', async () => {
    await runInstall(['--llm', 'codex', '--transport', 'stdio']);

    const codexConfig = path.join(mockHome, '.codex', 'config.toml');
    const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
      c[0].toString().includes(codexConfig)
    );
    expect(writes.length).toBeGreaterThan(0);
    const finalContent = writes.at(-1)![1].toString();

    // Regression guard for #115: no bare/backslash-prefixed scalars like `model = \gpt-5.3-codex`.
    // Every `key = value` scalar must either be quoted, a boolean, a number, a table, or an array.
    expect(finalContent).not.toMatch(/=\s*\\/);
    expect(finalContent).toMatch(/defaultModel\s*=\s*"gpt-5\.4"/);

    // Parsing back with smol-toml must succeed and round-trip defaultModel.
    const parsed = parseToml(finalContent) as any;
    expect(parsed.defaultModel).toBe('gpt-5.4');
    // stdio transport: mcp_servers.apra-fleet.command should be a plain string (proper TOML string literal).
    expect(typeof parsed.mcp_servers['apra-fleet'].command).toBe('string');
    expect(Array.isArray(parsed.mcp_servers['apra-fleet'].args)).toBe(true);
  });

  it('writes defaultModel for Copilot (claude-sonnet-4-5) to settings.json', async () => {
    await runInstall(['--llm', 'copilot']);

    const copilotSettings = path.join(mockHome, '.copilot', 'settings.json');
    const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
      c[0].toString().includes(copilotSettings)
    );
    expect(writes.length).toBeGreaterThan(0);
    const defaultModelWrite = writes.find(c => c[1].toString().includes('"defaultModel"'));
    expect(defaultModelWrite).toBeDefined();
    const parsed = JSON.parse(defaultModelWrite![1].toString());
    expect(parsed.defaultModel).toBe('claude-sonnet-4-5');
  });

  // --skill flag value tests

  it('--skill alone (no value) installs both fleet and pm skills', async () => {
    vi.mocked(fs.readdirSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('skills') && ps.includes('pm')) {
        return [{ name: 'SKILL.md', isDirectory: () => false }] as any;
      }
      return [];
    });

    await runInstall(['--skill']);

    const fleetSkillsDir = path.join(mockHome, '.claude', 'skills', 'fleet');
    const pmSkillsDir = path.join(mockHome, '.claude', 'skills', 'pm');
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(
      expect.stringContaining(fleetSkillsDir),
      expect.any(Object)
    );
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(
      expect.stringContaining(pmSkillsDir),
      expect.any(Object)
    );
  });

  it('--skill all installs both fleet and pm skills', async () => {
    vi.mocked(fs.readdirSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('skills') && ps.includes('pm')) {
        return [{ name: 'SKILL.md', isDirectory: () => false }] as any;
      }
      return [];
    });

    await runInstall(['--skill', 'all']);

    const fleetSkillsDir = path.join(mockHome, '.claude', 'skills', 'fleet');
    const pmSkillsDir = path.join(mockHome, '.claude', 'skills', 'pm');
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(
      expect.stringContaining(fleetSkillsDir),
      expect.any(Object)
    );
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(
      expect.stringContaining(pmSkillsDir),
      expect.any(Object)
    );
  });

  it('--skill fleet installs only fleet skill, not pm', async () => {
    await runInstall(['--skill', 'fleet']);

    const fleetSkillsDir = path.join(mockHome, '.claude', 'skills', 'fleet');
    const pmSkillsDir = path.join(mockHome, '.claude', 'skills', 'pm');

    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(
      expect.stringContaining(fleetSkillsDir),
      expect.any(Object)
    );
    const pmMkdir = vi.mocked(fs.mkdirSync).mock.calls.find(c =>
      c[0].toString().includes(pmSkillsDir)
    );
    expect(pmMkdir).toBeUndefined();
  });

  it('--skill pm installs both fleet and pm skills (fleet is a pm dependency)', async () => {
    vi.mocked(fs.readdirSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('skills') && ps.includes('pm')) {
        return [{ name: 'SKILL.md', isDirectory: () => false }] as any;
      }
      return [];
    });

    await runInstall(['--skill', 'pm']);

    const fleetSkillsDir = path.join(mockHome, '.claude', 'skills', 'fleet');
    const pmSkillsDir = path.join(mockHome, '.claude', 'skills', 'pm');
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(
      expect.stringContaining(fleetSkillsDir),
      expect.any(Object)
    );
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(
      expect.stringContaining(pmSkillsDir),
      expect.any(Object)
    );
  });

  it('--skill=fleet (equals form) installs only fleet skill', async () => {
    await runInstall(['--skill=fleet']);

    const fleetSkillsDir = path.join(mockHome, '.claude', 'skills', 'fleet');
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(
      expect.stringContaining(fleetSkillsDir),
      expect.any(Object)
    );
    const pmSkillsDir = path.join(mockHome, '.claude', 'skills', 'pm');
    const pmMkdir = vi.mocked(fs.mkdirSync).mock.calls.find(c =>
      c[0].toString().includes(pmSkillsDir)
    );
    expect(pmMkdir).toBeUndefined();
  });

  it('--skill=pm (equals form) installs both fleet and pm skills', async () => {
    vi.mocked(fs.readdirSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('skills') && ps.includes('pm')) {
        return [{ name: 'SKILL.md', isDirectory: () => false }] as any;
      }
      return [];
    });

    await runInstall(['--skill=pm']);

    const fleetSkillsDir = path.join(mockHome, '.claude', 'skills', 'fleet');
    const pmSkillsDir = path.join(mockHome, '.claude', 'skills', 'pm');
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(
      expect.stringContaining(fleetSkillsDir),
      expect.any(Object)
    );
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(
      expect.stringContaining(pmSkillsDir),
      expect.any(Object)
    );
  });

  it('--skill=invalid exits with error', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runInstall(['--skill=invalid'])).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('bare install (no flags) defaults to all — installs fleet + pm skills', async () => {
    vi.mocked(fs.readdirSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('skills') && ps.includes('pm')) {
        return [{ name: 'SKILL.md', isDirectory: () => false }] as any;
      }
      return [];
    });

    await runInstall([]);

    const fleetSkillsDir = path.join(mockHome, '.claude', 'skills', 'fleet');
    const pmSkillsDir = path.join(mockHome, '.claude', 'skills', 'pm');
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(
      expect.stringContaining(fleetSkillsDir),
      expect.any(Object)
    );
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(
      expect.stringContaining(pmSkillsDir),
      expect.any(Object)
    );
  });

  it('--skill none skips both fleet and pm skills', async () => {
    await runInstall(['--skill', 'none']);

    const fleetSkillsDir = path.join(mockHome, '.claude', 'skills', 'fleet');
    const pmSkillsDir = path.join(mockHome, '.claude', 'skills', 'pm');
    const fleetMkdir = vi.mocked(fs.mkdirSync).mock.calls.find(c =>
      c[0].toString().includes(fleetSkillsDir)
    );
    const pmMkdir = vi.mocked(fs.mkdirSync).mock.calls.find(c =>
      c[0].toString().includes(pmSkillsDir)
    );
    expect(fleetMkdir).toBeUndefined();
    expect(pmMkdir).toBeUndefined();
  });

  it('--skill=none (equals form) skips both fleet and pm skills', async () => {
    await runInstall(['--skill=none']);

    const fleetSkillsDir = path.join(mockHome, '.claude', 'skills', 'fleet');
    const pmSkillsDir = path.join(mockHome, '.claude', 'skills', 'pm');
    const fleetMkdir = vi.mocked(fs.mkdirSync).mock.calls.find(c =>
      c[0].toString().includes(fleetSkillsDir)
    );
    const pmMkdir = vi.mocked(fs.mkdirSync).mock.calls.find(c =>
      c[0].toString().includes(pmSkillsDir)
    );
    expect(fleetMkdir).toBeUndefined();
    expect(pmMkdir).toBeUndefined();
  });

  it('--no-skill skips both fleet and pm skills', async () => {
    await runInstall(['--no-skill']);

    const fleetSkillsDir = path.join(mockHome, '.claude', 'skills', 'fleet');
    const pmSkillsDir = path.join(mockHome, '.claude', 'skills', 'pm');
    const fleetMkdir = vi.mocked(fs.mkdirSync).mock.calls.find(c =>
      c[0].toString().includes(fleetSkillsDir)
    );
    const pmMkdir = vi.mocked(fs.mkdirSync).mock.calls.find(c =>
      c[0].toString().includes(pmSkillsDir)
    );
    expect(fleetMkdir).toBeUndefined();
    expect(pmMkdir).toBeUndefined();
  });

  // --help / -h guard tests (#142)

  it('--help prints usage and exits 0 with no side effects', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(runInstall(['--help'])).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(logSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain('apra-fleet install');
    // No file writes should have occurred
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled();

    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  // Regression guard (apra-fleet-7pm.14): install --help output must stay
  // byte-for-byte unchanged versus tests/fixtures/regression-command-surface/install-help.txt
  // after this epic's install.ts/uninstall.ts/update.ts/index.ts edits land.
  it('--help output is byte-for-byte unchanged versus its fixture (apra-fleet-7pm.14)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(runInstall(['--help'])).rejects.toThrow('exit');

    const actual = normalizeCommandSurfaceOutput(logSpy.mock.calls.map(c => c.join(' ')).join('\n'));
    const expected = readCommandSurfaceFixture('install-help.txt');
    expect(actual).toBe(expected);

    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  // ── Gemini hook name translation ──────────────────────────────────────────

  it('translates PostToolUse -> AfterTool in Gemini settings.json', async () => {
    const hooksConfig = {
      hooks: {
        PostToolUse: [{ matcher: 'mcp__apra-fleet__register_member', hooks: [{ type: 'command', command: 'bash hook.sh' }] }],
      },
    };
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.0' });
      if (ps.includes('hooks-config.json')) return JSON.stringify(hooksConfig);
      return '';
    });

    await runInstall(['--llm', 'gemini']);

    const geminiSettings = path.join(mockHome, '.gemini', 'settings.json');
    const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
      c[0].toString().includes(geminiSettings)
    );
    const hooksWrite = writes.find(c => c[1].toString().includes('AfterTool'));
    expect(hooksWrite).toBeDefined();
    const parsed = JSON.parse(hooksWrite![1].toString());
    expect(parsed.hooks.AfterTool).toBeDefined();
    expect(parsed.hooks.PostToolUse).toBeUndefined();
  });

  it('deletes stale PostToolUse key when reinstalling for Gemini', async () => {
    const fileState = new Map<string, string>();
    const geminiSettings = path.join(mockHome, '.gemini', 'settings.json');

    // Pre-seed settings.json with a stale PostToolUse entry
    fileState.set(
      geminiSettings,
      JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'mcp__apra-fleet__register_member', hooks: [] }] } })
    );

    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return true;
      if (ps.includes('hooks-config.json')) return true;
      if (fileState.has(ps)) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (fileState.has(ps)) return fileState.get(ps)!;
      if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.0' });
      if (ps.includes('hooks-config.json')) return JSON.stringify({
        hooks: { PostToolUse: [{ matcher: 'mcp__apra-fleet__register_member', hooks: [{ type: 'command', command: 'bash hook.sh' }] }] },
      });
      return '';
    });
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, content: any) => {
      fileState.set(p.toString(), content.toString());
    });

    await runInstall(['--llm', 'gemini']);

    const finalContent = fileState.get(geminiSettings);
    expect(finalContent).toBeDefined();
    const parsed = JSON.parse(finalContent!);
    expect(parsed.hooks.PostToolUse).toBeUndefined();
    expect(parsed.hooks.AfterTool).toBeDefined();
  });

  it('mergePermissions adds catch-all skills directory permission for Gemini', async () => {
    await runInstall(['--llm', 'gemini']);

    const geminiSettings = path.join(mockHome, '.gemini', 'settings.json');
    const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
      c[0].toString().includes(geminiSettings)
    );
    expect(writes.length).toBeGreaterThan(0);
    const lastContent = writes.at(-1)![1].toString();
    // Catch-all: ~/.gemini/skills/** (covers user-defined and bundled skills beyond pm/ and fleet/)
    expect(lastContent).toContain('/mock/home/.gemini/skills/**');
  });

  it('-h prints usage and exits 0 with no side effects', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(runInstall(['-h'])).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled();

    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('fleet skill is installed before pm skill (fleet-before-pm order)', async () => {
    vi.mocked(fs.readdirSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('skills') && ps.includes('pm')) {
        return [{ name: 'SKILL.md', isDirectory: () => false }] as any;
      }
      return [];
    });

    await runInstall(['--skill', 'all']);

    const fleetSkillsDir = path.join(mockHome, '.claude', 'skills', 'fleet');
    const pmSkillsDir = path.join(mockHome, '.claude', 'skills', 'pm');

    const mkdirCalls = vi.mocked(fs.mkdirSync).mock.calls.map(c => c[0].toString());
    const fleetIdx = mkdirCalls.findIndex(p => p.includes(fleetSkillsDir));
    const pmIdx = mkdirCalls.findIndex(p => p.includes(pmSkillsDir));

    expect(fleetIdx).toBeGreaterThanOrEqual(0);
    expect(pmIdx).toBeGreaterThanOrEqual(0);
    expect(fleetIdx).toBeLessThan(pmIdx);
  });

  // ── Agent install tests ──────────────────────────────────────────────

  for (const llm of ['claude', 'gemini', 'agy'] as const) {
    it(`installs 4 agent files for ${llm}`, async () => {
      vi.mocked(fs.readdirSync).mockImplementation((p: any, opts?: any) => {
        const ps = p.toString();
        if (ps.includes('agents')) {
          return [
            { name: 'doer.md', isDirectory: () => false },
            { name: 'planner.md', isDirectory: () => false },
            { name: 'plan-reviewer.md', isDirectory: () => false },
            { name: 'reviewer.md', isDirectory: () => false },
          ] as any;
        }
        if (ps.includes('skills') && ps.includes('pm')) {
          return [{ name: 'SKILL.md', isDirectory: () => false }] as any;
        }
        return [];
      });

      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const ps = p.toString();
        if (ps.includes('version.json')) return true;
        if (ps.includes('hooks-config.json')) return true;
        if (ps.includes('apra-pm') && ps.includes('agents')) return true;
        return false;
      });

      await runInstall(['--llm', llm]);

      const writeAssetCalls = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
        c[0].toString().includes('agents') && c[0].toString().endsWith('.md')
      );
      expect(writeAssetCalls.length).toBe(4);
    });
  }

  it('installs transformed agent files for opencode', async () => {
    vi.mocked(fs.readdirSync).mockImplementation((p: any, opts?: any) => {
      const ps = p.toString();
      if (ps.includes('agents')) {
        return [
          { name: 'doer.md', isDirectory: () => false },
          { name: 'planner.md', isDirectory: () => false },
          { name: 'plan-reviewer.md', isDirectory: () => false },
          { name: 'reviewer.md', isDirectory: () => false },
        ] as any;
      }
      if (ps.includes('skills') && ps.includes('pm')) {
        return [{ name: 'SKILL.md', isDirectory: () => false }] as any;
      }
      return [];
    });

    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return true;
      if (ps.includes('hooks-config.json')) return true;
      if (ps.includes('apra-pm') && ps.includes('agents')) return true;
      return false;
    });

    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.3_62ec2e' });
      if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
      if (ps.includes('agents') && ps.endsWith('.md')) {
        return '---\nname: test\ndescription: Test agent.\ntools: [Read, Write, Bash]\n---\n\n# Body';
      }
      return '';
    });

    await runInstall(['--llm', 'opencode']);

    const agentWrites = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
      c[0].toString().includes('agents') && c[0].toString().endsWith('.md')
    );
    expect(agentWrites.length).toBe(4);
    for (const [, content] of agentWrites) {
      const text = content.toString();
      expect(text).toContain('mode: subagent');
      expect(text).not.toContain('name: test');
      expect(text).toContain('# Body');
    }
  });

  for (const llm of ['codex', 'copilot'] as const) {
    it(`skips agent install for ${llm} (agentsDir undefined)`, async () => {
      await runInstall(['--llm', llm]);

      const agentMkdir = vi.mocked(fs.mkdirSync).mock.calls.find(c =>
        c[0].toString().includes('agents')
      );
      expect(agentMkdir).toBeUndefined();
    });
  }

  // ── All 8 agents (deployer/harvester/ci-watcher/integ-test-runner) ──────

  const ALL_8_AGENTS = [
    'doer.md',
    'planner.md',
    'plan-reviewer.md',
    'reviewer.md',
    'deployer.md',
    'harvester.md',
    'ci-watcher.md',
    'integ-test-runner.md',
  ];

  for (const llm of ['claude', 'gemini', 'agy'] as const) {
    it(`all 8 agents (including deployer/harvester/ci-watcher/integ-test-runner) land for ${llm}`, async () => {
      vi.mocked(fs.readdirSync).mockImplementation((p: any, opts?: any) => {
        const ps = p.toString();
        if (ps.includes('agents')) {
          return ALL_8_AGENTS.map(name => ({ name, isDirectory: () => false })) as any;
        }
        if (ps.includes('skills') && ps.includes('pm')) {
          return [{ name: 'SKILL.md', isDirectory: () => false }] as any;
        }
        return [];
      });

      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const ps = p.toString();
        if (ps.includes('version.json')) return true;
        if (ps.includes('hooks-config.json')) return true;
        if (ps.includes('apra-pm') && ps.includes('agents')) return true;
        return false;
      });

      await runInstall(['--llm', llm]);

      const agentWrites = vi.mocked(fs.writeFileSync).mock.calls
        .filter(c => c[0].toString().includes('agents') && c[0].toString().endsWith('.md'))
        .map(c => path.basename(c[0].toString()));

      expect(agentWrites).toHaveLength(8);
      for (const agentFile of ALL_8_AGENTS) {
        expect(agentWrites).toContain(agentFile);
      }
    });
  }

  it('all 8 agents land for opencode with mode:subagent frontmatter', async () => {
    vi.mocked(fs.readdirSync).mockImplementation((p: any, opts?: any) => {
      const ps = p.toString();
      if (ps.includes('agents')) {
        return ALL_8_AGENTS.map(name => ({ name, isDirectory: () => false })) as any;
      }
      if (ps.includes('skills') && ps.includes('pm')) {
        return [{ name: 'SKILL.md', isDirectory: () => false }] as any;
      }
      return [];
    });

    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return true;
      if (ps.includes('hooks-config.json')) return true;
      if (ps.includes('apra-pm') && ps.includes('agents')) return true;
      return false;
    });

    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.3_62ec2e' });
      if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
      if (ps.includes('agents') && ps.endsWith('.md')) {
        return '---\nname: test\ndescription: Test agent.\ntools: [Read, Write, Bash]\n---\n\n# Body';
      }
      return '';
    });

    await runInstall(['--llm', 'opencode']);

    const agentWrites = vi.mocked(fs.writeFileSync).mock.calls
      .filter(c => c[0].toString().includes('agents') && c[0].toString().endsWith('.md'));

    expect(agentWrites).toHaveLength(8);
    for (const [, content] of agentWrites) {
      const text = content.toString();
      expect(text).toContain('mode: subagent');
    }
    const agentNames = agentWrites.map(c => path.basename(c[0].toString()));
    for (const agentFile of ALL_8_AGENTS) {
      expect(agentNames).toContain(agentFile);
    }
  });

  // ── Phase D1: cost.js, auto-sprint workflow, claude-only perms ──────────

  // Mock auto-sprint.js content with required PURE_FUNCTIONS markers.
  // Does NOT contain agent() or phase() calls (pure JS only).
  const MOCK_AUTO_SPRINT_JS = [
    '// preamble',
    '',
    '// PURE_FUNCTIONS_BEGIN -- extracted by test/sprint-cost.test.mjs via vm; keep this block self-contained',
    'const DEFAULT_CALIBRATION = { tokensPerDollar: 1000 };',
    'function computeSprintQuote(tokens) { return tokens * 0.001; }',
    'function computeSprintAnalysis(data) { return data; }',
    'function accumulateBucketTokens(bucket, tokens) { return bucket + tokens; }',
    'function computeUpdatedCalibration(cal, data) { return cal; }',
    'function buildSprintSummary(data) { return data; }',
    'function buildExecutionSummary(data) { return data; }',
    'function reviewerModelFor(model) { return model; }',
    '// PURE_FUNCTIONS_END',
    '',
    '// workflow orchestration code (no agent() or phase() calls here)',
  ].join('\n');

  // Helper: set up fileState + mocks that expose auto-sprint.js for cost extraction.
  function setupWorkflowMocks() {
    const fileState = new Map<string, string>();

    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return true;
      if (ps.includes('hooks-config.json')) return true;
      if (ps.includes('auto-sprint.js')) return true;
      if (fileState.has(ps)) return true;
      return false;
    });

    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (fileState.has(ps)) return fileState.get(ps)!;
      if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.3_62ec2e' });
      if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
      if (ps.includes('auto-sprint.js')) return MOCK_AUTO_SPRINT_JS;
      return '';
    });

    vi.mocked(fs.writeFileSync).mockImplementation((p: any, content: any) => {
      fileState.set(p.toString(), content.toString());
    });

    return fileState;
  }

  it('cost.js is written to skillsDir for all providers when PM is installed', async () => {
    const providerSkillsDirs: Array<[string, string]> = [
      ['claude',   path.join(mockHome, '.claude', 'skills', 'pm', 'cost.js')],
      ['gemini',   path.join(mockHome, '.gemini', 'skills', 'pm', 'cost.js')],
      ['agy',      path.join(mockHome, '.gemini', 'antigravity-cli', 'skills', 'pm', 'cost.js')],
      ['opencode', path.join(mockHome, '.config', 'opencode', 'skills', 'pm', 'cost.js')],
    ];

    for (const [llm, expectedCostJsPath] of providerSkillsDirs) {
      vi.clearAllMocks();
      vi.mocked(os.homedir).mockReturnValue(mockHome);

      const fileState = setupWorkflowMocks();

      await runInstall(['--llm', llm]);

      expect(fileState.has(expectedCostJsPath), `cost.js missing for ${llm}`).toBe(true);
    }
  });

  it('cost.js contains computeSprintQuote and has no agent()/phase() calls', async () => {
    const fileState = setupWorkflowMocks();

    await runInstall([]);

    const costJsPath = path.join(mockHome, '.claude', 'skills', 'pm', 'cost.js');
    const content = fileState.get(costJsPath);
    expect(content).toBeDefined();
    expect(content).toContain('computeSprintQuote');
    expect(content).toContain('buildExecutionSummary');
    expect(content).not.toMatch(/\bagent\s*\(/);
    expect(content).not.toMatch(/\bphase\s*\(/);
  });

  it('auto-sprint.js is copied to ~/.claude/workflows/ after claude+PM install', async () => {
    const fileState = setupWorkflowMocks();

    await runInstall([]);

    const workflowDest = path.join(mockHome, '.claude', 'workflows', 'auto-sprint.js');
    expect(fileState.has(workflowDest)).toBe(true);
    expect(fileState.get(workflowDest)).toContain('PURE_FUNCTIONS_BEGIN');
  });

  it('auto-sprint.js is NOT written to ~/.claude/workflows/ for opencode install', async () => {
    const fileState = setupWorkflowMocks();

    await runInstall(['--llm', 'opencode']);

    const workflowDest = path.join(mockHome, '.claude', 'workflows', 'auto-sprint.js');
    expect(fileState.has(workflowDest)).toBe(false);
  });

  it('auto-sprint.js is NOT written to ~/.claude/workflows/ for gemini install', async () => {
    const fileState = setupWorkflowMocks();

    await runInstall(['--llm', 'gemini']);

    const workflowDest = path.join(mockHome, '.claude', 'workflows', 'auto-sprint.js');
    expect(fileState.has(workflowDest)).toBe(false);
  });

  it('Skill(auto-sprint) and Workflow(auto-sprint) are in claude settings.json allow list', async () => {
    const fileState = setupWorkflowMocks();

    await runInstall([]);

    const claudeSettings = path.join(mockHome, '.claude', 'settings.json');
    const content = fileState.get(claudeSettings);
    expect(content).toBeDefined();
    const parsed = JSON.parse(content!);
    const allow: string[] = parsed?.permissions?.allow ?? [];
    expect(allow).toContain('Bash(*)');
    expect(allow).toContain('Skill(auto-sprint)');
    expect(allow).toContain('Workflow(auto-sprint)');
  });

  it('Skill(auto-sprint) and Workflow(auto-sprint) are absent from opencode settings', async () => {
    const fileState = setupWorkflowMocks();

    await runInstall(['--llm', 'opencode']);

    const opencodeSettings = path.join(mockHome, '.config', 'opencode', 'opencode.json');
    const content = fileState.get(opencodeSettings);
    // opencode.json has no top-level permissions key at all
    if (content) {
      const parsed = JSON.parse(content);
      expect(parsed).not.toHaveProperty('permissions');
      const allow: string[] = parsed?.permissions?.allow ?? [];
      expect(allow).not.toContain('Skill(auto-sprint)');
      expect(allow).not.toContain('Workflow(auto-sprint)');
    }
    // No claude workflows written either
    const workflowDest = path.join(mockHome, '.claude', 'workflows', 'auto-sprint.js');
    expect(fileState.has(workflowDest)).toBe(false);
  });

  it('Skill(auto-sprint) and Workflow(auto-sprint) are absent from gemini settings', async () => {
    const fileState = setupWorkflowMocks();

    await runInstall(['--llm', 'gemini']);

    const geminiSettings = path.join(mockHome, '.gemini', 'settings.json');
    const content = fileState.get(geminiSettings);
    if (content) {
      const parsed = JSON.parse(content);
      const allow: string[] = parsed?.permissions?.allow ?? [];
      expect(allow).not.toContain('Skill(auto-sprint)');
      expect(allow).not.toContain('Workflow(auto-sprint)');
    }
  });

  it('auto-sprint.js is NOT written to ~/.claude/workflows/ for agy install', async () => {
    const fileState = setupWorkflowMocks();

    await runInstall(['--llm', 'agy']);

    const workflowDest = path.join(mockHome, '.claude', 'workflows', 'auto-sprint.js');
    expect(fileState.has(workflowDest)).toBe(false);
  });

  it('Skill(auto-sprint) and Workflow(auto-sprint) are absent from agy settings', async () => {
    const fileState = setupWorkflowMocks();

    await runInstall(['--llm', 'agy']);

    const agySettings = path.join(mockHome, '.gemini', 'antigravity-cli', 'settings.json');
    const content = fileState.get(agySettings);
    if (content) {
      const parsed = JSON.parse(content);
      const allow: string[] = parsed?.permissions?.allow ?? [];
      expect(allow).not.toContain('Skill(auto-sprint)');
      expect(allow).not.toContain('Workflow(auto-sprint)');
    }
  });

  // ── OpenCode strict-schema regression tests ───────────────────────────

  const OPENCODE_VALID_KEYS = new Set(['$schema', 'provider', 'model', 'mcp', 'permission', 'agent']);
  const OPENCODE_FORBIDDEN_KEYS = ['hooks', 'statusLine', 'defaultModel', 'mcpServers', 'permissions'];

  it('opencode install produces only valid opencode.json keys (no hooks/statusLine/defaultModel/mcpServers/permissions)', async () => {
    vi.mocked(fs.readdirSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('agents')) {
        return [
          { name: 'doer.md', isDirectory: () => false },
        ] as any;
      }
      if (ps.includes('skills') && ps.includes('pm')) {
        return [{ name: 'SKILL.md', isDirectory: () => false }] as any;
      }
      return [];
    });

    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return true;
      if (ps.includes('hooks-config.json')) return true;
      if (ps.includes('apra-pm') && ps.includes('agents')) return true;
      return false;
    });

    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.3_62ec2e' });
      if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
      if (ps.includes('agents') && ps.endsWith('.md')) {
        return '---\nname: test\ndescription: Test.\ntools: [Read]\n---\n\nBody';
      }
      return '';
    });

    const fileState = new Map<string, string>();
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, content: any) => {
      fileState.set(p.toString(), content.toString());
    });

    await runInstall(['--llm', 'opencode']);

    const opencodeSettings = path.join(mockHome, '.config', 'opencode', 'opencode.json');
    const finalContent = fileState.get(opencodeSettings);
    expect(finalContent).toBeDefined();
    const parsed = JSON.parse(finalContent!);

    for (const key of OPENCODE_FORBIDDEN_KEYS) {
      expect(parsed).not.toHaveProperty(key);
    }
    for (const key of Object.keys(parsed)) {
      expect(OPENCODE_VALID_KEYS).toContain(key);
    }
  });

  it('opencode MCP is written under mcp["apra-fleet"] with type:local and command array', async () => {
    const fileState = new Map<string, string>();
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, content: any) => {
      fileState.set(p.toString(), content.toString());
    });

    await runInstall(['--llm', 'opencode', '--transport', 'stdio']);

    const opencodeSettings = path.join(mockHome, '.config', 'opencode', 'opencode.json');
    const finalContent = fileState.get(opencodeSettings);
    expect(finalContent).toBeDefined();
    const parsed = JSON.parse(finalContent!);

    expect(parsed.mcp).toBeDefined();
    expect(parsed.mcp['apra-fleet']).toBeDefined();
    expect(parsed.mcp['apra-fleet'].type).toBe('local');
    expect(Array.isArray(parsed.mcp['apra-fleet'].command)).toBe(true);
    expect(parsed.mcp['apra-fleet'].enabled).toBe(true);
  });

  it('opencode MCP defaults to type:remote with fleet URL for http transport', async () => {
    const fileState = new Map<string, string>();
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, content: any) => {
      fileState.set(p.toString(), content.toString());
    });

    await runInstall(['--llm', 'opencode']);

    const opencodeSettings = path.join(mockHome, '.config', 'opencode', 'opencode.json');
    const finalContent = fileState.get(opencodeSettings);
    expect(finalContent).toBeDefined();
    const parsed = JSON.parse(finalContent!);

    expect(parsed.mcp['apra-fleet'].type).toBe('remote');
    expect(parsed.mcp['apra-fleet'].url).toBe('http://localhost:7523/mcp');
    expect(parsed.mcp['apra-fleet'].enabled).toBe(true);
  });

  it('claude install still has hooks/statusLine/permissions/mcpServers (no regression)', async () => {
    const fileState = new Map<string, string>();

    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (ps.includes('version.json')) return true;
      if (ps.includes('hooks-config.json')) return true;
      if (fileState.has(ps)) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      const ps = p.toString();
      if (fileState.has(ps)) return fileState.get(ps)!;
      if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.3_62ec2e' });
      if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'test', hooks: [] }] } });
      return '';
    });
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, content: any) => {
      fileState.set(p.toString(), content.toString());
    });
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);

    await runInstall([]);

    const claudeSettings = path.join(mockHome, '.claude', 'settings.json');
    const finalContent = fileState.get(claudeSettings);
    expect(finalContent).toBeDefined();
    const parsed = JSON.parse(finalContent!);

    expect(parsed).toHaveProperty('hooks');
    expect(parsed).toHaveProperty('statusLine');
    expect(parsed).toHaveProperty('permissions');
  });

  // -- Transport flag tests --

  it('--transport http (default) uses URL-based Claude MCP registration', async () => {
    await runInstall([]);

    const calls = vi.mocked(execSync).mock.calls.map(c => c[0].toString());
    const addCall = calls.find(c => c.includes('claude mcp add'));
    expect(addCall).toBeDefined();
    expect(addCall).toContain('--transport http');
    expect(addCall).toContain('http://localhost:7523/mcp');
  });

  it('--transport stdio uses command+args Claude MCP registration', async () => {
    await runInstall(['--transport', 'stdio']);

    const calls = vi.mocked(execSync).mock.calls.map(c => c[0].toString());
    const addCall = calls.find(c => c.includes('claude mcp add'));
    expect(addCall).toBeDefined();
    expect(addCall).not.toContain('--transport http');
    expect(addCall).not.toContain('http://localhost:7523/mcp');
  });

  it('--transport http writes httpUrl for Gemini', async () => {
    await runInstall(['--llm', 'gemini']);

    const geminiSettings = path.join(mockHome, '.gemini', 'settings.json');
    const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
      c[0].toString().includes(geminiSettings)
    );
    expect(writes.length).toBeGreaterThan(0);
    const lastWrite = writes.at(-1)![1].toString();
    const parsed = JSON.parse(lastWrite);
    expect(parsed.mcpServers['apra-fleet'].httpUrl).toBe('http://localhost:7523/mcp');
    expect(parsed.mcpServers['apra-fleet'].trust).toBe(true);
  });

  it('--transport stdio writes command+args for Gemini', async () => {
    await runInstall(['--llm', 'gemini', '--transport', 'stdio']);

    const geminiSettings = path.join(mockHome, '.gemini', 'settings.json');
    const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
      c[0].toString().includes(geminiSettings)
    );
    expect(writes.length).toBeGreaterThan(0);
    const lastWrite = writes.at(-1)![1].toString();
    const parsed = JSON.parse(lastWrite);
    expect(parsed.mcpServers['apra-fleet'].command).toBeDefined();
    expect(parsed.mcpServers['apra-fleet'].httpUrl).toBeUndefined();
  });

  it('--transport http writes url+type for Copilot', async () => {
    await runInstall(['--llm', 'copilot']);

    const copilotSettings = path.join(mockHome, '.copilot', 'settings.json');
    const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
      c[0].toString().includes(copilotSettings)
    );
    expect(writes.length).toBeGreaterThan(0);
    const lastWrite = writes.at(-1)![1].toString();
    const parsed = JSON.parse(lastWrite);
    expect(parsed.mcpServers['apra-fleet'].url).toBe('http://localhost:7523/mcp');
    expect(parsed.mcpServers['apra-fleet'].type).toBe('http');
  });

  it('--transport stdio writes command+args for Copilot', async () => {
    await runInstall(['--llm', 'copilot', '--transport', 'stdio']);

    const copilotSettings = path.join(mockHome, '.copilot', 'settings.json');
    const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
      c[0].toString().includes(copilotSettings)
    );
    expect(writes.length).toBeGreaterThan(0);
    const lastWrite = writes.at(-1)![1].toString();
    const parsed = JSON.parse(lastWrite);
    expect(parsed.mcpServers['apra-fleet'].command).toBeDefined();
    expect(parsed.mcpServers['apra-fleet'].url).toBeUndefined();
  });

  it('--transport http writes url for Codex', async () => {
    await runInstall(['--llm', 'codex']);

    const codexConfig = path.join(mockHome, '.codex', 'config.toml');
    const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
      c[0].toString().includes(codexConfig)
    );
    expect(writes.length).toBeGreaterThan(0);
    const finalContent = writes.at(-1)![1].toString();
    const parsed = parseToml(finalContent) as any;
    expect(parsed.mcp_servers['apra-fleet'].url).toBe('http://localhost:7523/mcp');
    expect(parsed.mcp_servers['apra-fleet'].command).toBeUndefined();
  });

  it('--transport http writes url for agy', async () => {
    await runInstall(['--llm', 'agy']);

    const agyMcpConfig = path.join(mockHome, '.gemini', 'config', 'mcp_config.json');
    const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
      c[0].toString().includes(agyMcpConfig)
    );
    expect(writes.length).toBeGreaterThan(0);
    const lastWrite = writes.at(-1)![1].toString();
    const parsed = JSON.parse(lastWrite);
    expect(parsed.mcpServers['apra-fleet'].url).toBe('http://localhost:7523/mcp');
  });

  it('--transport stdio writes command+args for agy', async () => {
    await runInstall(['--llm', 'agy', '--transport', 'stdio']);

    const agyMcpConfig = path.join(mockHome, '.gemini', 'config', 'mcp_config.json');
    const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
      c[0].toString().includes(agyMcpConfig)
    );
    expect(writes.length).toBeGreaterThan(0);
    const lastWrite = writes.at(-1)![1].toString();
    const parsed = JSON.parse(lastWrite);
    expect(parsed.mcpServers['apra-fleet'].command).toBeDefined();
    expect(parsed.mcpServers['apra-fleet'].url).toBeUndefined();
  });

  it('--transport=invalid exits with error', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runInstall(['--transport=invalid'])).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
