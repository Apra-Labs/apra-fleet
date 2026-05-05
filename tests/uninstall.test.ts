import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runUninstall } from '../src/cli/uninstall.js';
import * as config from '../src/cli/config.js';

vi.mock('node:fs');
vi.mock('node:child_process');
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn().mockReturnValue({
    question: vi.fn().mockResolvedValue('y'),
    close: vi.fn(),
  }),
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
  });

  it('shows help', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(runUninstall(['--help'])).rejects.toThrow('exit');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
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
      if (p.includes('settings.json')) return JSON.stringify(mockSettings);
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
});
