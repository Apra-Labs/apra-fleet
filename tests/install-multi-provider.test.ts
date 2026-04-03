import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { runInstall } from '../src/cli/install.js';

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
      if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.0' });
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
    expect(codexWrite![1].toString()).toContain('[mcp_servers.apra-fleet]');
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
    expect(geminiWrite![1].toString()).toContain(`Read(${geminiSkillsDir.replace(/\\/g, '/')}`);
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
        if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.0' });
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
    expect(parsed.mcpServers?.['apra-fleet']).toBeDefined();
    expect(parsed.mcpServers['apra-fleet'].trust).toBe(true);
  });

  it('Codex MCP registration writes [mcp_servers.apra-fleet] TOML section', async () => {
    await runInstall(['--llm', 'codex']);

    const codexConfig = path.join(mockHome, '.codex', 'config.toml');
    const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
      c[0].toString().includes(codexConfig)
    );
    expect(writes.length).toBeGreaterThan(0);
    const lastWrite = writes.at(-1)![1].toString();
    expect(lastWrite).toContain('[mcp_servers.apra-fleet]');
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
        if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.0' });
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
        return p.includes(`.${llm}`);
      });
      expect(settingsWrites.length).toBeGreaterThan(0);

      // The permissions write is the last one
      const lastContent = settingsWrites.at(-1)![1].toString();
      const normalizedSkillsDir = skillsDir.replace(/\\/g, '/');
      expect(lastContent).toContain(`Read(${normalizedSkillsDir}`);
    }
  });

  it('writes defaultModel for Claude (claude-sonnet-4-6) to settings.json', async () => {
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
    expect(parsed.defaultModel).toBe('claude-sonnet-4-6');
  });

  it('writes defaultModel for Gemini (gemini-2.5-pro) to settings.json', async () => {
    await runInstall(['--llm', 'gemini']);

    const geminiSettings = path.join(mockHome, '.gemini', 'settings.json');
    const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
      c[0].toString().includes(geminiSettings)
    );
    expect(writes.length).toBeGreaterThan(0);
    const defaultModelWrite = writes.find(c => c[1].toString().includes('"defaultModel"'));
    expect(defaultModelWrite).toBeDefined();
    const parsed = JSON.parse(defaultModelWrite![1].toString());
    expect(parsed.defaultModel).toBe('gemini-2.5-pro');
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
});
