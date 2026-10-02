/**
 * Pre-marker member upgrade: a member installed by a build that predates the
 * member-install marker has a running server `install --member --force` alone
 * refuses (E-FULL-INSTALL-RUNNING). The fleet retries that install exactly
 * once with --force-stop-full-install, but ONLY when its registry shows it
 * installed the member before (a recorded fleetMcp.version); a host with no
 * such record (a genuine human full install) is never overridden.
 *
 * Driven by a fake member transport; assertions read the actual installer
 * command strings sent to the member.
 */
import { describe, it, expect } from 'vitest';
import { makeTestAgent } from './test-helpers.js';
import type { Agent, FleetMcpStatus, SSHExecResult } from '../src/types.js';
import {
  refreshMemberFleetMcp,
  fleetPreviouslyInstalled,
  NO_INSTALL_SENTINEL,
  type MemberFleetMcpDeps,
} from '../src/services/member-fleet-install.js';
import { FULL_INSTALL_RUNNING_CODE, FORCE_STOP_FULL_INSTALL_FLAG } from '../src/cli/install-guard.js';

const ORCH = 'v0.4.4';
const OLD = 'v0.4.2';
const HOME = '/home/bella';
const WORK = '/home/bella/repo';

interface Member {
  installed: string | null;
  /** True while a server without the member-install marker is running. */
  unmarkedServerRunning: boolean;
  /** When true the override run fails too (with a generic installer error). */
  overrideFails?: boolean;
  log: string[];
  recorded: FleetMcpStatus[];
}

const isInstall = (c: string) => c.includes("'install' '--llm'");
const installRuns = (m: Member) => m.log.filter(isInstall);

function deps(m: Member): MemberFleetMcpDeps {
  const ok = (stdout: string): SSHExecResult => ({ stdout, stderr: '', code: 0 });
  return {
    exec: async (agent: Agent, c: string) => {
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
      if (c.includes("'register-member'")) return ok('Member registered successfully');
      if (c.includes("'call'") && c.includes("'--list-tools'")) {
        return ok(JSON.stringify({ tools: ['version', 'kb_query', 'code_query'].map(name => ({ name })) }));
      }
      if (c.includes("'call'") && c.includes("'version'")) return ok(JSON.stringify({ content: [{ type: 'text', text: `apra-fleet ${m.installed}` }] }));
      if (c.includes('--version')) return ok(m.installed ? `apra-fleet ${m.installed}\n` : `${NO_INSTALL_SENTINEL}\n`);
      if (c.includes('uname -m')) return ok('x86_64');
      if (c.includes('CLAUDE_CONFIG_DIR')) return ok('');
      if (c.includes('cat "') && c.includes('.claude.json')) {
        return ok(JSON.stringify({ projects: { [WORK]: { mcpServers: { 'apra-fleet': { type: 'http', url: `http://localhost:7523/mcp?member=${agent.id}` } } } } }));
      }
      return { stdout: '', stderr: `unexpected: ${c}`, code: 127 };
    },
    transfer: async (_a, localPaths) => ({ success: localPaths, failed: [] }),
    resolveHome: async () => HOME,
    orchestratorPlatform: () => ({ os: 'linux', arch: 'x64' }),
    orchestratorExecutable: () => '/opt/fleet/apra-fleet',
    orchestratorVersion: () => ORCH,
    downloadReleaseAsset: async () => { throw new Error('not expected'); },
    removeLocal: () => {},
    connectLocalMember: async () => { throw new Error('not expected'); },
    now: () => new Date(Date.UTC(2026, 9, 2, 12, 0, 0)),
    record: (_id, status) => { m.recorded.push(status); },
  };
}

function member(fleetMcp?: FleetMcpStatus): Agent {
  return makeTestAgent({ os: 'linux', llmProvider: 'claude', workFolder: WORK, friendlyName: 'bella', ...(fleetMcp ? { fleetMcp } : {}) });
}

const PRIOR_FLEET_INSTALL: FleetMcpStatus = { state: 'available', version: OLD, checkedAt: '2026-09-01T00:00:00.000Z' };

describe('pre-marker member upgrade', () => {
  it('a member the fleet installed before is upgraded after exactly one retry carrying the override; fleetMcp ends available', async () => {
    const m: Member = { installed: OLD, unmarkedServerRunning: true, log: [], recorded: [] };
    const s = await refreshMemberFleetMcp(member(PRIOR_FLEET_INSTALL), deps(m), { install: true });
    expect(s).toMatchObject({ state: 'available', version: ORCH });
    expect(m.recorded.at(-1)).toMatchObject({ state: 'available', version: ORCH });
    const runs = installRuns(m);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toContain("'--member'");
    expect(runs[0]).toContain("'--force'");
    expect(runs[0]).not.toContain(FORCE_STOP_FULL_INSTALL_FLAG);
    expect(runs[1]).toContain(`'--force' '${FORCE_STOP_FULL_INSTALL_FLAG}'`);
    expect(runs[1].replace(` '${FORCE_STOP_FULL_INSTALL_FLAG}'`, '')).toBe(runs[0]);
  });

  it('a host with no fleet install record (human full install) is never overridden: one installer run, full-install-running', async () => {
    const m: Member = { installed: OLD, unmarkedServerRunning: true, log: [], recorded: [] };
    const s = await refreshMemberFleetMcp(member(), deps(m), { install: true });
    const runs = installRuns(m);
    expect(runs).toHaveLength(1);
    for (const c of m.log) expect(c).not.toContain(FORCE_STOP_FULL_INSTALL_FLAG);
    expect(m.unmarkedServerRunning).toBe(true);
    // The refusal is recorded even though an older install is present: the
    // fleet does not fall back to registering into a human's full install.
    expect(s).toMatchObject({ state: 'unavailable', reason: 'full-install-running', version: OLD });
    expect(m.recorded.at(-1)).toMatchObject({ state: 'unavailable', reason: 'full-install-running' });
    expect(m.log.some(c => c.includes("'register-member'"))).toBe(false);
  });

  it('with no install on the member and no record, the refusal is recorded as full-install-running', async () => {
    const m: Member = { installed: null, unmarkedServerRunning: true, log: [], recorded: [] };
    const s = await refreshMemberFleetMcp(member(), deps(m), { install: true });
    expect(s).toMatchObject({ state: 'unavailable', reason: 'full-install-running' });
    expect(installRuns(m)).toHaveLength(1);
    for (const c of m.log) expect(c).not.toContain(FORCE_STOP_FULL_INSTALL_FLAG);
    expect(s.detail).toContain(`apra-fleet install --member --force ${FORCE_STOP_FULL_INSTALL_FLAG}`);
  });

  it('a failing retry reports the second failure\'s typed reason', async () => {
    const m: Member = { installed: null, unmarkedServerRunning: true, overrideFails: true, log: [], recorded: [] };
    const s = await refreshMemberFleetMcp(member(PRIOR_FLEET_INSTALL), deps(m), { install: true });
    expect(s).toMatchObject({ state: 'unavailable', reason: 'install-failed' });
    expect(s.detail).toContain(`retried once with ${FORCE_STOP_FULL_INSTALL_FLAG}`);
    expect(s.detail).toContain('disk full');
    expect(installRuns(m)).toHaveLength(2);
  });

  it('a plain install failure (not a refusal) is never retried', async () => {
    const m: Member = { installed: null, unmarkedServerRunning: false, log: [], recorded: [] };
    const d = deps(m);
    const exec = d.exec;
    d.exec = async (a, c, t) => (isInstall(c) ? (m.log.push(c), { stdout: '', stderr: 'boom', code: 1 }) : exec(a, c, t));
    const s = await refreshMemberFleetMcp(member(PRIOR_FLEET_INSTALL), d, { install: true });
    expect(s).toMatchObject({ state: 'unavailable', reason: 'install-failed' });
    expect(installRuns(m)).toHaveLength(1);
  });

  it('fleetPreviouslyInstalled reads only a recorded fleetMcp version', () => {
    expect(fleetPreviouslyInstalled(member())).toBe(false);
    expect(fleetPreviouslyInstalled(member({ state: 'unavailable', reason: 'probe-failed', checkedAt: 'x' }))).toBe(false);
    expect(fleetPreviouslyInstalled(member(PRIOR_FLEET_INSTALL))).toBe(true);
  });
});
