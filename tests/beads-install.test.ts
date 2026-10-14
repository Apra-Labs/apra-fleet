/**
 * Beads (bd) install for a plain user whose global npm prefix is root-owned,
 * and the fleet-side "bd missing" record for a remote member. Fake transports
 * only: no npm, no bd, no member.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { installBeads, BEADS_NPM_PACKAGE, describeExecFailure, type BeadsInstallDeps } from '../src/cli/beads-install.js';
import {
  probeMemberFleetMcp,
  buildBeadsProbe,
  beadsStatusNote,
  BEADS_MISSING_FIX,
  NO_INSTALL_SENTINEL,
  type MemberFleetMcpDeps,
} from '../src/services/member-fleet-install.js';
import { getOsCommands } from '../src/os/index.js';
import { makeTestAgent, decodePowerShellEncodedCommand } from './test-helpers.js';
import type { FleetMcpStatus, SSHExecResult } from '../src/types.js';

const BIN = path.join('/home/kbrmember', '.apra-fleet', 'bin');
const BD = path.join(BIN, 'bd');
const NATIVE = path.join('/home/kbrmember', '.apra-fleet', 'staging', 'beads', 'node_modules', '@beads', 'bd', 'bin', 'bd');

interface FakeWorld {
  onPath: boolean;
  /** Outcome of `npm install -g`. */
  globalNpm: 'ok' | 'eacces' | 'no-npm';
  /** Outcome of the user-level `npm install --prefix`. */
  userNpm: 'ok' | 'no-binary' | 'fail' | 'no-npm';
  files: Set<string>;
  calls: string[];
  copies: Array<[string, string]>;
  chmods: string[];
}

function eacces(): Error {
  return Object.assign(new Error('Command failed: npm install -g'), {
    stderr: "npm error code EACCES\nnpm error syscall mkdir\nnpm error path /usr/local/lib/node_modules/@beads\nnpm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/@beads'\n",
  });
}

function fake(over: Partial<FakeWorld> = {}): { world: FakeWorld; deps: BeadsInstallDeps } {
  const world: FakeWorld = { onPath: false, globalNpm: 'eacces', userNpm: 'ok', files: new Set(), calls: [], copies: [], chmods: [], ...over };
  const deps: BeadsInstallDeps = {
    platform: 'linux',
    exec: (cmd, args) => {
      world.calls.push([cmd, ...args].join(' '));
      if (cmd === 'bd') {
        if (world.onPath) return 'bd version 1.3.0 (system)\n';
        throw new Error('bd: command not found');
      }
      if (cmd === BD) {
        if (world.files.has(BD)) return 'bd version 1.3.0 (fleet)\n';
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      }
      if (cmd === 'npm' && args.includes('-g')) {
        if (world.globalNpm === 'no-npm') throw Object.assign(new Error('npm: command not found'), { stderr: 'sh: 1: npm: not found' });
        if (world.globalNpm === 'eacces') throw eacces();
        world.onPath = true;
        return '';
      }
      if (cmd === 'npm' && args.includes('--prefix')) {
        if (world.userNpm === 'no-npm') throw Object.assign(new Error('npm: command not found'), { stderr: 'sh: 1: npm: not found' });
        if (world.userNpm === 'fail') throw Object.assign(new Error('Command failed'), { stderr: 'npm error network ETIMEDOUT' });
        if (world.userNpm === 'ok') world.files.add(NATIVE);
        return '';
      }
      throw new Error(`unexpected exec ${cmd}`);
    },
    existsSync: p => world.files.has(p),
    mkdirSync: () => {},
    rmSync: () => {},
    copyFileSync: (src, dest) => { world.copies.push([src, dest]); world.files.add(dest); },
    chmodSync: p => { world.chmods.push(p); },
  };
  return { world, deps };
}

describe('installBeads', () => {
  it('root-owned global npm prefix (EACCES): installs the pinned bd into the user BIN_DIR, where it resolves', () => {
    const { world, deps } = fake();
    const r = installBeads(BIN, deps);
    expect(r).toEqual({ state: 'installed', version: 'bd version 1.3.0 (fleet)', location: 'bin-dir', binPath: BD });
    const userInstall = world.calls.find(c => c.includes('--prefix'))!;
    expect(userInstall).toContain(BEADS_NPM_PACKAGE);
    expect(userInstall).not.toContain(' -g ');
    expect(world.copies).toEqual([[NATIVE, BD]]);
    expect(world.chmods).toEqual([BD]);
    // Resolvable: the copied binary answers --version.
    expect(world.calls[world.calls.length - 1]).toBe(`${BD} --version`);
  });

  it('a working bd already on PATH is left untouched (no npm call at all)', () => {
    const { world, deps } = fake({ onPath: true });
    expect(installBeads(BIN, deps)).toEqual({ state: 'present', version: 'bd version 1.3.0 (system)', location: 'path' });
    expect(world.calls).toEqual(['bd --version']);
    expect(world.copies).toEqual([]);
  });

  it('a working bd already in BIN_DIR is left untouched', () => {
    const { world, deps } = fake();
    world.files.add(BD);
    expect(installBeads(BIN, deps)).toMatchObject({ state: 'present', location: 'bin-dir', binPath: BD });
    expect(world.calls.some(c => c.startsWith('npm'))).toBe(false);
  });

  it('a writable global prefix keeps the long-standing npm -g install', () => {
    const { world, deps } = fake({ globalNpm: 'ok' });
    expect(installBeads(BIN, deps)).toEqual({ state: 'installed', version: 'bd version 1.3.0 (system)', location: 'npm-global' });
    expect(world.calls).toContain(`npm install -g ${BEADS_NPM_PACKAGE}`);
    expect(world.calls.some(c => c.includes('--prefix'))).toBe(false);
  });

  it('total failure (no npm): missing, naming the reason and the fix', () => {
    const { deps } = fake({ globalNpm: 'no-npm', userNpm: 'no-npm' });
    const r = installBeads(BIN, deps);
    expect(r.state).toBe('missing');
    if (r.state !== 'missing') return;
    expect(r.reason).toContain('npm is not available on PATH');
    expect(r.fix).toContain(BEADS_NPM_PACKAGE);
  });

  it('EACCES plus a failed bd binary download: missing, naming the permission problem and the missing binary', () => {
    const { deps } = fake({ userNpm: 'no-binary' });
    const r = installBeads(BIN, deps);
    expect(r.state).toBe('missing');
    if (r.state !== 'missing') return;
    expect(r.reason).toContain('permission denied');
    expect(r.reason).toContain('/usr/local/lib/node_modules/@beads');
    expect(r.reason).toContain('postinstall download failed');
  });

  it('Windows: the staging prefix is quoted for the shell and bd.exe lands in BIN_DIR without chmod', () => {
    const winBin = 'C:\\Users\\John Smith\\.apra-fleet\\bin';
    const winNative = path.join(path.dirname(winBin), 'staging', 'beads', 'node_modules', '@beads', 'bd', 'bin', 'bd.exe');
    const winBd = path.join(winBin, 'bd.exe');
    const calls: string[] = [];
    const files = new Set<string>();
    const chmods: string[] = [];
    const r = installBeads(winBin, {
      platform: 'win32',
      exec: (cmd, args) => {
        calls.push([cmd, ...args].join(' '));
        if (cmd === 'bd') throw new Error("'bd' is not recognized as an internal or external command");
        if (cmd === 'npm' && args.includes('-g')) throw eacces();
        if (cmd === 'npm') { files.add(winNative); return ''; }
        if (cmd === winBd) return 'bd version 1.3.0\r\n';
        throw new Error('unexpected');
      },
      existsSync: p => files.has(p),
      mkdirSync: () => {},
      rmSync: () => {},
      copyFileSync: (_s, d) => { files.add(d); },
      chmodSync: p => { chmods.push(p); },
    });
    expect(r).toMatchObject({ state: 'installed', location: 'bin-dir', binPath: winBd });
    expect(calls.find(c => c.includes('--prefix'))).toContain(`--prefix "${path.join(path.dirname(winBin), 'staging', 'beads')}"`);
    expect(chmods).toEqual([]);
  });

  it('describeExecFailure names EACCES as a non-writable global prefix', () => {
    expect(describeExecFailure(eacces())).toMatch(/^permission denied writing \/usr\/local\/lib\/node_modules\/@beads/);
  });
});

describe('member PATH: the fleet bin dir is appended for dispatch and execute_command', () => {
  it('linux/macos/gitbash append $HOME/.apra-fleet/bin after the user PATH', () => {
    const cmds = getOsCommands('linux');
    expect(cmds.wrapInWorkFolder('/w', 'bd where --json')).toBe('cd "/w" && export PATH="$PATH:$HOME/.apra-fleet/bin" && bd where --json');
    expect(cmds.agentCommand({ cliCommand: (a: string) => `claude ${a}` } as any, '-p x')).toContain('export PATH="$HOME/.local/bin:$PATH:$HOME/.apra-fleet/bin"');
  });

  it('windows appends %USERPROFILE%\\.apra-fleet\\bin after the user Path', () => {
    const cmds = getOsCommands('windows');
    expect(cmds.wrapInWorkFolder('C:\\w', 'bd where --json')).toContain('$env:Path = "$env:Path;$env:USERPROFILE\\.apra-fleet\\bin"; bd where --json');
    expect(cmds.agentCommand({ cliCommand: (a: string) => `claude ${a}` } as any, '-p x')).toContain('$env:Path = "$env:USERPROFILE\\.local\\bin;$env:Path;$env:USERPROFILE\\.apra-fleet\\bin"');
  });
});

describe('fleet-side bd status on a remote member', () => {
  const HOME = '/home/kbrmember';

  function mcpDeps(bd: 'path' | 'bin-dir' | 'missing' | 'broken', log: string[], recorded: FleetMcpStatus[]): MemberFleetMcpDeps {
    const ok = (stdout: string): SSHExecResult => ({ stdout, stderr: '', code: 0 });
    return {
      exec: async (_a, command) => {
        const c = command.includes('-EncodedCommand') ? decodePowerShellEncodedCommand(command) : command;
        log.push(c);
        if (c.includes('command -v bd') || c.includes('Get-Command bd')) {
          if (bd === 'missing') return ok(`${NO_INSTALL_SENTINEL}\n`);
          if (bd === 'broken') return ok('__APRA_FLEET_EXEC_FAILED__\n');
          return ok('bd version 1.3.0\n');
        }
        // Everything else: the member has no apra-fleet (status is unavailable,
        // which must not hide the bd observation).
        if (c.includes('--version')) return ok(`${NO_INSTALL_SENTINEL}\n`);
        return { stdout: '', stderr: 'unexpected', code: 127 };
      },
      transfer: async () => ({ success: [], failed: [] }),
      resolveHome: async () => HOME,
      orchestratorPlatform: () => ({ os: 'linux', arch: 'x64' }),
      orchestratorExecutable: () => null,
      orchestratorVersion: () => 'v0.4.4',
      downloadReleaseAsset: async () => { throw new Error('no download'); },
      removeLocal: () => {},
      connectLocalMember: async () => { throw new Error('no local'); },
      now: () => new Date(Date.UTC(2026, 9, 2)),
      record: (_id, s) => { recorded.push(s); },
    };
  }

  it('bd missing on the member: the status records it with the fix, and the register/update line names it', async () => {
    const log: string[] = [];
    const s = await probeMemberFleetMcp(makeTestAgent({ os: 'linux', llmProvider: 'claude' }), mcpDeps('missing', log, []), { install: false });
    expect(s.beads).toEqual({ state: 'missing', detail: `bd is not on the member PATH and not at ${HOME}/.apra-fleet/bin/bd`, fix: BEADS_MISSING_FIX });
    expect(beadsStatusNote(s)).toContain('warning: bd missing on the member');
  });

  it('bd present (on PATH or in the fleet bin dir): no beads field', async () => {
    const s = await probeMemberFleetMcp(makeTestAgent({ os: 'linux', llmProvider: 'claude' }), mcpDeps('path', [], []), { install: false });
    expect(s.beads).toBeUndefined();
    expect(beadsStatusNote(s)).toBe('');
  });

  it('bd present but failing: recorded as broken', async () => {
    const s = await probeMemberFleetMcp(makeTestAgent({ os: 'linux', llmProvider: 'claude' }), mcpDeps('broken', [], []), { install: false });
    expect(s.beads).toMatchObject({ state: 'broken' });
  });

  it('the probe resolves every path in JS: no shell variable expansion, PATH first then the fleet bin dir', () => {
    const posix = buildBeadsProbe(`${HOME}/.apra-fleet/bin/bd`, 'linux', 'bash' as any);
    expect(posix).not.toMatch(/\$HOME|~\/|`/);
    expect(posix.indexOf('command -v bd')).toBeLessThan(posix.indexOf(`'${HOME}/.apra-fleet/bin/bd'`));
    const ps = decodePowerShellEncodedCommand(buildBeadsProbe('C:\\Users\\k\\.apra-fleet\\bin\\bd.exe', 'windows', 'powershell5' as any));
    expect(ps).toContain("Test-Path -LiteralPath 'C:\\Users\\k\\.apra-fleet\\bin\\bd.exe'");
    expect(ps).not.toContain('$env:USERPROFILE');
  });
});
