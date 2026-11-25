/**
 * claude (register-member interactive bootstrap), npx (code-intelligence
 * reindex) and agy (member-side new-project script) are started on Windows
 * from an absolute path that never comes from the spawn cwd or a relative
 * PATH entry -- a planted claude.cmd / npx.cmd / agy.exe in the work folder
 * never runs. Resolution runs through injected deps (platform win32, PATH,
 * isFile, readFile) so it is exercised on every OS; on a Windows host one
 * case also spawns for real against a planted claude.cmd that writes a marker.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  resolveWindowsCommand,
  WindowsCommandNotFoundError,
  WINDOWS_COMMAND_NOT_FOUND_CODE,
  type WindowsCommandDeps,
} from '../src/os/windows-command.js';
import { launchInteractiveClaude } from '../src/tools/register-member.js';
import { MEMBER_RESOLVE_CMD_JS, buildAgyNewProjectScript, AGY_NODE_SELF } from '../src/services/agy-project.js';

// Never touch the real home: HOME and USERPROFILE point at a temp sandbox.
let sandboxHome = '';
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
beforeAll(() => {
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ga85-shims-home-'));
  process.env.HOME = sandboxHome;
  process.env.USERPROFILE = sandboxHome;
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedHome)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(sandboxHome, { recursive: true, force: true });
});

const WORK = 'C:\\work\\repo';
const SYS = 'C:\\Windows';
const CMD_EXE = 'C:\\Windows\\System32\\cmd.exe';

/** A fake Windows filesystem: path (case-insensitive) -> file content. */
function deps(pathValue: string, files: Record<string, string>, platform: NodeJS.Platform = 'win32'): WindowsCommandDeps {
  const lower = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    platform,
    pathValue,
    pathext: '.COM;.EXE;.BAT;.CMD',
    systemRoot: SYS,
    isFile: (p) => lower.has(p.toLowerCase()),
    readFile: (p) => {
      const v = lower.get(p.toLowerCase());
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
  };
}

const NPM_CMD_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', ')',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
].join('\r\n');

// Planted files in the work folder (cwd) and in a relative PATH entry.
const PLANTED = {
  [`${WORK}\\claude.cmd`]: '@echo planted',
  [`${WORK}\\npx.cmd`]: '@echo planted',
  [`${WORK}\\claude.exe`]: 'MZ',
  [`${WORK}\\npx.exe`]: 'MZ',
  [`${WORK}\\cmd.exe`]: 'MZ',
  [`${WORK}\\node.exe`]: 'MZ',
  ['rel\\bin\\claude.cmd']: '@echo planted',
  ['.\\claude.cmd']: '@echo planted',
  [CMD_EXE]: 'MZ',
};
const HOSTILE_PATH = `.;rel\\bin;;\\rooted-no-drive;C:relative`;

describe('resolveWindowsCommand (win32 via injected deps)', () => {
  it('a real claude.exe on an absolute PATH entry wins over planted files in the cwd and relative entries', () => {
    const plan = resolveWindowsCommand('claude', deps(`${HOSTILE_PATH};C:\\real\\bin`, { ...PLANTED, 'C:\\real\\bin\\claude.exe': 'MZ' }));
    expect(plan).toMatchObject({ kind: 'exe', file: 'C:\\real\\bin\\claude.exe', args: [], shell: false });
    expect(plan!.env.NoDefaultCurrentDirectoryInExePath).toBe('1');
  });

  it('an npm cmd-shim runs node on the wrapped script (node beside the shim), shell:false', () => {
    const plan = resolveWindowsCommand('claude', deps(`${HOSTILE_PATH};C:\\npm`, {
      ...PLANTED,
      'C:\\npm\\claude.cmd': NPM_CMD_SHIM,
      'C:\\npm\\node.exe': 'MZ',
      'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js': '',
    }));
    expect(plan).toMatchObject({
      kind: 'node-script',
      file: 'C:\\npm\\node.exe',
      args: ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'],
      shell: false,
      source: 'C:\\npm\\claude.cmd',
    });
  });

  it('an npm cmd-shim without a node.exe beside it uses node.exe from an absolute PATH entry, never the cwd', () => {
    const plan = resolveWindowsCommand('claude', deps(`${HOSTILE_PATH};C:\\npm;C:\\nodejs`, {
      ...PLANTED,
      'C:\\npm\\claude.cmd': NPM_CMD_SHIM,
      'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js': '',
      'C:\\nodejs\\node.exe': 'MZ',
    }));
    expect(plan).toMatchObject({ kind: 'node-script', file: 'C:\\nodejs\\node.exe' });
  });

  it('a non-npm .cmd (npm\'s own npx.cmd) runs by absolute path under the absolute cmd.exe', () => {
    const plan = resolveWindowsCommand('npx', deps(`${HOSTILE_PATH};C:\\Program Files\\nodejs`, {
      ...PLANTED,
      'C:\\Program Files\\nodejs\\npx.cmd': '@ECHO OFF\r\n"%NODE_EXE%" "%NPX_CLI_JS%" %*',
      'C:\\Program Files\\nodejs\\npx': '#!/bin/sh',
    }));
    expect(plan).toMatchObject({
      kind: 'cmd-shim',
      file: '"C:\\Program Files\\nodejs\\npx.cmd"',
      args: [],
      shell: CMD_EXE,
    });
    expect(plan!.env.NoDefaultCurrentDirectoryInExePath).toBe('1');
  });

  it('PATH order is dir-major: an earlier entry\'s .cmd beats a later entry\'s .exe', () => {
    const plan = resolveWindowsCommand('claude', deps('C:\\first;C:\\second', {
      'C:\\first\\claude.cmd': '@echo x', 'C:\\second\\claude.exe': 'MZ', [CMD_EXE]: 'MZ',
    }));
    expect(plan).toMatchObject({ kind: 'cmd-shim', file: '"C:\\first\\claude.cmd"' });
  });

  it('only planted copies (cwd / relative entries) -> typed error naming the searched absolute entries', () => {
    let err: unknown;
    try {
      resolveWindowsCommand('agy', deps(`${HOSTILE_PATH};C:\\empty`, { ...PLANTED, [`${WORK}\\agy.exe`]: 'MZ' }));
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(WindowsCommandNotFoundError);
    const e = err as WindowsCommandNotFoundError;
    expect(e.code).toBe(WINDOWS_COMMAND_NOT_FOUND_CODE);
    expect(e.searched).toEqual(['C:\\empty']);
    expect(e.message).toContain('C:\\empty');
    expect(e.message).toContain('agy.cmd');
  });

  it('non-win32 -> null (callers keep their original argv)', () => {
    expect(resolveWindowsCommand('claude', deps('/usr/bin', {}, 'linux'))).toBeNull();
  });
});

describe('register-member: launchInteractiveClaude', () => {
  it('win32: spawns the absolute plan with the work folder as cwd, never the bare name', () => {
    const spy = vi.fn(() => ({ unref() {}, pid: 1 }) as never);
    const plan = resolveWindowsCommand('claude', deps(`${HOSTILE_PATH};C:\\real\\bin`, { ...PLANTED, 'C:\\real\\bin\\claude.exe': 'MZ' }));
    launchInteractiveClaude(WORK, spy as never, () => plan);
    expect(spy).toHaveBeenCalledTimes(1);
    const [file, args, opts] = spy.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(file).toBe('C:\\real\\bin\\claude.exe');
    expect(args).toEqual(['--dangerously-load-development-channels']);
    expect(opts).toMatchObject({ cwd: WORK, detached: true, stdio: 'ignore', shell: false });
    expect((opts.env as Record<string, string>).NoDefaultCurrentDirectoryInExePath).toBe('1');
  });

  it('win32: a missing claude throws the typed error (caller turns it into a warning)', () => {
    const spy = vi.fn();
    expect(() => launchInteractiveClaude(WORK, spy as never, (n) => resolveWindowsCommand(n, deps(HOSTILE_PATH, PLANTED))))
      .toThrow(WINDOWS_COMMAND_NOT_FOUND_CODE);
    expect(spy).not.toHaveBeenCalled();
  });

  it('linux/macOS: argv and options unchanged (bare claude, shell:true)', () => {
    const spy = vi.fn(() => ({ unref() {}, pid: 1 }) as never);
    launchInteractiveClaude('/home/u/repo', spy as never, () => null);
    expect(spy).toHaveBeenCalledWith('claude', ['--dangerously-load-development-channels'],
      { cwd: '/home/u/repo', detached: true, stdio: 'ignore', shell: true });
  });
});

describe('agy: member-side resolveCmd', () => {
  type Fake = { platform: string };
  function memberResolver(platform: string, pathValue: string, files: string[]): (name: string) => string {
    const set = new Set(files.map((f) => f.toLowerCase()));
    const fakeFs = { statSync: (p: string) => { if (!set.has(p.toLowerCase())) throw new Error('ENOENT'); return { isFile: () => true }; } };
    const env = { PATHEXT: '.COM;.EXE;.BAT;.CMD', Path: pathValue };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const make = new Function('process', 'env', 'pathKey', 'fs', 'path', `${MEMBER_RESOLVE_CMD_JS}\nreturn resolveCmd;`);
    return make({ platform } as Fake, env, 'Path', fakeFs, path) as (name: string) => string;
  }

  it('win32: picks agy.exe from an absolute PATH entry, never the planted one in the work folder', () => {
    const resolve = memberResolver('win32', `${HOSTILE_PATH};C:\\Users\\u\\AppData\\Local\\agy\\bin`,
      [`${WORK}\\agy.exe`, '.\\agy.exe', 'rel\\bin\\agy.exe', 'C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe']);
    expect(resolve('agy')).toBe('C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe');
  });

  it('win32: only planted copies -> throws naming the searched absolute entries', () => {
    const resolve = memberResolver('win32', `${HOSTILE_PATH};C:\\empty`, ['.\\agy.exe', 'rel\\bin\\agy.exe']);
    expect(() => resolve('agy')).toThrow(/E-WINDOWS-COMMAND-NOT-FOUND: agy was not found\. Searched 1 absolute PATH entries \(C:\\empty\)/);
  });

  it('non-win32 and absolute names pass through unchanged', () => {
    expect(memberResolver('linux', '/usr/bin', [])('agy')).toBe('agy');
    expect(memberResolver('win32', '', [])('C:\\x\\agy.exe')).toBe('C:\\x\\agy.exe');
  });

  it('the new-project script spawns resolveCmd("agy") (stand-in node is left alone)', () => {
    const real = buildAgyNewProjectScript({ workFolder: WORK, model: 'm' });
    expect(real).toContain('cp.spawnSync(resolveCmd("agy"), args');
    expect(real).toContain("env.NoDefaultCurrentDirectoryInExePath = '1'");
    const standIn = buildAgyNewProjectScript({ workFolder: WORK, model: 'm', agyCommand: { file: AGY_NODE_SELF, args: [] } });
    expect(standIn).toContain('cp.spawnSync(process.execPath, args');
  });
});

describe.runIf(process.platform === 'win32')('real spawn on this Windows host', () => {
  it('a planted claude.cmd in the work folder never runs; the absolute PATH shim does', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ga85-shims-'));
    const work = path.join(root, 'work');
    const realBin = path.join(root, 'real bin');
    fs.mkdirSync(work);
    fs.mkdirSync(realBin);
    const plantedMarker = path.join(root, 'planted.txt');
    const realMarker = path.join(root, 'real.txt');
    fs.writeFileSync(path.join(work, 'claude.cmd'), `@echo planted> "${plantedMarker}"\r\n`);
    fs.writeFileSync(path.join(realBin, 'claude.cmd'), `@echo real> "${realMarker}"\r\n`);
    // The host may set this; libuv/cmd.exe read it from the PARENT env, and
    // with it set a planted-shim test would pass even against the old code.
    const savedNoCwd = process.env.NoDefaultCurrentDirectoryInExePath;
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    try {
      const env = { ...process.env, PATH: `.;${realBin};${process.env.SystemRoot}\\System32` };
      const plan = resolveWindowsCommand('claude', {
        ...deps(env.PATH, {}),
        systemRoot: process.env.SystemRoot,
        isFile: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
        readFile: (p) => fs.readFileSync(p, 'utf8'),
      });
      const child = launchInteractiveClaude(work, spawn, () => plan);
      await new Promise<void>((resolve) => { child.on('exit', () => resolve()); child.on('error', () => resolve()); });
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(realMarker) && !fs.existsSync(plantedMarker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(fs.existsSync(plantedMarker)).toBe(false);
      expect(fs.existsSync(realMarker)).toBe(true);
    } finally {
      if (savedNoCwd !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = savedNoCwd;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
