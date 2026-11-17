import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  quotePosixPath, quotePwshPath, readMemberFileCommand, memberFileExistsPwshCommand,
  memberFileExistsPosixCommand, readMemberFile, writeMemberFile, deleteMemberFile,
  memberFileExists, isGitTracked, ensureGitExcluded, resolveGitExcludePath,
  type MemberExecFn,
} from '../src/services/member-config-io.js';

// Member config paths are resolved in JavaScript, but a resolved path can still
// CONTAIN a shell metacharacter ($, backtick, ' or ") as part of a real
// directory name. Every command builder must quote it so the member's shell
// passes it through verbatim -- never expanding $x, running `cmd`, or ending
// the string early.

const METACHARS = ['$', '`', "'", '"'] as const;

describe('quotePosixPath', () => {
  it('a plain path keeps the historical "<path>" shape', () => {
    expect(quotePosixPath('/home/u/.claude.json')).toBe('"/home/u/.claude.json"');
  });
  it.each([
    ['$', '/w/a$HOME/f', '"/w/a\\$HOME/f"'],
    ['`', '/w/a`id`/f', '"/w/a\\`id\\`/f"'],
    ["'", "/w/o'x/f", '"/w/o\'x/f"'],
    ['"', '/w/a"b/f', '"/w/a\\"b/f"'],
    ['\\', '/w/a\\b/f', '"/w/a\\\\b/f"'],
  ])('escapes %s', (_c, input, expected) => {
    expect(quotePosixPath(input)).toBe(expected);
  });
});

describe('quotePwshPath', () => {
  it('a plain path keeps the historical "<path>" shape', () => {
    expect(quotePwshPath('C:\\Users\\u\\.claude.json')).toBe('"C:\\Users\\u\\.claude.json"');
  });
  it.each([
    ['$', 'C:\\a$env:X\\f', '"C:\\a`$env:X\\f"'],
    ['`', 'C:\\a`b\\f', '"C:\\a``b\\f"'],
    ["'", "C:\\o'x\\f", '"C:\\o\'x\\f"'],
    ['"', 'C:\\a"b\\f', '"C:\\a`"b\\f"'],
    ['U+201C', 'C:\\a\u201Cb\\f', '"C:\\a`\u201Cb\\f"'],
  ])('escapes %s', (_c, input, expected) => {
    expect(quotePwshPath(input)).toBe(expected);
  });
});

describe('command builders carry the quoted path for each metacharacter', () => {
  it.each(METACHARS)('%s: POSIX read / exists', (c) => {
    const p = `/w/x${c}y/f.json`;
    const q = quotePosixPath(p);
    expect(readMemberFileCommand(p, true)).toBe(`if test -e ${q}; then cat ${q}; fi`);
    expect(memberFileExistsPosixCommand(p)).toBe(`test -f ${q}`);
  });
  it.each(METACHARS)('%s: PowerShell read / exists', (c) => {
    const p = `C:/w/x${c}y/f.json`;
    const q = quotePwshPath(`C:\\w\\x${c}y\\f.json`);
    expect(readMemberFileCommand(p, false)).toBe(`if (Test-Path -LiteralPath ${q}) { Get-Content -Raw -LiteralPath ${q} -ErrorAction Stop }`);
    // single-quoted literal form: only ' needs doubling
    const lit = `C:\\w\\x${c === "'" ? "''" : c}y\\f.json`;
    expect(memberFileExistsPwshCommand(p)).toBe(`if (Test-Path -LiteralPath '${lit}' -PathType Leaf) { exit 0 } else { exit 1 }`);
  });
  it.each([[true], [false]])('write/delete/git commands use the quoted path (posix=%s)', async (posix) => {
    const cmds: string[] = [];
    const exec: MemberExecFn = async (cmd) => { cmds.push(cmd); return { stdout: cmd.startsWith('if') ? 'hello' : '', stderr: '', code: 0 }; };
    const p = posix ? '/w/a$b`c/f.txt' : 'C:/w/a$b`c/f.txt';
    await writeMemberFile(exec, p, 'hello', posix);
    await deleteMemberFile(exec, p, posix);
    await isGitTracked(exec, posix ? '/w/a$b`c' : 'C:/w/a$b`c', 'f.txt', !posix, posix);
    await resolveGitExcludePath(exec, posix ? '/w/a$b`c' : 'C:/w/a$b`c', !posix, posix ? undefined : 'powershell');
    for (const cmd of cmds) {
      if (posix) {
        expect(cmd).toContain('a\\$b\\`c');
        expect(cmd).not.toMatch(/a\$b/);
      } else {
        expect(cmd).toContain('a`$b``c');
      }
    }
    if (!posix) expect(cmds.find(c => c.startsWith('Remove-Item'))).toContain('-LiteralPath');
  });
});

// ---------------------------------------------------------------------------
// Real-shell round trips: create a directory whose NAME contains each
// metacharacter plus an injection payload, drive the module's commands through
// a real shell, and confirm the exact path is written/read/probed/deleted and
// the payload never ran.
// ---------------------------------------------------------------------------

function posixExec(shell: string, cwd: string): MemberExecFn {
  return async (c) => {
    const r = spawnSync(shell, ['-c', c], { cwd, encoding: 'utf8', timeout: 30_000 });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
  };
}

// Windows PowerShell 5.1 on win32 (what a Windows member runs), pwsh elsewhere.
const PWSH = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const hasPwsh = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeout: 60_000 }).status === 0;
function pwshExec(cwd: string): MemberExecFn {
  return async (c) => {
    // -EncodedCommand, as the product does for PowerShell members, so the test
    // harness adds no quoting layer of its own.
    const enc = Buffer.from(c, 'utf16le').toString('base64');
    const r = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { cwd, encoding: 'utf8', timeout: 60_000 });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
  };
}

const hasGit = spawnSync('git', ['--version'], { timeout: 30_000 }).status === 0;

/**
 * `full` drives write/delete/git-exclude too. Off win32, the PowerShell
 * builders' Windows backslash paths are not valid for .NET file APIs
 * (WriteAllText) on a POSIX filesystem, so pwsh-on-POSIX covers the
 * Test-Path / Get-Content builders (which PowerShell's provider normalises)
 * and win32 covers the rest with real Windows PowerShell.
 */
function roundTripSuite(name: string, mkExec: (cwd: string) => MemberExecFn, posix: boolean, chars: readonly string[], full: boolean) {
  describe(name, () => {
    it.each(chars)('path containing %s: payload never runs, exact path is used', async (c) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcq-'));
      try {
        const sentinel = path.join(root, 'PWNED');
        // Payloads per shell: an expansion, a command substitution, or a quote
        // that would end the string and run the rest. Commands run with
        // cwd=root, so a payload that ran would create root/PWNED.
        const payload = posix
          ? (c === '$' ? '$(touch PWNED)' : c === '`' ? '`touch PWNED`' : `${c};touch PWNED;${c}`)
          : (c === '$' ? '$(New-Item PWNED)' : c === '`' ? '`$(New-Item PWNED)' : `${c};New-Item PWNED;${c}`);
        const dirName = `d${c}x${payload}`;
        const dir = path.join(root, dirName);
        fs.mkdirSync(dir);
        const file = path.join(dir, 'cfg.json');
        const exec = mkExec(root);

        expect(await memberFileExists(exec, file, posix)).toBe(false);
        expect(await readMemberFile(exec, file, posix)).toBe('');
        if (full) {
          await writeMemberFile(exec, file, '{"a":1}', posix);
          expect(fs.readFileSync(file, 'utf8').trim()).toBe('{"a":1}');
        } else {
          fs.writeFileSync(file, '{"a":1}\n');
        }
        expect((await readMemberFile(exec, file, posix)).trim()).toBe('{"a":1}');
        expect(await memberFileExists(exec, file, posix)).toBe(true);
        expect(await memberFileExists(exec, dir, posix)).toBe(false); // a directory is not a file

        if (full && hasGit) {
          expect(spawnSync('git', ['init', '-q', dir]).status).toBe(0);
          expect(await isGitTracked(exec, dir, 'cfg.json', !posix, posix)).toBe(false);
          await ensureGitExcluded(exec, dir, ['cfg.json'], !posix, posix ? undefined : 'powershell');
          expect(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8')).toContain('/cfg.json');
        }
        if (full) {
          await deleteMemberFile(exec, file, posix);
          expect(fs.existsSync(file)).toBe(false);
        }
        expect(fs.existsSync(sentinel)).toBe(false);
        expect(fs.readdirSync(root)).toEqual([dirName]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }, 120_000);
  });
}

if (process.platform !== 'win32') {
  roundTripSuite('real sh round trip', (cwd) => posixExec('sh', cwd), true, METACHARS, true);
  roundTripSuite('real bash round trip', (cwd) => posixExec('bash', cwd), true, METACHARS, true);
}
// A Windows file name cannot contain ", so PowerShell on win32 covers the rest.
describe.skipIf(!hasPwsh)('PowerShell', () => {
  roundTripSuite(`real ${PWSH} round trip`, pwshExec, false,
    process.platform === 'win32' ? METACHARS.filter(c => c !== '"') : METACHARS,
    process.platform === 'win32');
});
