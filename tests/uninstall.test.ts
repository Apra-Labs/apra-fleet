import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import * as readline from 'node:readline/promises';
import { runUninstall } from '../src/cli/uninstall.js';
import * as config from '../src/cli/config.js';
import * as install from '../src/cli/install.js';

vi.mock('node:fs');
vi.mock('node:child_process');
vi.mock('../src/cli/install.js', () => ({
  isApraFleetRunning: vi.fn().mockReturnValue(false),
}));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(),
}));

describe('uninstall', () => {
  const home = '/home/user';
  const fleetBase = path.join(home, '.apra-fleet');
  const installConfigPath = path.join(fleetBase, 'data', 'install-config.json');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    
    // Default mocks for fs
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ providers: { claude: { skill: 'all' } } }));

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

  it('removes recorded providers by default', async () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ 
      providers: { 
        claude: { skill: 'all' },
        gemini: { skill: 'fleet' }
      } 
    }));
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    
    await runUninstall(['--yes']);
    
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Cleaning up Claude...'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Cleaning up Gemini...'));
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
      providers: { gemini: { skill: 'all' } } 
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
        gemini: { skill: 'fleet' }
      } 
    }));
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    
    await runUninstall(['--llm', 'gemini', '--yes']);
    
    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Cleaning up Claude...'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Cleaning up Gemini...'));
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
        return JSON.stringify({ llm: 'gemini', skill: 'pm' });
      }
      return '{}';
    });
    
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runUninstall(['--yes']);
    
    // Should clean up Gemini
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Cleaning up Gemini...'));
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
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Cleaning up Gemini...'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Cleaning up Codex...'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Cleaning up Copilot...'));
  });

  it('aborts if apra-fleet server is running', async () => {
    vi.mocked(install.isApraFleetRunning).mockReturnValue(true);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    await expect(runUninstall(['--yes'])).rejects.toThrow('exit');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('server is currently running'));
  });
});
