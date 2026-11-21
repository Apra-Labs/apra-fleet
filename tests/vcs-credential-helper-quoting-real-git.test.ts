// Real git, sandboxed, per shell dialect (POSIX sh, Git Bash, Windows
// PowerShell):
//  - the GIT_CONFIG_PARAMETERS dispatch prefix works when the member home holds
//    an apostrophe or a space (git used to reject the whole variable, "bogus
//    format", or split the helper path on the space);
//  - the legacy global-key cleanup removes ONLY the value fleet wrote and keeps
//    every operator value, on the same key and on other keys;
//  - a legacy push helper is not hidden by a newer member-scoped label on the
//    same scope.
//
// Every git process here runs with HOME, USERPROFILE, XDG_CONFIG_HOME pointed
// at a fresh temp dir, GIT_CONFIG_GLOBAL at a temp file, the system config
// disabled and prompts off, so this PC's real git config and credential stores
// are never read or written. Dialects whose shell is not available are skipped
// (POSIX and Git Bash need bash; PowerShell needs Windows).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { getOsCommands } from '../src/os/index.js';
import { parseLegacyHelperReport } from '../src/os/os-commands.js';
import type { OsCommands } from '../src/os/os-commands.js';
import { vcsGitHelperRegistrations } from '../src/services/vcs-git-env.js';
import { makeTestAgent } from './test-helpers.js';

function findBash(): string | null {
  try {
    if (process.platform === 'win32') {
      const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf-8' }).trim();
      const bash = path.resolve(execPath, '..', '..', '..', 'bin', 'bash.exe');
      return fs.existsSync(bash) ? bash : null;
    }
    execFileSync('git', ['--version']);
    return fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
  } catch {
    return null;
  }
}
const BASH = findBash();
const WIN = process.platform === 'win32';

interface Dialect {
  name: string;
  cmds: OsCommands;
  available: boolean;
  /** Run a command in this dialect's shell; returns stdout/stderr/exit code. */
  run: (cmd: string, env: NodeJS.ProcessEnv) => { stdout: string; stderr: string; code: number };
  helperExt: string;
}

function runBash(cmd: string, env: NodeJS.ProcessEnv) {
  const r = spawnSync(BASH!, ['-c', cmd], { env, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
}
function runPowerShell(cmd: string, env: NodeJS.ProcessEnv) {
  // Under console code page 65001 (GitHub windows runners) PowerShell 5.1
  // prefixes a UTF-8 BOM to text piped into a native command, and git
  // credential fill then sees no protocol field. Pipe without a BOM.
  const noBom = 'try { [Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }; ';
  const encoded = Buffer.from(`$ErrorActionPreference = 'Continue'; ${noBom}${cmd}`, 'utf16le').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { env, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
}

const DIALECTS: Dialect[] = [
  { name: 'posix', cmds: getOsCommands('linux'), available: BASH !== null, run: runBash, helperExt: '' },
  { name: 'gitbash', cmds: getOsCommands('windows', 'gitbash'), available: WIN && BASH !== null, run: runBash, helperExt: '.bat' },
  { name: 'powershell', cmds: getOsCommands('windows', 'powershell5'), available: WIN, run: runPowerShell, helperExt: '.bat' },
];

const HOMES = [
  { what: 'an apostrophe', dir: "o'brien" },
  { what: 'a space', dir: 'John Smith' },
  { what: 'an apostrophe, a space and regex characters', dir: "o'brien (x+1) [y]" },
];

let sandbox = '';
let gitconfig = '';
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-helper-quoting-'));
  gitconfig = path.join(sandbox, 'gitconfig');
  fs.writeFileSync(gitconfig, '');
});
afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** A sandboxed environment whose home is `<sandbox>/<dir>` (forward slashes on Windows). */
function envFor(dir: string): { env: NodeJS.ProcessEnv; home: string } {
  const home = path.join(sandbox, dir);
  fs.mkdirSync(home, { recursive: true });
  const homeFwd = WIN ? home.replace(/\\/g, '/') : home;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeFwd, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
  };
  delete env.GIT_CONFIG_PARAMETERS;
  delete env.GIT_CONFIG_COUNT;
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  return { env, home };
}

function fillCmd(d: Dialect): string {
  return d.name === 'powershell'
    ? `'protocol=https', 'host=github.com', '' | git credential fill`
    : `printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill`;
}

function password(out: string): string | null {
  const m = /^password=(.*)$/m.exec(out);
  return m ? m[1].trim() : null;
}

function gitGlobal(env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync('git', ['config', '--global', ...args], { env, encoding: 'utf-8' });
}
function globalValues(env: NodeJS.ProcessEnv, key: string): string[] {
  const r = spawnSync('git', ['config', '--global', '--get-all', key], { env, encoding: 'utf-8' });
  if (r.status !== 0) return [];
  return r.stdout.replace(/\r/g, '').split('\n').slice(0, -1);
}

/** The value a legacy (0.4.5) release stored for label `github` in this dialect. */
function legacyValue(d: Dialect, env: NodeJS.ProcessEnv, home: string): string {
  if (d.name === 'powershell') return `${home.replace(/\\/g, '/')}/.fleet-git-credential-github.bat`;
  const h = d.name === 'gitbash'
    ? runBash('cygpath -m "$HOME"', env).stdout.trim()
    : runBash(`printf '%s' "$HOME"`, env).stdout;
  return `${h}/.fleet-git-credential-github${d.helperExt}`;
}

for (const d of DIALECTS) {
  describe.skipIf(!d.available)(`[${d.name}] dispatch prefix with an awkward home path`, () => {
    for (const h of HOMES) {
      it(`git authenticates through the member helper when the home holds ${h.what}`, () => {
        const { env } = envFor(h.dir);
        const write = d.run(d.cmds.gitCredentialHelperWrite('github.com', 'x-access-token', 'TOKEN-OWN', 'github', 'https://github.com', 'm1'), env);
        expect(write.code, write.stderr).toBe(0);
        const prefix = d.cmds.gitCredentialEnvPrefix([{ scopeUrl: 'https://github.com', label: 'github' }], 'm1');

        const cfg = d.run(`${prefix}git config --get-all credential.https://github.com.helper`, env);
        expect(cfg.stderr).not.toMatch(/bogus format|unable to parse/);
        expect(cfg.code).toBe(0);

        const fill = d.run(`${prefix}${fillCmd(d)}`, env);
        expect(password(fill.stdout), `stdout=${fill.stdout} stderr=${fill.stderr}`).toBe('TOKEN-OWN');
      });
    }
  });

  describe.skipIf(!d.available)(`[${d.name}] legacy global helper cleanup removes only fleet's own value`, () => {
    it('an operator value on the SAME key survives; the empty reset stays while it is there', () => {
      const { env, home } = envFor("o'brien smith");
      const key = 'credential.https://github.com.helper';
      const fleet = legacyValue(d, env, home);
      gitGlobal(env, '--add', key, '');
      gitGlobal(env, '--add', key, fleet);
      gitGlobal(env, '--add', key, '!gh auth git-credential');
      gitGlobal(env, '--add', 'credential.https://dev.azure.com.helper', '!operator-helper');

      const r = d.run(d.cmds.gitCredentialHelperRemoveLegacyGlobal('github.com', 'github', 'https://github.com'), env);
      expect(r.code, r.stderr).toBe(0);
      expect(parseLegacyHelperReport(r.stdout)).toEqual({ removed: 1, kept: 1, resetRemoved: false, failed: false });
      expect(globalValues(env, key)).toEqual(['', '!gh auth git-credential']);
      expect(globalValues(env, 'credential.https://dev.azure.com.helper')).toEqual(['!operator-helper']);
    });

    it('with no other value left, the empty reset entry goes too (the key is gone)', () => {
      const { env, home } = envFor('plain');
      const key = 'credential.https://github.com.helper';
      gitGlobal(env, '--add', key, '');
      gitGlobal(env, '--add', key, legacyValue(d, env, home));
      gitGlobal(env, '--add', 'credential.https://dev.azure.com.helper', '!operator-helper');

      const r = d.run(d.cmds.gitCredentialHelperRemoveLegacyGlobal('github.com', 'github', 'https://github.com'), env);
      expect(r.code, r.stderr).toBe(0);
      expect(parseLegacyHelperReport(r.stdout)).toEqual({ removed: 1, kept: 0, resetRemoved: true, failed: false });
      expect(globalValues(env, key)).toEqual([]);
      expect(globalValues(env, 'credential.https://dev.azure.com.helper')).toEqual(['!operator-helper']);
    });

    it('a key holding no fleet value is left exactly as it was', () => {
      const { env, home } = envFor('nofleet');
      const key = 'credential.https://github.com.helper';
      gitGlobal(env, '--add', key, '');
      gitGlobal(env, '--add', key, '!gh auth git-credential');
      // Another label's legacy file is not this label's value.
      gitGlobal(env, '--add', key, legacyValue(d, env, home).replace('-github', '-github-issues'));

      const r = d.run(d.cmds.gitCredentialHelperRemoveLegacyGlobal('github.com', 'github', 'https://github.com'), env);
      expect(r.code, r.stderr).toBe(0);
      expect(parseLegacyHelperReport(r.stdout)).toMatchObject({ removed: 0, failed: false });
      expect(globalValues(env, key)).toHaveLength(3);
    });
  });
}

describe.skipIf(BASH === null)('[posix] mixed legacy + member-scoped labels on one scope', () => {
  it('a legacy push helper is used first, not hidden by a newer member-scoped label', () => {
    const { env } = envFor('mixed');
    const cmds = getOsCommands('linux');
    const agent = makeTestAgent({
      id: 'm1', os: 'linux',
      vcsCredentials: {
        github: { provider: 'github', scopeUrl: 'https://github.com' },
        'github-issues': { provider: 'github', scopeUrl: 'https://github.com', memberScoped: true },
      },
    } as any);
    // The legacy file an older release wrote, and the new per-member one.
    runBash(cmds.gitCredentialHelperWrite('github.com', 'x-access-token', 'TOKEN-LEGACY-PUSH', 'github'), env);
    runBash(cmds.gitCredentialHelperWrite('github.com', 'x-access-token', 'TOKEN-ISSUES', 'github-issues', 'https://github.com', 'm1'), env);

    const regs = vcsGitHelperRegistrations(agent);
    expect(regs).toEqual([
      { scopeUrl: 'https://github.com', label: 'github', legacy: true },
      { scopeUrl: 'https://github.com', label: 'github-issues' },
    ]);
    const prefix = cmds.gitCredentialEnvPrefix(regs, 'm1');
    const fill = runBash(`${prefix}${fillCmd(DIALECTS[0])}`, env);
    expect(password(fill.stdout), fill.stderr).toBe('TOKEN-LEGACY-PUSH');
  });

  it('a legacy entry on a scope with no member-scoped entry is not registered (the global key serves it)', () => {
    const agent = makeTestAgent({
      id: 'm2', os: 'linux',
      vcsCredentials: {
        github: { provider: 'github', scopeUrl: 'https://github.com' },
        'az': { provider: 'azure-devops', scopeUrl: 'https://dev.azure.com', memberScoped: true },
      },
    } as any);
    expect(vcsGitHelperRegistrations(agent)).toEqual([{ scopeUrl: 'https://dev.azure.com', label: 'az' }]);
  });
});
