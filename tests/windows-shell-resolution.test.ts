// A powershell.exe or bash.exe planted in a local Windows member's work folder
// is never executed by the shell LocalStrategy.execCommand starts. Two layers:
//   1. Platform-independent unit cases of the shared resolver
//      (resolveWindowsExecutable / windowsExecutable) with injected
//      platform / PATH / PATHEXT / SystemRoot / ComSpec / isFile.
//   2. Real Windows-only cases: a work folder holding a planted powershell.exe
//      (and, separately, bash.exe) -- a link or copy of node.exe that a
//      NODE_OPTIONS --require preload turns into a marker writer -- is the cwd
//      of a real LocalStrategy.execCommand; the marker must never appear and
//      the output must come from the real shell.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Force resolveGitBashPath onto its PATH fallback: no well-known candidate.
vi.mock('../src/os/git-bash-candidates.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/os/git-bash-candidates.js')>();
  return { ...actual, gitBashCandidates: () => [] };
});

import {
  resolveWindowsExecutable,
  windowsExecutable,
  resetWindowsExecutableCache,
  WindowsExecutableNotFoundError,
  WINDOWS_EXECUTABLE_NOT_FOUND_CODE,
  type WindowsExecutableDeps,
} from '../src/os/windows-executable.js';
import { resolveGitBashPath } from '../src/os/windows-gitbash.js';
import { WindowsCommands } from '../src/os/windows.js';
import { getStrategy } from '../src/services/strategy.js';
import { makeTestLocalAgent } from './test-helpers.js';

const ROOT = 'C:\\Windows';
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const CMD = 'C:\\Windows\\System32\\cmd.exe';

function winDeps(over: Partial<WindowsExecutableDeps> & { files: string[] }): WindowsExecutableDeps {
  const files = new Set(over.files.map((f) => f.toLowerCase()));
  return {
    platform: 'win32',
    pathValue: over.pathValue,
    pathext: over.pathext ?? '.COM;.EXE;.BAT;.CMD',
    systemRoot: 'systemRoot' in over ? over.systemRoot : ROOT,
    comSpec: over.comSpec,
    isFile: (p) => files.has(p.toLowerCase()),
  };
}

function thrown(fn: () => unknown): unknown {
  try { fn(); } catch (e) { return e; }
  return undefined;
}

describe('resolveWindowsExecutable (injected deps, every OS)', () => {
  it('returns the name unchanged on POSIX platforms, without touching the filesystem', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const deps: WindowsExecutableDeps = {
        platform, pathValue: '/usr/bin', pathext: undefined, systemRoot: ROOT,
        isFile: () => { throw new Error('must not probe on POSIX'); },
      };
      expect(resolveWindowsExecutable('powershell.exe', deps)).toBe('powershell.exe');
      expect(resolveWindowsExecutable('bash.exe', deps)).toBe('bash.exe');
    }
  });

  it('prefers %SystemRoot%\\System32\\WindowsPowerShell\\v1.0 for powershell.exe over PATH and the cwd', () => {
    const deps = winDeps({
      pathValue: 'C:\\tools',
      files: ['C:\\work\\repo\\powershell.exe', 'C:\\tools\\powershell.exe', PS],
    });
    expect(resolveWindowsExecutable('powershell.exe', deps)).toBe(PS);
    expect(resolveWindowsExecutable('powershell', deps)).toBe(PS);
  });

  it('prefers an absolute cmd.exe ComSpec, then %SystemRoot%\\System32\\cmd.exe, over PATH', () => {
    const comSpec = 'D:\\Win\\System32\\cmd.exe';
    expect(resolveWindowsExecutable('cmd.exe', winDeps({
      pathValue: 'C:\\tools', comSpec, files: [comSpec, CMD, 'C:\\tools\\cmd.exe'],
    }))).toBe(comSpec);
    // A relative or non-cmd ComSpec is ignored.
    for (const bad of ['cmd.exe', '.\\cmd.exe', 'C:\\tcc\\tcc.exe']) {
      expect(resolveWindowsExecutable('cmd.exe', winDeps({
        pathValue: 'C:\\tools', comSpec: bad, files: [bad, CMD, 'C:\\tools\\cmd.exe'],
      }))).toBe(CMD);
    }
  });

  it('ignores a relative or unset SystemRoot and falls back to absolute PATH entries only', () => {
    for (const systemRoot of [undefined, 'Windows', '.\\Windows']) {
      const deps = winDeps({
        systemRoot,
        pathValue: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
        files: ['Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', PS],
      });
      expect(resolveWindowsExecutable('powershell.exe', deps)).toBe(PS);
    }
  });

  it('a missing SystemRoot candidate falls through to PATH', () => {
    expect(resolveWindowsExecutable('powershell.exe', winDeps({
      pathValue: 'D:\\ps', files: ['D:\\ps\\powershell.exe'],
    }))).toBe('D:\\ps\\powershell.exe');
  });

  it('empty and relative PATH entries are skipped; quoted entries are unquoted', () => {
    const deps = winDeps({
      systemRoot: undefined,
      pathValue: ';.;bin;.\\tools;\\rooted-no-drive;"";  ;"D:\\Git Bash\\bin"',
      files: ['bash.exe', '.\\bash.exe', 'bin\\bash.exe', '.\\tools\\bash.exe', '\\rooted-no-drive\\bash.exe', 'D:\\Git Bash\\bin\\bash.exe'],
    });
    expect(resolveWindowsExecutable('bash.exe', deps)).toBe('D:\\Git Bash\\bin\\bash.exe');
  });

  it('only .EXE / .COM are returned, in PATHEXT order', () => {
    const dir = 'C:\\tools';
    expect(resolveWindowsExecutable('bash.exe', winDeps({
      pathValue: dir, pathext: '.COM;.EXE', files: [`${dir}\\bash.com`, `${dir}\\bash.exe`],
    }))).toBe(`${dir}\\bash.com`);
    expect(resolveWindowsExecutable('bash', winDeps({
      pathValue: dir, pathext: '.EXE;.COM', files: [`${dir}\\bash.com`, `${dir}\\bash.exe`],
    }))).toBe(`${dir}\\bash.exe`);
    expect(thrown(() => resolveWindowsExecutable('bash.exe', winDeps({
      pathValue: dir, pathext: '.CMD;.BAT;.EXE', files: [`${dir}\\bash.cmd`, `${dir}\\bash.bat`],
    })))).toBeInstanceOf(WindowsExecutableNotFoundError);
  });

  it('a missing shell throws one clear error code naming everything searched', () => {
    const err = thrown(() => resolveWindowsExecutable('powershell.exe', winDeps({
      pathValue: '.;C:\\a;D:\\b', files: ['C:\\work\\repo\\powershell.exe', '.\\powershell.exe'],
    })));
    expect(err).toBeInstanceOf(WindowsExecutableNotFoundError);
    const e = err as WindowsExecutableNotFoundError;
    expect(e.code).toBe(WINDOWS_EXECUTABLE_NOT_FOUND_CODE);
    expect(e.searched).toEqual(['C:\\a', 'D:\\b']);
    expect(e.preferredTried).toEqual([PS]);
    expect(e.message).toContain(WINDOWS_EXECUTABLE_NOT_FOUND_CODE);
    expect(e.message).toContain('powershell.exe');
    expect(e.message).toContain(PS);
    expect(e.message).toContain('C:\\a');
    expect(e.message).toContain('D:\\b');
    expect(e.message).toMatch(/current directory is never searched/);
  });
});

describe('windowsExecutable cache (injected deps, every OS)', () => {
  afterEach(() => resetWindowsExecutableCache());

  it('caches a success per program', () => {
    resetWindowsExecutableCache();
    const found = winDeps({ pathValue: 'C:\\tools', files: [PS] });
    expect(windowsExecutable('powershell.exe', found)).toBe(PS);
    // A later lookup that would now fail still answers from the cache.
    expect(windowsExecutable('powershell.exe', winDeps({ pathValue: '', files: [] }))).toBe(PS);
    // ... keyed per program: cmd.exe is resolved on its own.
    expect(thrown(() => windowsExecutable('cmd.exe', winDeps({ pathValue: '', files: [] }))))
      .toBeInstanceOf(WindowsExecutableNotFoundError);
  });

  it('does not cache a failure: installing the shell later starts working', () => {
    resetWindowsExecutableCache();
    expect(thrown(() => windowsExecutable('powershell.exe', winDeps({ pathValue: '', files: [] }))))
      .toBeInstanceOf(WindowsExecutableNotFoundError);
    expect(windowsExecutable('powershell.exe', winDeps({ pathValue: '', files: [PS] }))).toBe(PS);
  });
});

// ---------------------------------------------------------------------------
// Real Windows cases.
// ---------------------------------------------------------------------------
const isWindows = process.platform === 'win32';
let pathGitBash: string | undefined;
if (isWindows) {
  // Candidates are mocked away above, so this is the PATH fallback.
  try { pathGitBash = resolveGitBashPath(); } catch { pathGitBash = undefined; }
}
const TMP_PREFIX = 'fleet-shell-plant-';
const winSkip = isWindows ? '' : 'Windows-only: CreateProcess searches the spawn cwd before PATH only on win32';
const bashSkip = winSkip || (pathGitBash ? '' : 'no MSYS/Git bash.exe is the first bash.exe on PATH on this Windows host');

function tmpEntries(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(TMP_PREFIX)).sort();
}

describe.skipIf(!isWindows)(`planted shells in the work folder never run (real Windows)${winSkip ? ` -- skipped: ${winSkip}` : ''}`, () => {
  let tmp: string;
  let before: string[];
  // NoDefaultCurrentDirectoryInExePath (any value) turns off the cwd search in
  // libuv / CreateProcess, which would hide the attack and make these cases
  // pass even with a bare shell name. libuv reads it from the PARENT env, so
  // remove it from process.env for the run and restore it afterwards.
  const NO_CWD_VAR = 'NoDefaultCurrentDirectoryInExePath';
  let savedNoCwd: string | undefined;

  beforeAll(() => {
    savedNoCwd = process.env[NO_CWD_VAR];
    delete process.env[NO_CWD_VAR];
    before = tmpEntries();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  });

  afterAll(() => {
    if (savedNoCwd !== undefined) process.env[NO_CWD_VAR] = savedNoCwd;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    expect(tmpEntries()).toEqual(before);
  });

  /**
   * A work folder with a planted <exe> = node.exe (link or copy). Whatever
   * argv it gets (-c <command>), the NODE_OPTIONS --require preload returned
   * here runs first and writes this case's own marker. The real shells
   * ignore NODE_OPTIONS.
   */
  function plant(name: string, exe: string): { work: string; marker: string; nodeOptions: string } {
    const work = path.join(tmp, name);
    fs.mkdirSync(work);
    const planted = path.join(work, exe);
    try { fs.linkSync(process.execPath, planted); } catch { fs.copyFileSync(process.execPath, planted); }
    const marker = path.join(tmp, `${name}-PLANTED-RAN.txt`);
    const preload = path.join(tmp, `${name}-preload.js`);
    fs.writeFileSync(preload,
      `require('fs').appendFileSync(${JSON.stringify(marker)}, process.argv.join(' ') + '\\n');\n` +
      "process.stdout.write('PLANTED-OUTPUT\\n');\nprocess.exit(0);\n");
    // NODE_OPTIONS treats backslash as an escape inside double quotes, so the
    // preload path goes in with forward slashes (node accepts them on Windows).
    return { work, marker, nodeOptions: `--require "${preload.replace(/\\/g, '/')}"` };
  }

  function markerText(marker: string): string {
    return fs.existsSync(marker) ? fs.readFileSync(marker, 'utf-8') : '';
  }

  it('PowerShell member: the planted powershell.exe never runs and the output comes from the real PowerShell', async () => {
    const { work, marker, nodeOptions } = plant('ps-work', 'powershell.exe');
    const realGetCleanEnv = (WindowsCommands.prototype as any).getCleanEnv;
    const spy = vi.spyOn(WindowsCommands.prototype as any, 'getCleanEnv').mockImplementation(function (this: unknown) {
      return { ...realGetCleanEnv.call(this), NODE_OPTIONS: nodeOptions };
    });
    try {
      const strategy = getStrategy(makeTestLocalAgent({ workFolder: work }));
      const result = await strategy.execCommand("Write-Output ('real-' + 'powershell:' + $PSVersionTable.PSEdition)", 30000);
      expect(markerText(marker), markerText(marker)).toBe('');
      expect(fs.existsSync(marker)).toBe(false);
      expect(result.stdout).toMatch(/real-powershell:(Desktop|Core)/);
      expect(result.stdout).not.toContain('PLANTED-OUTPUT');
      expect(result.code).toBe(0);
    } finally {
      spy.mockRestore();
    }
  }, 60000);

  it.skipIf(!!bashSkip)(`Git Bash member on the PATH fallback: the planted bash.exe never runs and the output comes from the real bash${bashSkip ? ` -- skipped: ${bashSkip}` : ''}`, async () => {
    const { work, marker, nodeOptions } = plant('bash-work', 'bash.exe');
    // WindowsGitBashCommands.cleanExec passes the (filtered) process.env on.
    const savedNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = nodeOptions;
    try {
      const strategy = getStrategy(makeTestLocalAgent({ workFolder: work, shell: 'gitbash' }));
      const result = await strategy.execCommand('echo "real-bash:$(uname -s)"', 30000);
      expect(markerText(marker), markerText(marker)).toBe('');
      expect(fs.existsSync(marker)).toBe(false);
      expect(result.stdout).toMatch(/real-bash:(MINGW|MSYS|CYGWIN)/);
      expect(result.stdout).not.toContain('PLANTED-OUTPUT');
      expect(result.code).toBe(0);
    } finally {
      if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = savedNodeOptions;
    }
  }, 60000);
});
