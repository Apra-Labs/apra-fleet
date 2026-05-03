import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { runInstall } from '../src/cli/install.js';

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/mock/home'),
    platform: vi.fn(() => 'linux'),
  }
}));
vi.mock('node:fs');
vi.mock('node:child_process');

const mockHome = '/mock/home';

function setupMocks() {
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
    if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.3' });
    if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
    return '';
  });
  vi.mocked(fs.writeFileSync).mockImplementation((p: any, content: any) => {
    fileState.set(p.toString(), content.toString());
  });
  vi.mocked(fs.readdirSync).mockReturnValue([] as any);

  return fileState;
}

describe('runInstall --data-dir / --instance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  // --- Claude + --data-dir ---

  it('--data-dir passes -e APRA_FLEET_DATA_DIR to claude mcp add', async () => {
    await runInstall(['--data-dir', '/custom/data']);

    const calls = vi.mocked(execFileSync).mock.calls;
    const addCall = calls.find(c => c[0] === 'claude' && Array.isArray(c[1]) && (c[1] as string[]).includes('add'));
    expect(addCall).toBeDefined();
    const args = addCall![1] as string[];
    expect(args.join(' ')).toContain('-e APRA_FLEET_DATA_DIR=/custom/data');
    expect(args).toContain('apra-fleet');
  });

  it('--data-dir with equals form works', async () => {
    await runInstall(['--data-dir=/my/dir']);

    const calls = vi.mocked(execFileSync).mock.calls;
    const addCall = calls.find(c => c[0] === 'claude' && Array.isArray(c[1]) && (c[1] as string[]).includes('add'));
    expect(addCall).toBeDefined();
    const args = addCall![1] as string[];
    expect(args.join(' ')).toContain('-e APRA_FLEET_DATA_DIR=/my/dir');
  });

  it('no --data-dir → no -e env flag in claude mcp add', async () => {
    await runInstall([]);

    const calls = vi.mocked(execFileSync).mock.calls;
    const addCall = calls.find(c => c[0] === 'claude' && Array.isArray(c[1]) && (c[1] as string[]).includes('add'));
    expect(addCall).toBeDefined();
    const args = addCall![1] as string[];
    expect(args.join(' ')).not.toContain('APRA_FLEET_DATA_DIR');
  });

  // --- Claude + --instance ---

  it('--instance sets server name to apra-fleet-<name>', async () => {
    await runInstall(['--instance', 'odm']);

    const calls = vi.mocked(execFileSync).mock.calls;
    const addCall = calls.find(c => c[0] === 'claude' && Array.isArray(c[1]) && (c[1] as string[]).includes('add'));
    expect(addCall).toBeDefined();
    expect(addCall![1] as string[]).toContain('apra-fleet-odm');
  });

  it('--instance sets APRA_FLEET_DATA_DIR to workspaces/<name>', async () => {
    await runInstall(['--instance', 'myproject']);

    const calls = vi.mocked(execFileSync).mock.calls;
    const addCall = calls.find(c => c[0] === 'claude' && Array.isArray(c[1]) && (c[1] as string[]).includes('add'));
    expect(addCall).toBeDefined();
    const args = addCall![1] as string[];
    const expectedPath = path.join(mockHome, '.apra-fleet', 'workspaces', 'myproject');
    expect(args.join(' ')).toContain(expectedPath);
  });

  it('--instance equals form works', async () => {
    await runInstall(['--instance=proj']);

    const calls = vi.mocked(execFileSync).mock.calls;
    const addCall = calls.find(c => c[0] === 'claude' && Array.isArray(c[1]) && (c[1] as string[]).includes('add'));
    expect(addCall).toBeDefined();
    expect(addCall![1] as string[]).toContain('apra-fleet-proj');
  });

  it('--instance removes the old server name before adding new', async () => {
    await runInstall(['--instance', 'odm']);

    const calls = vi.mocked(execSync).mock.calls.map(c => c[0].toString());
    const removeCall = calls.find(c => c.includes('mcp remove') && c.includes('apra-fleet-odm'));
    expect(removeCall).toBeDefined();
  });

  it('--instance with invalid chars errors and exits 1', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    await expect(runInstall(['--instance', 'my instance!'])).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  // --- Instance + workspaces.json registration ---

  it('--instance writes workspaces.json with the new workspace', async () => {
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
      if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.3' });
      if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
      return '';
    });
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, content: any) => {
      fileState.set(p.toString(), content.toString());
    });
    vi.mocked(fs.readdirSync).mockReturnValue([] as any);

    await runInstall(['--instance', 'odm']);

    const workspacesIndexPath = path.join(mockHome, '.apra-fleet', 'workspaces.json');
    const wsWrite = vi.mocked(fs.writeFileSync).mock.calls.find(c =>
      c[0].toString() === workspacesIndexPath
    );
    expect(wsWrite).toBeDefined();
    const parsed = JSON.parse(wsWrite![1].toString());
    expect(parsed.workspaces).toBeDefined();
    const odm = parsed.workspaces.find((w: any) => w.name === 'odm');
    expect(odm).toBeDefined();
    expect(odm.path).toContain('odm');
  });

  it('--data-dir alone does NOT write workspaces.json', async () => {
    await runInstall(['--data-dir', '/custom/data']);

    const workspacesIndexPath = path.join(mockHome, '.apra-fleet', 'workspaces.json');
    const wsWrite = vi.mocked(fs.writeFileSync).mock.calls.find(c =>
      c[0].toString() === workspacesIndexPath
    );
    expect(wsWrite).toBeUndefined();
  });

  // --- Gemini + --data-dir / --instance ---

  it('Gemini + --data-dir embeds env in mcpServers config', async () => {
    await runInstall(['--llm', 'gemini', '--data-dir', '/custom/data']);

    const geminiSettings = path.join(mockHome, '.gemini', 'settings.json');
    const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
      c[0].toString().includes(geminiSettings)
    );
    expect(writes.length).toBeGreaterThan(0);
    const lastContent = writes.at(-1)![1].toString();
    const parsed = JSON.parse(lastContent);
    expect(parsed.mcpServers?.['apra-fleet']?.env?.APRA_FLEET_DATA_DIR).toBe('/custom/data');
  });

  it('Gemini + --instance uses apra-fleet-<name> as server key', async () => {
    await runInstall(['--llm', 'gemini', '--instance', 'odm']);

    const geminiSettings = path.join(mockHome, '.gemini', 'settings.json');
    const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
      c[0].toString().includes(geminiSettings)
    );
    const lastContent = writes.at(-1)![1].toString();
    const parsed = JSON.parse(lastContent);
    expect(parsed.mcpServers?.['apra-fleet-odm']).toBeDefined();
    expect(parsed.mcpServers?.['apra-fleet']).toBeUndefined();
  });

  it('Gemini + no --data-dir does NOT embed env', async () => {
    await runInstall(['--llm', 'gemini']);

    const geminiSettings = path.join(mockHome, '.gemini', 'settings.json');
    const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
      c[0].toString().includes(geminiSettings)
    );
    const lastContent = writes.at(-1)![1].toString();
    const parsed = JSON.parse(lastContent);
    expect(parsed.mcpServers?.['apra-fleet']?.env).toBeUndefined();
  });

  // --- Permissions use correct server name ---

  it('permissions use mcp__apra-fleet-<name>__* for --instance', async () => {
    await runInstall(['--instance', 'odm']);

    const claudeSettings = path.join(mockHome, '.claude', 'settings.json');
    const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
      c[0].toString().includes(claudeSettings)
    );
    const permWrite = writes.find(c => c[1].toString().includes('mcp__apra-fleet'));
    expect(permWrite).toBeDefined();
    expect(permWrite![1].toString()).toContain('mcp__apra-fleet-odm__*');
    expect(permWrite![1].toString()).not.toContain('mcp__apra-fleet__*');
  });

  it('permissions use mcp__apra-fleet__* without --instance', async () => {
    await runInstall([]);

    const claudeSettings = path.join(mockHome, '.claude', 'settings.json');
    const writes = vi.mocked(fs.writeFileSync).mock.calls.filter(c =>
      c[0].toString().includes(claudeSettings)
    );
    const permWrite = writes.find(c => c[1].toString().includes('mcp__apra-fleet'));
    expect(permWrite).toBeDefined();
    expect(permWrite![1].toString()).toContain('mcp__apra-fleet__*');
  });

  // --- Tilde expansion in --data-dir ---

  it('--data-dir with ~ expands to home dir', async () => {
    await runInstall(['--data-dir', '~/custom/data']);

    const calls = vi.mocked(execFileSync).mock.calls;
    const addCall = calls.find(c => c[0] === 'claude' && Array.isArray(c[1]) && (c[1] as string[]).includes('add'));
    expect(addCall).toBeDefined();
    const argStr = (addCall![1] as string[]).join(' ');
    expect(argStr).toContain(`${mockHome}/custom/data`);
    expect(argStr).not.toContain('~');
  });
});
