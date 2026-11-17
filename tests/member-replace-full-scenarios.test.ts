/**
 * Member full-install replacement is opt-in, backed up, and leaves marker-owned
 * installs to the normal upgrade -- end to end through the fleetMcp probe
 * (refreshMemberFleetMcp) and the update_member tool, with a FAKE member:
 *
 *  1. a marker-owned older install + fleet_install "auto" -> upgraded, no
 *     replace step, no manual step;
 *  2. a full install + the "replace-full" opt-in -> replaced; the result names
 *     the removed items and the backup path, the marker is written, the member
 *     self-registers and its per-folder MCP entry is written;
 *  3. a full install without the opt-in -> untouched;
 *  4. a marker probe failure + the opt-in -> untouched (probe-failed).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { backupAndResetRegistry, restoreRegistry, makeTestAgent } from './test-helpers.js';
import { addAgent, getAgent, recordFleetMcpStatus } from '../src/services/registry.js';
import { updateMember } from '../src/tools/update-member.js';
import {
  __setMemberFleetMcpDeps, refreshMemberFleetMcp, NO_INSTALL_SENTINEL,
  type MemberFleetMcpDeps,
} from '../src/services/member-fleet-install.js';
import type { Agent, SSHExecResult } from '../src/types.js';

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 5 })),
    transferFiles: async (paths: string[]) => ({ success: paths, failed: [] }),
    close: vi.fn(),
  }),
}));
vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

const ORCH = 'v0.4.4';
const OLD = 'v0.4.2';
const HOME = '/home/bella';
const WORK = '/home/bella/repo';
const STAMP = '20261006T120000Z';
const BACKUP = `${HOME}/.apra-fleet-replace-backup-${STAMP}`;

type MarkerMode = 'present' | 'absent' | 'timeout';

interface World {
  installed: string | null;
  marker: MarkerMode;
  log: string[];
  entryWrites: number;
}

/** Commands only the replacement runs (never an upgrade or a refusal). */
const REPLACE_MARKERS = ['.apra-fleet-replace-backup-', 'uninstall --force --yes', 'systemctl', 'data.replaced-'];
const replaceCmds = (w: World) => w.log.filter(c => REPLACE_MARKERS.some(m => c.includes(m)));
const installRuns = (w: World) => w.log.filter(c => c.includes("'install' '--llm'"));
const registerRuns = (w: World) => w.log.filter(c => c.includes("'register-member'"));
/** Anything that changes the member: the replacement, an install run or a self-registration. */
const mutating = (w: World) => [...replaceCmds(w), ...installRuns(w), ...registerRuns(w)];

function deps(w: World): MemberFleetMcpDeps {
  const ok = (stdout: string): SSHExecResult => ({ stdout, stderr: '', code: 0 });
  return {
    exec: async (agent: Agent, c: string) => {
      w.log.push(c);
      if (c.includes('member-access.key')) return ok('');
      if (REPLACE_MARKERS.some(m => c.includes(m))) {
        if (c.includes('uninstall --force --yes')) w.installed = null;
        if (c.includes('systemctl')) return ok('__APRA_FLEET_SUPERVISOR_MOVED__\n');
        return ok('');
      }
      if (c.includes('member-install.json')) {
        if (w.marker === 'timeout') throw new Error('Command timed out after 15000ms of inactivity');
        return { stdout: '{"port":7523}', stderr: '', code: w.marker === 'present' ? 0 : 1 };
      }
      if (c.includes('server.json')) return { stdout: '', stderr: '', code: 1 };
      if (c.includes("'install' '--llm'")) { w.installed = ORCH; w.marker = 'present'; return ok('installed'); }
      if (c.includes("'register-member'")) return ok('Member registered successfully');
      if (c.includes("'call'") && c.includes("'--list-tools'")) {
        return ok(JSON.stringify({ tools: ['version', 'kb_query', 'code_query'].map(name => ({ name })) }));
      }
      if (c.includes("'call'") && c.includes("'version'")) return ok(JSON.stringify({ content: [{ type: 'text', text: `apra-fleet ${w.installed}` }] }));
      if (c.includes('--version')) return ok(w.installed ? `apra-fleet ${w.installed}\n` : `${NO_INSTALL_SENTINEL}\n`);
      if (c.includes('command -v bd')) return ok('bd version 1.3.0\n');
      if (c.includes('uname -m')) return ok('x86_64');
      if (c.includes('CLAUDE_CONFIG_DIR')) return ok('');
      if (c.includes('.claude.json')) {
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
    now: () => new Date(Date.UTC(2026, 9, 6, 12, 0, 0)),
    record: (id, status) => { recordFleetMcpStatus(id, status); },
    writeMcpEntry: async () => { w.entryWrites++; return { ok: true }; },
  };
}

function remoteMember(): Agent {
  return makeTestAgent({ os: 'linux', llmProvider: 'claude', workFolder: WORK, friendlyName: 'bella' });
}

const world = (over: Partial<World>): World => ({ installed: OLD, marker: 'absent', log: [], entryWrites: 0, ...over });

beforeEach(() => { backupAndResetRegistry(); });
afterEach(() => { __setMemberFleetMcpDeps(null); restoreRegistry(); });

describe('scenario 1: a marker-owned older install + fleet_install "auto"', () => {
  it('is upgraded in place: one member install run, no replace step, available', async () => {
    const w = world({ marker: 'present' });
    const s = await refreshMemberFleetMcp(remoteMember(), deps(w), { install: true, writeMcpEntry: true });
    expect(s).toMatchObject({ state: 'available', version: ORCH });
    expect(s.replacedFullInstall).toBeUndefined();
    expect(installRuns(w)).toHaveLength(1);
    expect(replaceCmds(w)).toEqual([]);
  });

  it('the "replace-full" opt-in on a marker-owned install is the same plain upgrade (no replace step)', async () => {
    const w = world({ marker: 'present' });
    const s = await refreshMemberFleetMcp(remoteMember(), deps(w), { install: true, writeMcpEntry: true, replaceFull: true });
    expect(s).toMatchObject({ state: 'available', version: ORCH });
    expect(s.replacedFullInstall).toBeUndefined();
    expect(installRuns(w)).toHaveLength(1);
    expect(replaceCmds(w)).toEqual([]);
  });
});

describe('scenario 2: a full install + the "replace-full" opt-in', () => {
  it('is replaced: removed items and backup path reported, marker written, self-registered, per-folder entry written', async () => {
    const w = world({});
    const s = await refreshMemberFleetMcp(remoteMember(), deps(w), { install: true, writeMcpEntry: true, replaceFull: true });
    expect(s).toMatchObject({ state: 'available', version: ORCH });
    expect(s.replacedFullInstall).toEqual({
      previousVersion: OLD,
      backupPath: BACKUP,
      removed: [
        `the apra-fleet ${OLD} full install (uninstalled with its own binary)`,
        'the fleet-supervisor user unit (stopped, disabled, unit file moved into the backup)',
        `its data directory (moved aside to ${HOME}/.apra-fleet/data.replaced-${STAMP})`,
      ],
    });
    expect(s.detail).toContain(`backup at ${BACKUP}`);
    expect(s.detail).toContain(`replaced the apra-fleet ${OLD} full install with a member install ${ORCH}`);
    expect(w.marker).toBe('present');
    expect(installRuns(w)).toHaveLength(1);
    expect(installRuns(w)[0]).toContain("'--member'");
    expect(registerRuns(w)).toHaveLength(1);
    expect(w.entryWrites).toBe(1);
    // Order: backup before the uninstall, the member install after both.
    const at = (needle: string) => w.log.findIndex(c => c.includes(needle));
    expect(at('.apra-fleet-replace-backup-')).toBeLessThan(at('uninstall --force --yes'));
    expect(at('uninstall --force --yes')).toBeLessThan(at("'install' '--llm'"));
    expect(at("'install' '--llm'")).toBeLessThan(at("'register-member'"));
  });

  it('through update_member: the fleetMcp line names the replacement and the backup', async () => {
    const a = remoteMember();
    addAgent(a);
    const w = world({});
    __setMemberFleetMcpDeps(deps(w));
    const out = await updateMember({ member_id: a.id, fleet_install: 'replace-full' } as never);
    expect(out).toContain(`fleetMcp: available (apra-fleet ${ORCH})`);
    expect(out).toContain(`replaced the apra-fleet ${OLD} full install`);
    expect(out).toContain(`backup at ${BACKUP}`);
    expect(getAgent(a.id)?.fleetMcp).toMatchObject({ state: 'available', replacedFullInstall: { backupPath: BACKUP } });
  });
});

describe('scenario 3: a full install without the opt-in', () => {
  it('is untouched: full-install-running, no replace, install or registration command', async () => {
    const w = world({});
    const s = await refreshMemberFleetMcp(remoteMember(), deps(w), { install: true, writeMcpEntry: true });
    expect(s).toMatchObject({ state: 'unavailable', reason: 'full-install-running' });
    expect(mutating(w)).toEqual([]);
    expect(w.entryWrites).toBe(0);
    expect(w.installed).toBe(OLD);
    expect(w.marker).toBe('absent');
  });

  it('through update_member fleet_install "auto": untouched too', async () => {
    const a = remoteMember();
    addAgent(a);
    const w = world({});
    __setMemberFleetMcpDeps(deps(w));
    const out = await updateMember({ member_id: a.id, fleet_install: 'auto' } as never);
    expect(out).toContain('unavailable (full-install-running)');
    expect(mutating(w)).toEqual([]);
  });
});

describe('scenario 4: a marker probe failure + the opt-in', () => {
  it('is untouched: probe-failed, no replace, install or registration command', async () => {
    const w = world({ marker: 'timeout' });
    const s = await refreshMemberFleetMcp(remoteMember(), deps(w), { install: true, writeMcpEntry: true, replaceFull: true });
    expect(s).toMatchObject({ state: 'unavailable', reason: 'probe-failed', detail: expect.stringContaining('timed out') });
    // Pins the replaceFull guard: only it appends this opt-in-specific text (the normal upgrade path also fails probe-failed).
    expect((s as { detail: string }).detail).toContain('the opt-in full-install replacement was not run');
    expect(mutating(w)).toEqual([]);
    expect(w.entryWrites).toBe(0);
    expect(w.installed).toBe(OLD);
  });
});
