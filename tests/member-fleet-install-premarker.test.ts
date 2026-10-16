/**
 * Unmarked member installs: the member-install marker
 * (<home>/.apra-fleet/data/member-install.json, written by `install --member`)
 * is the SOLE fleet-ownership signal for the apra-fleet at
 * <home>/.apra-fleet/bin.
 *
 * An install without it is a human full install or a member install made by a
 * build older than the marker. The two cannot be told apart -- builds before
 * this rule self-registered into ANY install, so a human full install may hold
 * a LOCAL registry entry for this member's uuid -- so the fleet treats both as
 * not its own:
 *   - it never installs over an unmarked install (running server or not);
 *   - it never self-registers (register-member) into an unmarked install;
 *   - it never sends --force-stop-full-install, whatever fleetInstalledAt or
 *     the member registry say, on a core bump or a same-core build rebuild;
 *   - it records fleetMcp unavailable(full-install-running) naming the
 *     one-time owner takeover command.
 *
 * Driven by a fake member transport; assertions read the actual command
 * strings sent to the member.
 */
import { describe, it, expect } from 'vitest';
import { makeTestAgent, decodePowerShellEncodedCommand } from './test-helpers.js';
import type { Agent, FleetMcpStatus, SSHExecResult } from '../src/types.js';
import {
  refreshMemberFleetMcp,
  ensureMemberFleetInstall,
  probeMemberInstallMarker,
  memberInstallArgs,
  NO_INSTALL_SENTINEL,
  type MemberFleetMcpDeps,
} from '../src/services/member-fleet-install.js';
import { FULL_INSTALL_RUNNING_CODE, FORCE_STOP_FULL_INSTALL_FLAG } from '../src/cli/install-guard.js';

const ORCH = 'v0.4.4';
const OLD = 'v0.4.2';
const HOME = '/home/bella';
const WORK = '/home/bella/repo';
const WIN_HOME = 'C:\\Users\\bella';
const WIN_WORK = 'C:\\Users\\bella\\repo';
const AGENT_ID = 'a1b2c3d4-0000-4000-8000-00000000beef';

interface Member {
  installed: string | null;
  /** The member-install marker exists on the member. */
  marker: boolean;
  /** True while a server without the member-install marker is running. */
  unmarkedServerRunning: boolean;
  /** A LOCAL entry for AGENT_ID sits in the member's own registry.json (left by
   *  an earlier build's self-registration into this install). */
  poisonedRegistry: boolean;
  /** Every member command, decoded from -EncodedCommand when wrapped. */
  log: string[];
  transfers: number;
  recorded: FleetMcpStatus[];
}

const isInstall = (c: string) => c.includes("'install' '--llm'");
const isMarkerCheck = (c: string) => c.includes('member-install.json');
const installRuns = (m: Member) => m.log.filter(isInstall);
const registerRuns = (m: Member) => m.log.filter(c => c.includes("'register-member'"));
const overrides = (m: Member) => m.log.filter(c => c.includes(FORCE_STOP_FULL_INSTALL_FLAG));

/** Default: a human full install (no marker, server running) whose registry
 *  already holds a self-registered LOCAL entry for this member's uuid. */
function newMember(over: Partial<Member> = {}): Member {
  return { installed: OLD, marker: false, unmarkedServerRunning: true, poisonedRegistry: true, log: [], transfers: 0, recorded: [], ...over };
}

function deps(
  m: Member,
  opts: { platform?: { os: 'linux' | 'windows'; arch: string }; orch?: string } = {},
): MemberFleetMcpDeps {
  const platform = opts.platform ?? { os: 'linux', arch: 'x64' };
  const orch = opts.orch ?? ORCH;
  const ok = (stdout: string): SSHExecResult => ({ stdout, stderr: '', code: 0 });
  return {
    exec: async (agent: Agent, raw: string) => {
      const c = decodePowerShellEncodedCommand(raw);
      m.log.push(c);
      if (isInstall(c)) {
        const override = c.includes(`'${FORCE_STOP_FULL_INSTALL_FLAG}'`);
        if (m.unmarkedServerRunning && !override) {
          // the real install-guard refusal: exit 3 with the typed code on stderr
          return { stdout: '', stderr: `${FULL_INSTALL_RUNNING_CODE}: a running apra-fleet server was not started by a member install`, code: 3 };
        }
        m.unmarkedServerRunning = false;
        m.marker = true;
        m.installed = orch;
        return ok('installed');
      }
      // The member access secret read: an install without one (older than the secret).
      if (c.includes('member-access.key')) return ok('');
      if (isMarkerCheck(c)) return m.marker ? ok('') : { stdout: '', stderr: '', code: 1 };
      if (c.includes('registry.json')) {
        return ok(JSON.stringify({ version: '1', agents: m.poisonedRegistry ? [{ id: agent.id, friendlyName: 'bella', agentType: 'local' }] : [] }));
      }
      if (c.includes("'register-member'")) return ok('Member registered successfully');
      if (c.includes("'call'") && c.includes("'--list-tools'")) {
        return ok(JSON.stringify({ tools: ['version', 'kb_query', 'code_query'].map(name => ({ name })) }));
      }
      if (c.includes("'call'") && c.includes("'version'")) return ok(JSON.stringify({ content: [{ type: 'text', text: `apra-fleet ${m.installed}` }] }));
      if (c.includes('--version')) return ok(m.installed ? `apra-fleet ${m.installed}\n` : `${NO_INSTALL_SENTINEL}\n`);
      if (c.includes('uname -m')) return ok('x86_64');
      if (c.includes('PROCESSOR_ARCHITECTURE')) return ok('AMD64');
      if (c.includes('CLAUDE_CONFIG_DIR')) return ok('');
      if (c.includes('.claude.json')) {
        const work = platform.os === 'windows' ? WIN_WORK : WORK;
        return ok(JSON.stringify({ projects: { [work]: { mcpServers: { 'apra-fleet': { type: 'http', url: `http://localhost:7523/mcp?member=${agent.id}` } } } } }));
      }
      return { stdout: '', stderr: `unexpected: ${c}`, code: 127 };
    },
    transfer: async (_a, localPaths) => { m.transfers++; return { success: localPaths, failed: [] }; },
    resolveHome: async () => (platform.os === 'windows' ? WIN_HOME : HOME),
    orchestratorPlatform: () => platform,
    orchestratorExecutable: () => (platform.os === 'windows' ? 'C:\\fleet\\apra-fleet.exe' : '/opt/fleet/apra-fleet'),
    orchestratorVersion: () => orch,
    downloadReleaseAsset: async () => { throw new Error('not expected'); },
    removeLocal: () => {},
    connectLocalMember: async () => { throw new Error('not expected'); },
    now: () => new Date(Date.UTC(2026, 9, 2, 12, 0, 0)),
    record: (_id, status) => { m.recorded.push(status); },
  };
}

function member(fleetMcp?: FleetMcpStatus): Agent {
  return makeTestAgent({ id: AGENT_ID, os: 'linux', llmProvider: 'claude', workFolder: WORK, friendlyName: 'bella', ...(fleetMcp ? { fleetMcp } : {}) });
}

function windowsMember(fleetMcp?: FleetMcpStatus): Agent {
  return makeTestAgent({ id: AGENT_ID, os: 'windows', shell: 'powershell5', llmProvider: 'claude', workFolder: WIN_WORK, friendlyName: 'bella', ...(fleetMcp ? { fleetMcp } : {}) });
}

/** A member the fleet once installed (stamp present) -- and a human later ran a
 *  full install over it, which cleared the marker. */
const STAMPED_STATUS: FleetMcpStatus = { state: 'available', version: OLD, checkedAt: '2026-09-01T00:00:00.000Z', fleetInstalledAt: '2026-09-01T00:00:00.000Z' };

function expectNoPosixExpansion(cmds: string[]): void {
  for (const c of cmds) {
    expect(c).not.toContain('$HOME');
    expect(c).not.toContain('~/');
    expect(c).not.toContain('`');
  }
}

function expectHumanInstallUntouched(m: Member, s: FleetMcpStatus): void {
  expect(overrides(m)).toHaveLength(0);
  expect(m.unmarkedServerRunning).toBe(true);
  expect(m.marker).toBe(false);
  expect(registerRuns(m)).toHaveLength(0);
  expect(s).toMatchObject({ state: 'unavailable', reason: 'full-install-running' });
  expect(s.detail).toContain('uninstall --force --yes');
  expect(m.recorded.at(-1)).toMatchObject({ state: 'unavailable', reason: 'full-install-running' });
}

describe('a human full install (no member-install marker) is never stopped', () => {
  const cases: Array<[string, string, string]> = [
    ['same-core build rebuild', 'v0.4.4_aaaaaa', 'v0.4.4_bbbbbb'],
    ['core bump', OLD, ORCH],
  ];
  for (const [label, memberVersion, orch] of cases) {
    for (const stamped of [false, true]) {
      it(`${label}${stamped ? ', fleetInstalledAt stamped' : ''}, registry holds a self-registered LOCAL entry: no install, no override, server keeps running`, async () => {
        const m = newMember({ installed: memberVersion });
        const s = await refreshMemberFleetMcp(member(stamped ? STAMPED_STATUS : undefined), deps(m, { orch }), { install: true });
        expect(installRuns(m)).toHaveLength(0);
        expect(m.transfers).toBe(1); // the current installer is staged for the owner's replacement steps, never run
        expect(m.installed).toBe(memberVersion);
        expectHumanInstallUntouched(m, s);
      });

      it(`${label}${stamped ? ', fleetInstalledAt stamped' : ''}, server NOT running: the unmarked install is not installed over`, async () => {
        const m = newMember({ installed: memberVersion, unmarkedServerRunning: false });
        const s = await refreshMemberFleetMcp(member(stamped ? STAMPED_STATUS : undefined), deps(m, { orch }), { install: true });
        expect(installRuns(m)).toHaveLength(0);
        expect(m.transfers).toBe(1); // the current installer is staged for the owner's replacement steps, never run
        expect(m.installed).toBe(memberVersion);
        expect(m.marker).toBe(false);
        expect(overrides(m)).toHaveLength(0);
        expect(registerRuns(m)).toHaveLength(0);
        expect(s).toMatchObject({ state: 'unavailable', reason: 'full-install-running' });
        expect(s.detail).toContain('uninstall --force --yes');
      });
    }
  }

  it('a second ensure fed the first recorded status still sends no override', async () => {
    const m = newMember();
    await refreshMemberFleetMcp(member(), deps(m), { install: true });
    const s = await refreshMemberFleetMcp(member(m.recorded.at(-1)), deps(m), { install: true });
    expect(installRuns(m)).toHaveLength(0);
    expectHumanInstallUntouched(m, s);
  });

  it('backstop: no binary at the path but an unmarked server running -> the refused install is not retried with the override', async () => {
    const m = newMember({ installed: null });
    const s = await refreshMemberFleetMcp(member(STAMPED_STATUS), deps(m), { install: true });
    expect(installRuns(m)).toHaveLength(1);
    expectHumanInstallUntouched(m, s);
  });

  it('windows/powershell: same-core rebuild over an unmarked install sends no override', async () => {
    const m = newMember({ installed: 'v0.4.4_aaaaaa' });
    const r = await ensureMemberFleetInstall(windowsMember(STAMPED_STATUS), deps(m, { platform: { os: 'windows', arch: 'x64' }, orch: 'v0.4.4_bbbbbb' }));
    expect(r).toMatchObject({ state: 'unavailable', reason: 'full-install-running' });
    expect(installRuns(m)).toHaveLength(0);
    expect(overrides(m)).toHaveLength(0);
    expect(m.unmarkedServerRunning).toBe(true);
  });

  it('the member install command never carries the override', () => {
    for (const p of ['claude', 'gemini', 'codex', 'opencode'] as const) {
      expect(memberInstallArgs(p)).not.toContain(FORCE_STOP_FULL_INSTALL_FLAG);
    }
  });
});

describe('self-registration happens only into a marked member install', () => {
  it('up to date, no marker: no register-member is sent; records full-install-running', async () => {
    const m = newMember({ installed: ORCH, poisonedRegistry: false });
    const s = await refreshMemberFleetMcp(member(), deps(m), { install: true });
    expect(installRuns(m)).toHaveLength(0);
    expectHumanInstallUntouched(m, s);
    expect(s.detail).toContain('no member-install marker');
  });

  it('observe-only (install:false), no marker: no register-member is sent', async () => {
    const m = newMember({ installed: ORCH });
    const s = await refreshMemberFleetMcp(member(), deps(m), { install: false });
    expect(installRuns(m)).toHaveLength(0);
    expectHumanInstallUntouched(m, s);
  });

  it('up to date WITH the marker: self-registers as before and ends available', async () => {
    const m = newMember({ installed: ORCH, marker: true, unmarkedServerRunning: false });
    const s = await refreshMemberFleetMcp(member(), deps(m), { install: true });
    expect(s).toMatchObject({ state: 'available', version: ORCH });
    expect(installRuns(m)).toHaveLength(0);
    const regs = registerRuns(m);
    expect(regs).toHaveLength(1);
    expect(regs[0]).toContain(`'register-member' '--type' 'local' '--id' '${AGENT_ID}'`);
    const check = m.log.find(isMarkerCheck)!;
    expect(check).toBe(`test -f "${HOME}/.apra-fleet/data/member-install.json"`);
    expect(m.log.indexOf(check)).toBeLessThan(m.log.indexOf(regs[0]));
    expectNoPosixExpansion(m.log);
  });

  it('no install on the member: the fleet installs (writing the marker), self-registers, and stamps fleetInstalledAt', async () => {
    const m = newMember({ installed: null, unmarkedServerRunning: false });
    const s = await refreshMemberFleetMcp(member(), deps(m), { install: true });
    expect(s).toMatchObject({ state: 'available', version: ORCH, fleetInstalledAt: '2026-10-02T12:00:00.000Z' });
    expect(installRuns(m)).toHaveLength(1);
    expect(registerRuns(m)).toHaveLength(1);
    expect(overrides(m)).toHaveLength(0);
  });

  it('after the owner takes it over (marker written, server marked), the next ensure upgrades and registers', async () => {
    const m = newMember({ installed: 'v0.4.4_aaaaaa' });
    await refreshMemberFleetMcp(member(), deps(m, { orch: 'v0.4.4_bbbbbb' }), { install: true });
    expect(registerRuns(m)).toHaveLength(0);
    // owner ran the replacement steps on the member
    m.marker = true;
    m.unmarkedServerRunning = false;
    const s = await refreshMemberFleetMcp(member(m.recorded.at(-1)), deps(m, { orch: 'v0.4.4_bbbbbb' }), { install: true });
    expect(s).toMatchObject({ state: 'available', version: 'v0.4.4_bbbbbb' });
    expect(registerRuns(m)).toHaveLength(1);
    expect(overrides(m)).toHaveLength(0);
  });

  it('windows/powershell: the marker check is a PowerShell literal-path probe with no POSIX expansion', async () => {
    const m = newMember({ installed: ORCH, marker: true, unmarkedServerRunning: false });
    await refreshMemberFleetMcp(windowsMember(), deps(m, { platform: { os: 'windows', arch: 'x64' } }), { install: true });
    expect(registerRuns(m)).toHaveLength(1); // the marker was found, so it self-registered
    const check = m.log.find(isMarkerCheck)!;
    expect(check).toContain(`Test-Path -LiteralPath '${WIN_HOME}\\.apra-fleet\\data\\member-install.json' -PathType Leaf`);
    expect(check).not.toContain('$env:');
    expectNoPosixExpansion(m.log);
  });

  it('probeMemberInstallMarker: exit 0 present, exit 1 absent, anything else a probe failure (never a full install)', async () => {
    const probe = (r: SSHExecResult | Error) => probeMemberInstallMarker(member(), HOME, { exec: async () => { if (r instanceof Error) throw r; return r; } });
    expect(await probe({ stdout: '', stderr: '', code: 0 })).toEqual({ kind: 'present' });
    expect(await probe({ stdout: '', stderr: '', code: 1 })).toEqual({ kind: 'absent' });
    expect(await probe({ stdout: '', stderr: 'denied', code: 255 })).toMatchObject({ kind: 'probe-failed', detail: expect.stringContaining('255') });
    expect(await probe(new Error('transport down'))).toMatchObject({ kind: 'probe-failed', detail: expect.stringContaining('transport down') });
    const m = newMember({ installed: ORCH, marker: true });
    const d = deps(m);
    const exec = d.exec;
    d.exec = async (a, c, t) => (isMarkerCheck(c) ? Promise.reject(new Error('transport down')) : exec(a, c, t));
    const s = await refreshMemberFleetMcp(member(), d, { install: true });
    expect(s).toMatchObject({ state: 'unavailable', reason: 'probe-failed' });
    expect(registerRuns(m)).toHaveLength(0);
  });
});
