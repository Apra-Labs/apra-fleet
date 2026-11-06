/**
 * Windows lookup rules for fleet-server spawns: a planted cmd.exe, taskkill.exe
 * or powershell.exe, and a relative PATH entry, are never used. The resolver
 * cases run on every OS through injected dependencies; the real-spawn cases run
 * on Windows only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  absoluteWindowsPathEntries,
  findOnAbsoluteWindowsPath,
  resolveWindowsSystemTool,
  windowsSystemTool,
} from '../src/os/windows-executable.js';
import { resolveGitExecutable } from '../src/os/git-executable.js';
import { buildProgramInvocation, runLiveSecret } from '../src/services/live-secret-runner.js';
import { prepareLiveSecret } from '../src/services/credential-store.js';
import { waitForPidGone } from './knowledge/token-command-helpers.js';

const ROOT = 'C:\\Windows';

describe('absoluteWindowsPathEntries', () => {
  it('keeps drive-rooted and UNC entries, strips quotes, and drops relative and empty ones', () => {
    expect(absoluteWindowsPathEntries('.;bin;..\\x;;"C:\\Program Files\\a"; C:\\b ;\\\\srv\\share;\\rooted;C:relative'))
      .toEqual(['C:\\Program Files\\a', 'C:\\b', '\\\\srv\\share']);
    expect(absoluteWindowsPathEntries(undefined)).toEqual([]);
  });
});

describe('findOnAbsoluteWindowsPath', () => {
  it('walks entries in order, each with the extensions in order', () => {
    const files = new Set(['C:\\b\\tool.cmd', 'C:\\b\\tool.exe', 'C:\\c\\tool.exe']);
    const found = findOnAbsoluteWindowsPath('tool', ['.exe', '.cmd'], { pathValue: 'C:\\a;C:\\b;C:\\c', isFile: (p) => files.has(p) });
    expect(found).toBe('C:\\b\\tool.exe');
  });

  it('never takes a planted file from a relative entry', () => {
    const planted = (p: string) => p.startsWith('.') || p.startsWith('bin');
    expect(findOnAbsoluteWindowsPath('tool', ['.exe'], { pathValue: '.;bin', isFile: planted })).toBeNull();
  });
});

describe('resolveWindowsSystemTool', () => {
  const inRoot = (p: string) => p.startsWith(`${ROOT}\\`);

  it('takes each tool from under SystemRoot, ahead of any PATH entry', () => {
    const deps = { systemRoot: ROOT, pathValue: 'C:\\planted;.', isFile: () => true };
    expect(resolveWindowsSystemTool('cmd', deps)).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(resolveWindowsSystemTool('taskkill', deps)).toBe('C:\\Windows\\System32\\taskkill.exe');
    expect(resolveWindowsSystemTool('powershell', deps)).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('ignores a relative or missing SystemRoot, and falls back to absolute PATH entries only', () => {
    for (const systemRoot of ['.', 'Windows', undefined, '']) {
      const deps = { systemRoot, pathValue: `.;bin;${ROOT}\\System32`, isFile: inRoot };
      expect(resolveWindowsSystemTool('cmd', deps)).toBe('C:\\Windows\\System32\\cmd.exe');
    }
  });

  it('returns null, never a bare name, when nothing qualifies', () => {
    expect(resolveWindowsSystemTool('taskkill', { systemRoot: undefined, pathValue: '.;bin', isFile: () => true })).toBeNull();
  });

  it('is not fooled by ComSpec', () => {
    const saved = process.env.ComSpec;
    process.env.ComSpec = 'C:\\planted\\cmd.exe';
    try {
      const resolved = resolveWindowsSystemTool('cmd', { systemRoot: ROOT, pathValue: '', isFile: () => true });
      expect(resolved).toBe('C:\\Windows\\System32\\cmd.exe');
    } finally {
      if (saved === undefined) delete process.env.ComSpec; else process.env.ComSpec = saved;
    }
  });
});

describe('resolveGitExecutable still follows the shared rules', () => {
  it('skips a relative entry and returns only .exe/.com', () => {
    const files = new Set(['.\\git.exe', 'C:\\a\\git.cmd', 'C:\\b\\git.exe']);
    const found = resolveGitExecutable({
      platform: 'win32', pathValue: '.;C:\\a;C:\\b', pathext: '.CMD;.EXE', isFile: (p) => files.has(p),
    });
    expect(found).toBe('C:\\b\\git.exe');
  });
});

describe('program lookup at registration never uses a relative PATH entry', () => {
  let tmp: string;
  const savedPath = process.env.PATH;
  const savedCwd = process.cwd();

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-path-'));
  });

  afterEach(() => {
    process.chdir(savedCwd);
    process.env.PATH = savedPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('a planted program in the cwd and in a relative PATH entry is not found', () => {
    const name = process.platform === 'win32' ? 'plantedtool.exe' : 'plantedtool';
    fs.mkdirSync(path.join(tmp, 'rel'));
    for (const file of [path.join(tmp, name), path.join(tmp, 'rel', name)]) {
      fs.writeFileSync(file, 'junk', { mode: 0o755 });
    }
    process.chdir(tmp);
    process.env.PATH = ['.', 'rel'].join(path.delimiter);
    expect(() => prepareLiveSecret('plantedlive', { program: 'plantedtool', args: [], env: [] })).toThrow(/could not be resolved/);
  });

  it('a program on an absolute PATH entry is found and stored absolute', () => {
    const name = process.platform === 'win32' ? 'realtool.exe' : 'realtool';
    fs.writeFileSync(path.join(tmp, name), 'junk', { mode: 0o755 });
    process.env.PATH = tmp;
    const rec = prepareLiveSecret('reallive', { program: 'realtool', args: [], env: [] });
    expect(rec.program?.toLowerCase()).toBe(path.join(tmp, name).toLowerCase());
  });
});

describe.skipIf(process.platform !== 'win32')('real spawns on Windows (Windows only: planted system tools)', () => {
  let tmp: string;
  const savedCwd = process.cwd();
  const savedPath = process.env.PATH;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-plant-'));
    // Copies of node.exe: one that ran would exit 0 and print nothing we expect.
    for (const tool of ['cmd.exe', 'taskkill.exe', 'powershell.exe']) {
      fs.copyFileSync(process.execPath, path.join(tmp, tool));
    }
    process.chdir(tmp);
    process.env.PATH = `.;${tmp};${savedPath}`;
  });

  afterEach(() => {
    process.chdir(savedCwd);
    process.env.PATH = savedPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('system tools resolve outside the planted folder, to System32', () => {
    for (const tool of ['cmd', 'taskkill', 'powershell'] as const) {
      const found = windowsSystemTool(tool);
      expect(found).toMatch(/System32/i);
      expect(found?.toLowerCase().startsWith(tmp.toLowerCase())).toBe(false);
    }
  });

  it('a .cmd script runs through the real cmd.exe, with a planted one in the cwd and on PATH', async () => {
    const cmdFile = path.join(tmp, 'mint.cmd');
    fs.writeFileSync(cmdFile, '@echo {"token":"from-real-cmd","expires_at":"2099-01-01T00:00:00Z"}\r\n');
    const result = await runLiveSecret({
      credential: 'planted',
      invocation: buildProgramInvocation(cmdFile, [], 'win32'),
    });
    expect(result.token).toBe('from-real-cmd');
  });

  it('killProcessTree stops a process through the real taskkill, with a planted one in the cwd and on PATH', async () => {
    const pidFile = path.join(tmp, 'sleeper.pid');
    const js = path.join(tmp, 'sleep.js');
    fs.writeFileSync(js, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(function(){},60000);`);
    await expect(runLiveSecret({
      credential: 'planted',
      invocation: buildProgramInvocation(process.execPath, [js], 'win32'),
      timeoutMs: 1500,
    })).rejects.toMatchObject({ reasonCode: 'timeout' });
    // A planted taskkill.exe (a copy of node) would have killed nothing.
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    expect(await waitForPidGone(pid, 3000)).toBe(true);
  });
});
