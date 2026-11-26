import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeClaudeMcpServer } from '../src/cli/uninstall.js';
import { windowsCommand } from '../src/os/windows-command.js';

/**
 * Real (unmocked) child processes, win32 only: the uninstall MCP-removal step
 * must resolve claude to an absolute PATH entry and never run a claude.cmd
 * planted in its start folder. HOME/USERPROFILE point at a temp sandbox; the
 * real ~/.claude.json, ~/.ssh and fleet install are never touched (the shim
 * on PATH is a stub that only writes a marker file).
 */
const onWin = process.platform === 'win32';

describe.skipIf(!onWin)('uninstall claude resolution (win32: cwd is never searched)', () => {
  const saved = { nd: process.env.NoDefaultCurrentDirectoryInExePath, cwd: process.cwd(), path: process.env.PATH, Path: process.env.Path, home: process.env.HOME, up: process.env.USERPROFILE };
  let sandbox = '';

  afterEach(() => {
    process.chdir(saved.cwd);
    const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    restore('PATH', saved.path); restore('Path', saved.Path); restore('HOME', saved.home); restore('USERPROFILE', saved.up); restore('NoDefaultCurrentDirectoryInExePath', saved.nd);
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('runs the PATH claude shim and never the claude.cmd planted in the start folder', () => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'uninstall-planted-'));
    const home = path.join(sandbox, 'home');
    const startDir = path.join(sandbox, 'start');
    const binDir = path.join(sandbox, 'bin');
    for (const d of [home, startDir, binDir]) fs.mkdirSync(d, { recursive: true });
    const evilMarker = path.join(sandbox, 'EVIL-ran.txt');
    const goodMarker = path.join(sandbox, 'good-ran.txt');
    fs.writeFileSync(path.join(startDir, 'claude.cmd'), `@echo off\r\necho planted> "${evilMarker}"\r\n`);
    fs.writeFileSync(path.join(binDir, 'claude.cmd'), `@echo off\r\necho %* > "${goodMarker}"\r\n`);

    process.env.HOME = home;
    process.env.USERPROFILE = home;
    // the host may set the cmd.exe cwd-search backstop; clear it so the vulnerable behavior is reproducible
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    const sysRoot = process.env.SystemRoot ?? 'C:\\Windows';
    process.env.PATH = [binDir, path.join(sysRoot, 'System32')].join(';');
    process.chdir(startDir);

    const plan = windowsCommand('claude');
    expect(plan, 'claude must resolve from the absolute PATH entry').not.toBeNull();
    const resolved = path.resolve(plan!.source);
    expect(path.isAbsolute(plan!.source)).toBe(true);
    expect(resolved.toLowerCase().startsWith(startDir.toLowerCase() + path.sep)).toBe(false);
    expect(resolved.toLowerCase()).toBe(path.join(binDir, 'claude.cmd').toLowerCase());

    removeClaudeMcpServer();

    expect(fs.existsSync(evilMarker), 'planted claude.cmd in the start folder must never run').toBe(false);
    expect(fs.readFileSync(goodMarker, 'utf8')).toContain('mcp remove apra-fleet --scope user');
  });
});
