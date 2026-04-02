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
    
    // Mock fs.existsSync to return true for version.json to find project root
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      if (p.toString().includes('version.json')) return true;
      if (p.toString().includes('hooks-config.json')) return true;
      return false;
    });

    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (p.toString().includes('version.json')) return JSON.stringify({ version: '0.1.0' });
      if (p.toString().includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
      return '';
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

  it('installs for Gemini when --llm=gemini is passed', async () => {
    await runInstall(['--llm=gemini']);
    
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
    const geminiWrite = vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0].toString().includes(geminiSettings));
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
    const codexWrite = vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0].toString().includes(codexConfig));
    expect(codexWrite).toBeDefined();
    expect(codexWrite![1].toString()).toContain('[mcp_servers.apra-fleet]');
  });

  it('installs for Copilot when --llm=copilot is passed', async () => {
    await runInstall(['--llm=copilot']);
    
    // Check if Copilot paths are used
    const copilotSettings = path.join(mockHome, '.copilot', 'settings.json');
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      expect.stringContaining(copilotSettings),
      expect.any(String)
    );

    // Should have written to Copilot settings
    const copilotWrite = vi.mocked(fs.writeFileSync).mock.calls.find(c => c[0].toString().includes(copilotSettings));
    expect(copilotWrite).toBeDefined();
    expect(copilotWrite![1].toString()).toContain('apra-fleet');
  });

  it('errors on unsupported provider', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    
    await expect(runInstall(['--llm=unsupported'])).rejects.toThrow('exit');
    
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
