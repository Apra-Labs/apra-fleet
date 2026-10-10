/**
 * Standalone member server (no service manager on the member): the fleet
 * starts the member's apra-fleet server detached after a member install that
 * reported MEMBER-STANDALONE, starts it again whenever a later probe finds it
 * down, and reports the exact cause plus a one-line fix when it cannot be kept
 * running. Driven through probeMemberFleetMcp (what register_member,
 * update_member and member_detail call) with a FAKE member exec -- no real
 * host, no real server.
 *
 * Revert check (stated, and re-run by hand when this file changes): with the
 * start step in probeRemote removed (src/services/member-fleet-install.ts,
 * steps 3c and the step-4 retry), "install on a service-less Linux member ..."
 * fails -- no start command is issued and the status is
 * unavailable(member-session-failed) instead of available.
 */
import { describe, it, expect } from 'vitest';
import { makeTestAgent, decodePowerShellEncodedCommand } from './test-helpers.js';
import {
  probeMemberFleetMcp, fleetMcpFixLine, buildMemberStartCommand, memberStandalonePidPath,
  memberCallSaysServerDown, NO_INSTALL_SENTINEL, MEMBER_START_HEALTH_TIMEOUT_MS,
  type MemberFleetMcpDeps,
} from '../src/services/member-fleet-install.js';
import { MEMBER_STANDALONE_CODE } from '../src/cli/install-guard.js';
import type { Agent, SSHExecResult } from '../src/types.js';

const VERSION = 'v0.4.4';
const HOME = '/home/bella';
const BIN = `${HOME}/.apra-fleet/bin/apra-fleet`;
const PIDFILE = `${HOME}/.apra-fleet/data/standalone.pid`;
const SECRET = 'a'.repeat(64);

interface World {
  installed: string | null;
  /** The member has no usable service manager: the installer says MEMBER-STANDALONE. */
  noServiceManager: boolean;
  serverUp: boolean;
  start: 'ok' | 'never-healthy' | 'stopped-by-user';
  log: string[];
}

const newWorld = (over: Partial<World> = {}): World => ({
  installed: null, noServiceManager: true, serverUp: false, start: 'ok', log: [], ...over,
});

const plain = (cmd: string): string => (cmd.includes('-EncodedCommand') ? decodePowerShellEncodedCommand(cmd) : cmd);
const ok = (stdout: string): SSHExecResult => ({ stdout, stderr: '', code: 0 });

const INSTALL_STANDALONE_OUTPUT = [
  '  [9/9] Registering and starting service...',
  '    Service registration skipped: systemd user mode is not available. Service management requires systemd.',
  '',
  `    [WARN] ${MEMBER_STANDALONE_CODE}: no user-mode service manager is usable on this host`,
  '    (systemd user mode is not available. Service management requires systemd.). The server runs standalone.',
  '',
  'Apra Fleet v0.4.4 installed successfully for Claude Code.',
].join('\n');

function fakeDeps(world: World): MemberFleetMcpDeps {
  return {
    exec: async (_agent, command) => {
      const c = plain(command);
      world.log.push(c);
      if (c.includes('member-access.key')) return ok(SECRET);
      if (c.includes('member-install.json')) return ok('');
      if (c.includes("'register-member'") || c.includes("'register-member'")) return ok('registered');
      if (c.includes('command -v bd') || c.includes('bd.exe')) return ok('bd version 1.3.0\n');
      if (c.includes("'start'")) {
        if (world.start === 'ok') { world.serverUp = true; return ok('Server starting...\nServer started at http://127.0.0.1:7523/mcp pid=4242\n'); }
        if (world.start === 'stopped-by-user') {
          return { stdout: '', stderr: "apra-fleet was stopped by the user at 2026-10-10T08:00:00Z via 'apra-fleet stop'; not auto-starting it. Run 'apra-fleet start'.", code: 1 };
        }
        return {
          stdout: 'Server starting...\n',
          stderr: `Server process exited during startup (exit code 1). Check logs at: ${HOME}/.apra-fleet/data/fleet.log\n`
            + `Last lines of ${HOME}/.apra-fleet/data/fleet.log:\nError: listen EADDRINUSE: address already in use 127.0.0.1:7523`,
          code: 1,
        };
      }
      if (c.includes("'call'")) {
        if (!world.serverUp) {
          return { stdout: '', stderr: JSON.stringify({ error: { code: 'AUTOSTART_LIMIT', message: 'The apra-fleet HTTP server was auto-started 3 times in the last 10 minutes and is gone again' } }), code: 1 };
        }
        if (c.includes("'--list-tools'")) return ok(JSON.stringify({ tools: ['version', 'kb_query', 'code_query'].map(name => ({ name })) }));
        return ok(JSON.stringify({ content: [{ type: 'text', text: `apra-fleet ${world.installed}` }] }));
      }
      if (c.includes('--version')) return ok(world.installed ? `apra-fleet ${world.installed}\n` : `${NO_INSTALL_SENTINEL}\n`);
      if (c.includes('uname -m') || c.includes('PROCESSOR_ARCHITECTURE')) return ok('x86_64');
      if (c.includes("'install'")) {
        world.installed = VERSION;
        return ok(world.noServiceManager ? INSTALL_STANDALONE_OUTPUT : 'Service:     registered and running\n');
      }
      return { stdout: '', stderr: `unexpected: ${c}`, code: 127 };
    },
    transfer: async (_a, localPaths) => ({ success: localPaths, failed: [] }),
    resolveHome: async () => HOME,
    orchestratorPlatform: () => ({ os: 'linux', arch: 'x64' }),
    orchestratorExecutable: () => '/opt/fleet/apra-fleet',
    orchestratorVersion: () => VERSION,
    downloadReleaseAsset: async () => '/tmp/fake-release-asset',
    removeLocal: () => {},
    connectLocalMember: async () => { throw new Error('no local session expected'); },
    now: () => new Date(Date.UTC(2026, 9, 10, 12, 0, 0)),
    record: () => {},
  };
}

const linuxMember = (): Agent => makeTestAgent({ os: 'linux', username: 'bella', workFolder: `${HOME}/repo`, llmProvider: 'claude' });
const startCmds = (w: World): string[] => w.log.filter(c => c.includes("'start'"));
const callAt = (w: World): number => w.log.findIndex(c => c.includes("'call'"));

describe('standalone member server: the fleet starts it detached', () => {
  it('install on a service-less Linux member issues a detached start with a pidfile, then reports fleetMcp available', async () => {
    const w = newWorld();
    const status = await probeMemberFleetMcp(linuxMember(), fakeDeps(w), { install: true });
    expect(status.state).toBe('available');
    const starts = startCmds(w);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toBe(
      `nohup '${BIN}' 'start' '--autostart' '--pidfile' '${PIDFILE}' '--timeout-ms' '${MEMBER_START_HEALTH_TIMEOUT_MS}' < /dev/null 2>&1`,
    );
    // Started before the member session is verified.
    expect(w.log.indexOf(starts[0])).toBeLessThan(callAt(w));
    expect(status.detail).toContain('started the apra-fleet server on the member (pid 4242');
    expect(status.detail).toContain('not restarted on reboot');
  });

  it('an install that registered a service issues no start', async () => {
    const w = newWorld({ noServiceManager: false, serverUp: true });
    const status = await probeMemberFleetMcp(linuxMember(), fakeDeps(w), { install: true });
    expect(status.state).toBe('available');
    expect(startCmds(w)).toEqual([]);
  });

  it('a later probe that finds the server down starts it the same way and recovers (member_detail refresh and update_member)', async () => {
    for (const install of [false, true]) {
      const w = newWorld({ installed: VERSION, serverUp: false });
      const status = await probeMemberFleetMcp(linuxMember(), fakeDeps(w), { install });
      expect(status.state).toBe('available');
      expect(startCmds(w)).toHaveLength(1);
      expect(startCmds(w)[0]).toContain(`'--pidfile' '${PIDFILE}'`);
      // call version failed, start ran, call version ran again.
      const calls = w.log.filter(c => c.includes("'call'") && c.includes("'version'"));
      expect(calls).toHaveLength(2);
      expect(status.detail).toContain('started the apra-fleet server on the member');
    }
  });

  it('a running server is never started again', async () => {
    const w = newWorld({ installed: VERSION, serverUp: true });
    const status = await probeMemberFleetMcp(linuxMember(), fakeDeps(w), { install: false });
    expect(status.state).toBe('available');
    expect(startCmds(w)).toEqual([]);
  });
});

describe('standalone member server: a server that cannot be kept running is reported with cause and fix', () => {
  it('a start that never becomes healthy yields member-server-not-running naming the cause (log tail) and a one-line fix', async () => {
    const w = newWorld({ start: 'never-healthy' });
    const status = await probeMemberFleetMcp(linuxMember(), fakeDeps(w), { install: true });
    expect(status.state).toBe('unavailable');
    expect(status.reason).toBe('member-server-not-running');
    expect(status.detail).toContain('exited during startup');
    expect(status.detail).toContain('EADDRINUSE');
    expect(status.detail).toContain('standalone mode');
    const fix = fleetMcpFixLine(status)!;
    expect(fix).toContain('apra-fleet start');
    expect(fix).not.toContain('\n');
  });

  it('a server the member user stopped is not restarted; the reason names the stop', async () => {
    const w = newWorld({ installed: VERSION, start: 'stopped-by-user' });
    const status = await probeMemberFleetMcp(linuxMember(), fakeDeps(w), { install: false });
    expect(status.reason).toBe('member-server-not-running');
    expect(status.detail).toContain('stopped by the user');
    expect(w.log.filter(c => c.includes("'call'") && c.includes("'version'"))).toHaveLength(1);
  });

  it('a session failure that is not "server down" is not answered with a start', () => {
    expect(memberCallSaysServerDown('call version: E-MEMBER-FORBIDDEN: server refused member x')).toBe(false);
    expect(memberCallSaysServerDown('call version: AUTOSTART_VERSION_UNKNOWN: ...')).toBe(true);
    expect(memberCallSaysServerDown('call version: E-CONNECT: connect ECONNREFUSED 127.0.0.1:7523')).toBe(true);
  });
});

describe('standalone member server: commands are built for the member OS/shell', () => {
  it('POSIX: quoted literal paths, no shell variable expansion', () => {
    const cmd = buildMemberStartCommand(BIN, PIDFILE, 'linux', 'bash' as never);
    expect(cmd).not.toMatch(/\$|~|`/);
    expect(cmd.startsWith('nohup ')).toBe(true);
  });

  it('Windows PowerShell: an encoded PowerShell call of start, no POSIX-only syntax', () => {
    const home = 'C:\\Users\\bella';
    const bin = `${home}\\.apra-fleet\\bin\\apra-fleet.exe`;
    const pid = memberStandalonePidPath(home, 'windows', 'powershell' as never);
    expect(pid).toBe(`${home}\\.apra-fleet\\data\\standalone.pid`);
    const cmd = buildMemberStartCommand(bin, pid, 'windows', 'powershell' as never);
    expect(cmd).toContain('-EncodedCommand');
    const ps = decodePowerShellEncodedCommand(cmd);
    expect(ps).toContain(`& '${bin}' 'start' '--autostart' '--pidfile' '${pid}'`);
    expect(ps).not.toMatch(/nohup|\/dev\/null|2>&1/);
  });
});
