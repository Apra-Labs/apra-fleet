/**
 * Member-install marker gaps, verified end to end with a FAKE member transport:
 *
 *  1. install --member whose auto-start fails leaves the marker, so the next
 *     update_member fleet_install "auto" recognises its own half-finished install
 *     and completes (no full-install-running). The marker-write ordering itself is
 *     asserted against the real installer in install-member.test.ts; this suite
 *     replays the member state that ordering leaves behind.
 *  2. A marker probe that times out (or exits with anything but a clean "absent")
 *     is probe-failed with the reason, never full-install-running; a clean
 *     "absent" is still full-install-running.
 *  3. remove_member on an unmarked install (or when ownership cannot be probed)
 *     sends no member-side unregister command and says it skipped and why.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  backupAndResetRegistry, restoreRegistry, makeTestAgent, decodePowerShellEncodedCommand,
} from './test-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import { removeMember } from '../src/tools/remove-member.js';
import {
  __setMemberFleetMcpDeps, refreshMemberFleetMcp, ensureMemberFleetInstall, NO_INSTALL_SENTINEL,
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

type MarkerMode = 'present' | 'absent' | 'timeout' | 'exit-127';

interface World {
  installed: string | null;
  marker: MarkerMode;
  log: string[];
}

const isMarkerCheck = (c: string) => c.includes('member-install.json');
const installRuns = (w: World) => w.log.filter(c => c.includes("'install' '--llm'"));
const removeRuns = (w: World) => w.log.filter(c => c.includes("'remove-member'"));

function deps(w: World): MemberFleetMcpDeps {
  const ok = (stdout: string): SSHExecResult => ({ stdout, stderr: '', code: 0 });
  return {
    exec: async (agent: Agent, raw: string) => {
      const c = decodePowerShellEncodedCommand(raw);
      w.log.push(c);
      if (isMarkerCheck(c)) {
        switch (w.marker) {
          case 'present': return ok('');
          case 'absent': return { stdout: '', stderr: '', code: 1 };
          case 'timeout': throw new Error('Command timed out after 15000ms of inactivity');
          case 'exit-127': return { stdout: '', stderr: 'sh: test: not found', code: 127 };
        }
      }
      if (c.includes("'install' '--llm'")) { w.installed = ORCH; w.marker = 'present'; return ok('installed'); }
      if (c.includes("'register-member'")) return ok('Member registered successfully');
      if (c.includes("'remove-member'")) return ok('removed');
      if (c.includes("'call'") && c.includes("'--list-tools'")) {
        return ok(JSON.stringify({ tools: ['version', 'kb_query', 'code_query'].map(name => ({ name })) }));
      }
      if (c.includes("'call'") && c.includes("'version'")) return ok(JSON.stringify({ content: [{ type: 'text', text: `apra-fleet ${w.installed}` }] }));
      if (c.includes('--version')) return ok(w.installed ? `apra-fleet ${w.installed}\n` : `${NO_INSTALL_SENTINEL}\n`);
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
    now: () => new Date(Date.UTC(2026, 9, 2, 12, 0, 0)),
    record: () => {},
  };
}

function remoteMember(): Agent {
  return makeTestAgent({ os: 'linux', llmProvider: 'claude', workFolder: WORK, friendlyName: 'bella' });
}

beforeEach(() => { backupAndResetRegistry(); });
afterEach(() => { __setMemberFleetMcpDeps(null); restoreRegistry(); });

describe('scenario 1: a failed auto-start leaves the marker and the next fleet_install "auto" completes', () => {
  it('a marked, older install is upgraded and registered, never refused as full-install-running', async () => {
    // State left by install --member after E-MEMBER-AUTOSTART: binary + marker, old version.
    const w: World = { installed: OLD, marker: 'present', log: [] };
    const s = await refreshMemberFleetMcp(remoteMember(), deps(w), { install: true });
    expect(s).toMatchObject({ state: 'available', version: ORCH });
    expect(installRuns(w)).toHaveLength(1);
  });
});

describe('scenario 2: marker probe failures are probe-failed with the reason', () => {
  it('a timed-out marker probe -> probe-failed naming the timeout, nothing installed', async () => {
    const w: World = { installed: OLD, marker: 'timeout', log: [] };
    const r = await ensureMemberFleetInstall(remoteMember(), deps(w));
    expect(r).toMatchObject({ state: 'unavailable', reason: 'probe-failed', detail: expect.stringContaining('timed out') });
    expect(installRuns(w)).toHaveLength(0);
  });

  it('an unrelated non-zero marker probe exit -> probe-failed naming the exit, nothing installed', async () => {
    const w: World = { installed: OLD, marker: 'exit-127', log: [] };
    const r = await ensureMemberFleetInstall(remoteMember(), deps(w));
    expect(r).toMatchObject({ state: 'unavailable', reason: 'probe-failed', detail: expect.stringContaining('127') });
    expect(installRuns(w)).toHaveLength(0);
  });

  it('the status probe (no install requested) maps a marker probe failure to probe-failed too', async () => {
    const w: World = { installed: ORCH, marker: 'timeout', log: [] };
    const s = await refreshMemberFleetMcp(remoteMember(), deps(w), { install: false });
    expect(s).toMatchObject({ state: 'unavailable', reason: 'probe-failed', detail: expect.stringContaining('timed out') });
  });

  it('a clean "absent" answer is still full-install-running (unchanged)', async () => {
    const w: World = { installed: OLD, marker: 'absent', log: [] };
    const r = await ensureMemberFleetInstall(remoteMember(), deps(w));
    expect(r).toMatchObject({ state: 'unavailable', reason: 'full-install-running' });
    expect(installRuns(w)).toHaveLength(0);
  });
});

describe('scenario 3: remove_member leaves an unowned member install untouched and says so', () => {
  async function removeWith(marker: MarkerMode): Promise<{ out: string; w: World; id: string }> {
    const w: World = { installed: ORCH, marker, log: [] };
    __setMemberFleetMcpDeps(deps(w));
    const a = remoteMember();
    addAgent(a);
    const out = await removeMember({ member_id: a.id, force: false });
    return { out, w, id: a.id };
  }

  it('unmarked install: no member-side unregister command; output says it is not fleet-owned', async () => {
    const { out, w, id } = await removeWith('absent');
    expect(out).toContain('has been removed');
    expect(removeRuns(w)).toHaveLength(0);
    expect(out).toContain('skipped');
    expect(out).toContain('not fleet-owned');
    expect(getAgent(id)).toBeUndefined();
  });

  it('marker probe failure: skips and names the probe error', async () => {
    const { out, w } = await removeWith('timeout');
    expect(out).toContain('has been removed');
    expect(removeRuns(w)).toHaveLength(0);
    expect(out).toContain('skipped');
    expect(out).toContain('timed out');
  });

  it('marked install: the registration is still removed on the member', async () => {
    const { w } = await removeWith('present');
    expect(removeRuns(w)).toHaveLength(1);
  });
});
