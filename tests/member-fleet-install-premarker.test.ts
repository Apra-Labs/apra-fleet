/**
 * Pre-marker member upgrade: a member installed by a build that predates the
 * member-install marker has a running server `install --member --force` alone
 * refuses (E-FULL-INSTALL-RUNNING). The fleet retries that install exactly
 * once with --force-stop-full-install, but ONLY when it can show it owns that
 * install:
 *   - fast path: a recorded fleetMcp.fleetInstalledAt (written only by builds
 *     that also write the marker, so it is absent on a REAL pre-marker member);
 *   - the member's OWN registry (<home>/.apra-fleet/data/registry.json) holds
 *     an entry whose id equals the agent id (created by the fleet's earlier
 *     `register-member --id <uuid>` self-registration), read only after a
 *     refusal.
 * A host with neither (a genuine human full install) is never overridden.
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
  fleetPreviouslyInstalled,
  memberRegistryHoldsId,
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

/** What the member's own registry.json read returns. */
type Registry =
  | { kind: 'missing' }
  | { kind: 'garbage' }
  | { kind: 'unreadable' }
  | { kind: 'ids'; ids: string[] }
  | { kind: 'entries'; entries: Array<{ id: string; agentType?: string }> };

interface Member {
  installed: string | null;
  /** True while a server without the member-install marker is running. */
  unmarkedServerRunning: boolean;
  /** The member's own apra-fleet registry. */
  registry: Registry;
  /** When true the override run fails too (with a generic installer error). */
  overrideFails?: boolean;
  /** Every member command, decoded from -EncodedCommand when wrapped. */
  log: string[];
  recorded: FleetMcpStatus[];
}

const isInstall = (c: string) => c.includes("'install' '--llm'");
const isRegistryRead = (c: string) => c.includes('registry.json');
const installRuns = (m: Member) => m.log.filter(isInstall);
const registryReads = (m: Member) => m.log.filter(isRegistryRead);

function newMember(over: Partial<Member> = {}): Member {
  return { installed: OLD, unmarkedServerRunning: true, registry: { kind: 'ids', ids: [AGENT_ID] }, log: [], recorded: [], ...over };
}

function deps(m: Member, platform: { os: 'linux' | 'windows'; arch: string } = { os: 'linux', arch: 'x64' }): MemberFleetMcpDeps {
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
        if (override && m.overrideFails) return { stdout: '', stderr: 'disk full', code: 1 };
        m.unmarkedServerRunning = false;
        m.installed = ORCH;
        return ok('installed');
      }
      if (isRegistryRead(c)) {
        switch (m.registry.kind) {
          case 'missing': return ok(''); // readMemberFileCommand: a missing file is empty output, exit 0
          case 'garbage': return ok('{not json');
          case 'unreadable': return { stdout: '', stderr: 'Permission denied', code: 1 };
          // A self-registration entry: the member registered itself as LOCAL.
          case 'ids': return ok(JSON.stringify({ version: '1', agents: m.registry.ids.map(id => ({ id, friendlyName: 'bella', agentType: 'local' })) }));
          case 'entries': return ok(JSON.stringify({ version: '1', agents: m.registry.entries.map(e => ({ friendlyName: 'bella', ...e })) }));
        }
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
      if (c.includes('cat "') && c.includes('.claude.json')) {
        return ok(JSON.stringify({ projects: { [WORK]: { mcpServers: { 'apra-fleet': { type: 'http', url: `http://localhost:7523/mcp?member=${agent.id}` } } } } }));
      }
      return { stdout: '', stderr: `unexpected: ${c}`, code: 127 };
    },
    transfer: async (_a, localPaths) => ({ success: localPaths, failed: [] }),
    resolveHome: async () => (platform.os === 'windows' ? WIN_HOME : HOME),
    orchestratorPlatform: () => platform,
    orchestratorExecutable: () => (platform.os === 'windows' ? 'C:\\fleet\\apra-fleet.exe' : '/opt/fleet/apra-fleet'),
    orchestratorVersion: () => ORCH,
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

/** A REALISTIC pre-marker member: its recorded fleetMcp carries an old version
 *  but NO fleetInstalledAt (older builds never wrote it). */
const PRE_MARKER_STATUS: FleetMcpStatus = { state: 'available', version: OLD, checkedAt: '2026-09-01T00:00:00.000Z' };

/** A member installed by a build that stamps fleetInstalledAt (fast path). */
const STAMPED_STATUS: FleetMcpStatus = { ...PRE_MARKER_STATUS, fleetInstalledAt: '2026-09-01T00:00:00.000Z' };

function expectNoPosixExpansion(cmds: string[]): void {
  for (const c of cmds) {
    expect(c).not.toContain('$HOME');
    expect(c).not.toContain('~/');
    expect(c).not.toContain('`');
  }
}

describe('pre-marker member upgrade', () => {
  it('a pre-marker member with no fleetInstalledAt whose own registry lists its id is upgraded after exactly one override retry; fleetMcp ends available', async () => {
    const m = newMember();
    const agent = member(PRE_MARKER_STATUS);
    expect(agent.fleetMcp?.fleetInstalledAt).toBeUndefined();
    const s = await refreshMemberFleetMcp(agent, deps(m), { install: true });
    expect(s).toMatchObject({ state: 'available', version: ORCH });
    expect(m.recorded.at(-1)).toMatchObject({ state: 'available', version: ORCH });
    const runs = installRuns(m);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toContain("'--member'");
    expect(runs[0]).toContain("'--force'");
    expect(runs[0]).not.toContain(FORCE_STOP_FULL_INSTALL_FLAG);
    expect(runs[1]).toContain(`'--force' '${FORCE_STOP_FULL_INSTALL_FLAG}'`);
    expect(runs[1].replace(` '${FORCE_STOP_FULL_INSTALL_FLAG}'`, '')).toBe(runs[0]);
    // the registry was read once, between the refusal and the retry, from the
    // member's own data dir with a JS-resolved path
    const reads = registryReads(m);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain(`"${HOME}/.apra-fleet/data/registry.json"`);
    expect(m.log.indexOf(reads[0])).toBeGreaterThan(m.log.indexOf(runs[0]));
    expect(m.log.indexOf(reads[0])).toBeLessThan(m.log.indexOf(runs[1]));
    expectNoPosixExpansion(m.log);
  });

  it('a pre-marker member with NO recorded fleetMcp at all is upgraded from the registry signal alone', async () => {
    const m = newMember();
    const s = await refreshMemberFleetMcp(member(), deps(m), { install: true });
    expect(s).toMatchObject({ state: 'available', version: ORCH });
    expect(installRuns(m)).toHaveLength(2);
  });

  it('fast path: a stamped fleetInstalledAt is retried with the override without reading the member registry', async () => {
    const m = newMember({ registry: { kind: 'missing' } });
    const s = await refreshMemberFleetMcp(member(STAMPED_STATUS), deps(m), { install: true });
    expect(s).toMatchObject({ state: 'available', version: ORCH });
    const runs = installRuns(m);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toContain(`'${FORCE_STOP_FULL_INSTALL_FLAG}'`);
    expect(registryReads(m)).toHaveLength(0);
  });

  it('the member registry is not queried when the first install run succeeds', async () => {
    const m = newMember({ unmarkedServerRunning: false });
    const s = await refreshMemberFleetMcp(member(PRE_MARKER_STATUS), deps(m), { install: true });
    expect(s).toMatchObject({ state: 'available', version: ORCH });
    expect(installRuns(m)).toHaveLength(1);
    expect(registryReads(m)).toHaveLength(0);
    for (const c of m.log) expect(c).not.toContain(FORCE_STOP_FULL_INSTALL_FLAG);
  });

  describe('human full install is never overridden', () => {
    const humanCases: Array<[string, Registry]> = [
      ['a registry without this member id', { kind: 'ids', ids: [] }],
      // A "remote" member on the orchestrator's own host and user: the file read
      // returns the ORCHESTRATOR's registry, whose entry for this id is remote.
      ['a registry holding this id only as a REMOTE entry (same-host member: the orchestrator\'s own registry)', { kind: 'entries', entries: [{ id: AGENT_ID, agentType: 'remote' }] }],
      ['a registry listing only OTHER member ids', { kind: 'ids', ids: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'] }],
      ['a missing registry file', { kind: 'missing' }],
      ['an unparseable registry file', { kind: 'garbage' }],
      ['an unreadable registry file', { kind: 'unreadable' }],
    ];
    for (const [label, registry] of humanCases) {
      it(`${label}: one installer run, no override, full-install-running, register-member not run, server left running`, async () => {
        const m = newMember({ registry });
        const s = await refreshMemberFleetMcp(member(PRE_MARKER_STATUS), deps(m), { install: true });
        expect(installRuns(m)).toHaveLength(1);
        expect(m.log.filter(c => c.includes(FORCE_STOP_FULL_INSTALL_FLAG))).toHaveLength(0);
        expect(registryReads(m)).toHaveLength(1);
        expect(m.unmarkedServerRunning).toBe(true);
        // The refusal is recorded even though an older install is present: the
        // fleet does not fall back to registering into a human's full install.
        expect(s).toMatchObject({ state: 'unavailable', reason: 'full-install-running' });
        expect(s.version).toBeUndefined();
        expect(m.recorded.at(-1)).toMatchObject({ state: 'unavailable', reason: 'full-install-running' });
        expect(m.log.some(c => c.includes("'register-member'"))).toBe(false);
        expect(s.detail).toContain(`apra-fleet install --member --force ${FORCE_STOP_FULL_INSTALL_FLAG}`);
      });
    }

    it('with no install on the member and no ownership signal, the refusal is recorded as full-install-running', async () => {
      const m = newMember({ installed: null, registry: { kind: 'missing' } });
      const s = await refreshMemberFleetMcp(member(), deps(m), { install: true });
      expect(s).toMatchObject({ state: 'unavailable', reason: 'full-install-running' });
      expect(installRuns(m)).toHaveLength(1);
      expect(m.log.filter(c => c.includes(FORCE_STOP_FULL_INSTALL_FLAG))).toHaveLength(0);
    });

    it('a second ensure, fed the status the first refusal recorded, still sends no override', async () => {
      const m = newMember({ registry: { kind: 'ids', ids: ['11111111-1111-4111-8111-111111111111'] } });
      await refreshMemberFleetMcp(member(), deps(m), { install: true });
      const first = m.recorded.at(-1)!;
      expect(first.fleetInstalledAt).toBeUndefined();
      const s = await refreshMemberFleetMcp(member(first), deps(m), { install: true });
      expect(s).toMatchObject({ state: 'unavailable', reason: 'full-install-running' });
      expect(installRuns(m)).toHaveLength(2);
      expect(m.log.filter(c => c.includes(FORCE_STOP_FULL_INSTALL_FLAG))).toHaveLength(0);
      expect(m.unmarkedServerRunning).toBe(true);
    });

    it('a probe-only (install:false) observation followed by install:true sends no override', async () => {
      const m = newMember({ registry: { kind: 'missing' } });
      const observed = await refreshMemberFleetMcp(member(), deps(m), { install: false });
      expect(observed.fleetInstalledAt).toBeUndefined();
      const s = await refreshMemberFleetMcp(member(m.recorded.at(-1)), deps(m), { install: true });
      expect(s).toMatchObject({ state: 'unavailable', reason: 'full-install-running' });
      expect(installRuns(m)).toHaveLength(1);
      expect(m.log.filter(c => c.includes(FORCE_STOP_FULL_INSTALL_FLAG))).toHaveLength(0);
      expect(m.unmarkedServerRunning).toBe(true);
    });
  });

  it('a windows/powershell pre-marker member gets a PowerShell-form registry read with no POSIX expansion, and is upgraded', async () => {
    const m = newMember();
    const r = await ensureMemberFleetInstall(windowsMember(PRE_MARKER_STATUS), deps(m, { os: 'windows', arch: 'x64' }));
    expect(r).toMatchObject({ state: 'available', version: ORCH, installed: true });
    const reads = registryReads(m);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain(`Test-Path -LiteralPath "${WIN_HOME}\\.apra-fleet\\data\\registry.json"`);
    expect(reads[0]).toContain('Get-Content -Raw');
    expect(reads[0]).not.toContain('cat ');
    expect(reads[0]).not.toContain('test -e');
    expect(reads[0]).not.toContain('$env:');
    expectNoPosixExpansion(m.log);
    expect(installRuns(m)).toHaveLength(2);
  });

  it('a windows/powershell member whose registry lacks its id is not overridden', async () => {
    const m = newMember({ registry: { kind: 'ids', ids: ['11111111-1111-4111-8111-111111111111'] } });
    const r = await ensureMemberFleetInstall(windowsMember(), deps(m, { os: 'windows', arch: 'x64' }));
    expect(r).toMatchObject({ state: 'unavailable', reason: 'full-install-running' });
    expect(installRuns(m)).toHaveLength(1);
    expect(m.log.filter(c => c.includes(FORCE_STOP_FULL_INSTALL_FLAG))).toHaveLength(0);
  });

  it('a failing retry reports the second failure\'s typed reason', async () => {
    const m = newMember({ installed: null, overrideFails: true });
    const s = await refreshMemberFleetMcp(member(PRE_MARKER_STATUS), deps(m), { install: true });
    expect(s).toMatchObject({ state: 'unavailable', reason: 'install-failed' });
    expect(s.detail).toContain(`retried once with ${FORCE_STOP_FULL_INSTALL_FLAG}`);
    expect(s.detail).toContain('disk full');
    expect(installRuns(m)).toHaveLength(2);
  });

  it('a plain install failure (not a refusal) is never retried and never reads the registry', async () => {
    const m = newMember({ installed: null, unmarkedServerRunning: false });
    const d = deps(m);
    const exec = d.exec;
    d.exec = async (a, c, t) => (isInstall(c) ? (m.log.push(c), { stdout: '', stderr: 'boom', code: 1 }) : exec(a, c, t));
    const s = await refreshMemberFleetMcp(member(STAMPED_STATUS), d, { install: true });
    expect(s).toMatchObject({ state: 'unavailable', reason: 'install-failed' });
    expect(installRuns(m)).toHaveLength(1);
    expect(registryReads(m)).toHaveLength(0);
  });

  it('a successful fleet install stamps fleetInstalledAt, and later probes carry it forward', async () => {
    const m = newMember({ installed: null, unmarkedServerRunning: false });
    const s = await refreshMemberFleetMcp(member(), deps(m), { install: true });
    expect(s.fleetInstalledAt).toBe('2026-10-02T12:00:00.000Z');
    const again = await refreshMemberFleetMcp(member(s), deps(m), { install: false });
    expect(again.fleetInstalledAt).toBe(s.fleetInstalledAt);
  });

  it('fleetPreviouslyInstalled reads only fleetInstalledAt, not a recorded version', () => {
    expect(fleetPreviouslyInstalled(member(PRE_MARKER_STATUS))).toBe(false);
    expect(fleetPreviouslyInstalled(member())).toBe(false);
    expect(fleetPreviouslyInstalled(member({ state: 'unavailable', reason: 'probe-failed', checkedAt: 'x' }))).toBe(false);
    expect(fleetPreviouslyInstalled(member(STAMPED_STATUS))).toBe(true);
  });

  it('memberRegistryHoldsId: true only for a registry entry with this id; never throws', async () => {
    const holds = (registry: Registry) => memberRegistryHoldsId(member(), HOME, deps(newMember({ registry })));
    expect(await holds({ kind: 'ids', ids: [AGENT_ID] })).toBe(true);
    expect(await holds({ kind: 'ids', ids: ['other'] })).toBe(false);
    expect(await holds({ kind: 'missing' })).toBe(false);
    expect(await holds({ kind: 'garbage' })).toBe(false);
    expect(await holds({ kind: 'unreadable' })).toBe(false);
    const throwing = { exec: async () => { throw new Error('transport down'); } };
    expect(await memberRegistryHoldsId(member(), HOME, throwing)).toBe(false);
    const agentsNotArray = { exec: async () => ({ stdout: JSON.stringify({ agents: { id: AGENT_ID } }), stderr: '', code: 0 }) };
    expect(await memberRegistryHoldsId(member(), HOME, agentsNotArray)).toBe(false);
  });

  it('memberRegistryHoldsId: a REMOTE-type entry with this id is NOT ownership (same-host member reads the orchestrator registry)', async () => {
    const holds = (registry: Registry) => memberRegistryHoldsId(member(), HOME, deps(newMember({ registry })));
    expect(await holds({ kind: 'entries', entries: [{ id: AGENT_ID, agentType: 'remote' }] })).toBe(false);
    expect(await holds({ kind: 'entries', entries: [{ id: AGENT_ID }] })).toBe(false);
    expect(await holds({ kind: 'entries', entries: [{ id: AGENT_ID, agentType: 'local' }] })).toBe(true);
  });
});
