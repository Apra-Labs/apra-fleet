/**
 * Member self-registration, MEMBER-session verification and the recoverable
 * fleetMcp status (apra-fleet-b4g.56.2). Fake transport -- no real member.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTestAgent, makeTestLocalAgent, decodePowerShellEncodedCommand, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import type { Agent, FleetMcpStatus, SSHExecResult } from '../src/types.js';
import {
  probeMemberFleetMcp,
  refreshMemberFleetMcp,
  removeMemberFromOwnInstall,
  defaultMemberFleetMcpDeps,
  NO_INSTALL_SENTINEL,
  ReleaseDownloadError,
  fleetMcpFixLine,
  memberErrorDetail,
  MEMBER_ERROR_DETAIL_MAX,
  type MemberFleetMcpDeps,
  type MemberSession,
} from '../src/services/member-fleet-install.js';
import { addAgent, getAgent, recordFleetMcpStatus } from '../src/services/registry.js';
import { runRemoveMember } from '../src/cli/remove-member.js';

const VERSION = 'v0.4.4';
const HOME = '/home/bella';
const WORK = '/home/bella/repo';

/** A real-shaped member-side register-member failure: the ERROR line and its
 *  cause first, then a long searched-path list (well over 300 chars). */
const REGISTER_ERROR_HEAD = 'ERROR: member not provisioned -- "bella" was registered but compose_permissions failed: ' +
  'compose_permissions threw: No complete profiles directory (base-dev.json + base-reviewer.json) found. Searched: ';
const LONG_REGISTER_ERROR = REGISTER_ERROR_HEAD +
  Array.from({ length: 40 }, (_, i) => `/home/bella/.apra-fleet/searched/dir-${i}/skills/fleet/profiles`).join(', ');

interface World {
  installed: string | null;
  /** The member-install marker exists on the member (a member install). */
  marker: boolean;
  /** register-member outcome on the member's own install. */
  register: 'ok' | 'id-rejected' | 'folder-taken' | 'unknown-verb' | 'long-error';
  /** ~/.claude.json content on the member. */
  claudeJson: Record<string, unknown> | null;
  listTools: string[];
  /** Installer outcome: 'ok' upgrades; 'killed' exits 143 (Terminated); 'no-upgrade' exits 0 but leaves the old version. */
  installer?: 'ok' | 'killed' | 'no-upgrade';
  /** The installer is a release asset to download; 'timeout' makes the download time out. */
  releaseAsset?: 'timeout';
  /** The installer transfer to the member fails. */
  transferFails?: boolean;
  execLog: string[];
  transfers: number;
  recorded: FleetMcpStatus[];
}

function entryFor(agent: Agent): Record<string, unknown> {
  return { projects: { [WORK]: { mcpServers: { 'apra-fleet': { type: 'http', url: `http://localhost:7523/mcp?member=${agent.id}` } } } } };
}

function text(cmd: string): string {
  return cmd.includes('-EncodedCommand') ? decodePowerShellEncodedCommand(cmd) : cmd;
}

function deps(world: World, local?: { connect: (id: string) => Promise<MemberSession> }): MemberFleetMcpDeps {
  const ok = (stdout: string): SSHExecResult => ({ stdout, stderr: '', code: 0 });
  let tick = 0;
  return {
    exec: async (_a, command) => {
      const c = text(command);
      world.execLog.push(c);
      // Marker read (cat / Get-Content): a current member install records its port.
      // The member access secret read: an install without one (older than the secret).
      if (c.includes('member-access.key')) return ok('');
      if (c.includes('member-install.json') && (c.includes('cat ') || c.includes('Get-Content'))) {
        return world.marker ? ok(JSON.stringify({ version: VERSION, port: 7523 })) : ok('');
      }
      if (c.includes('member-install.json')) return world.marker ? ok('') : { stdout: '', stderr: '', code: 1 };
      if (c.includes("'register-member'")) {
        switch (world.register) {
          case 'ok': return ok('Member registered successfully');
          case 'id-rejected': return { stdout: '', stderr: `Error: Unknown or unexpected argument "--id". Run 'apra-fleet register-member --help'.`, code: 1 };
          case 'folder-taken': return { stdout: '', stderr: 'E-FOLDER-TAKEN: folder already registered to another member', code: 1 };
          case 'unknown-verb': return { stdout: '', stderr: "Error: unknown option 'register-member'", code: 1 };
          case 'long-error': return { stdout: '', stderr: LONG_REGISTER_ERROR, code: 1 };
        }
      }
      if (c.includes("'remove-member'")) return ok('Member removed');
      if (c.includes("'call'") && c.includes("'--list-tools'")) {
        return ok(JSON.stringify({ tools: world.listTools.map(name => ({ name })) }));
      }
      if (c.includes("'call'") && c.includes("'version'")) {
        return ok(JSON.stringify({ content: [{ type: 'text', text: `apra-fleet ${world.installed}` }] }));
      }
      if (c.includes('--version')) {
        return ok(world.installed ? `apra-fleet ${world.installed}\n` : `${NO_INSTALL_SENTINEL}\n`);
      }
      if (c.includes('uname -m')) return ok('x86_64');
      if (c.includes("'install'")) {
        if (world.installer === 'killed') {
          return { stdout: 'Registered service detected -- stopping it through the service manager.\n', stderr: 'Terminated', code: 143 };
        }
        if (world.installer === 'no-upgrade') return ok('installed');
        world.installed = VERSION; world.marker = true; return ok('installed');
      }
      if (c.includes('CLAUDE_CONFIG_DIR')) return ok('');
      if (c.includes('cat "') && c.includes('.claude.json')) return ok(world.claudeJson ? JSON.stringify(world.claudeJson) : '');
      return { stdout: '', stderr: `unexpected: ${c}`, code: 127 };
    },
    transfer: async (_a, localPaths) => {
      world.transfers++;
      return world.transferFails
        ? { success: [], failed: localPaths.map(path => ({ path, error: 'No space left on device' })) }
        : { success: localPaths, failed: [] };
    },
    resolveHome: async () => HOME,
    // A release-asset world runs the orchestrator on another platform, so the
    // member's installer must be downloaded instead of copied.
    orchestratorPlatform: () => (world.releaseAsset ? { os: 'darwin', arch: 'arm64' } : { os: 'linux', arch: 'x64' }),
    orchestratorExecutable: () => '/opt/fleet/apra-fleet',
    orchestratorVersion: () => VERSION,
    downloadReleaseAsset: async () => {
      if (world.releaseAsset === 'timeout') throw new ReleaseDownloadError('download-timeout', 'no response within 120s');
      throw new Error('not expected');
    },
    removeLocal: () => {},
    connectLocalMember: local?.connect ?? (async () => { throw new Error('no local session expected'); }),
    now: () => new Date(Date.UTC(2026, 9, 1, 12, 0, tick++)),
    record: (_id, status) => { world.recorded.push(status); },
  };
}

function newWorld(over: Partial<World> = {}): World {
  return {
    installed: VERSION, marker: true, register: 'ok', claudeJson: null,
    listTools: ['version', 'kb_query', 'kb_capture', 'code_query', 'code_context'],
    execLog: [], transfers: 0, recorded: [], ...over,
  };
}

function remoteClaude(): Agent {
  return makeTestAgent({ os: 'linux', llmProvider: 'claude', workFolder: WORK, friendlyName: 'bella' });
}

describe('remote member: install, self-register, verify MEMBER session', () => {
  it('after a successful install reports the installed version; version call and --list-tools (kb_*, code_*) succeed', async () => {
    const agent = remoteClaude();
    const world = newWorld({ installed: null });
    world.claudeJson = entryFor(agent);
    const s = await probeMemberFleetMcp(agent, deps(world));
    expect(s).toEqual({ state: 'available', version: VERSION, checkedAt: expect.any(String), fleetInstalledAt: expect.any(String), port: 7523, portSource: 'marker' });
    expect(world.transfers).toBe(1); // an install actually ran
    const reg = world.execLog.find(c => c.includes("'register-member'"))!;
    expect(reg).toContain(`'register-member' '--type' 'local' '--id' '${agent.id}' '--name' 'bella' '--path' '${WORK}' '--llm' 'claude'`);
    expect(reg.startsWith(`'${HOME}/.apra-fleet/bin/apra-fleet'`)).toBe(true);
    const ver = world.execLog.find(c => c.includes("'call'") && c.includes("'version'"))!;
    expect(ver).toContain(`'call' '--member' '${agent.id}' 'version' '--args-file'`);
    expect(world.execLog.some(c => c.includes(`'call' '--member' '${agent.id}' '--list-tools'`))).toBe(true);
  });

  // The member session listing the tools does not prove a dispatched role sees
  // them: roles run as `claude --agent <role>`, whose tools list filters the
  // session. The probe checks that path last and reports it loudly.
  it('role files that filter out the member tools -> unavailable(role-agents-hide-member-tools), version kept', async () => {
    const agent = remoteClaude();
    const world = newWorld();
    world.claudeJson = entryFor(agent);
    const checked: string[] = [];
    const s = await probeMemberFleetMcp(agent, {
      ...deps(world),
      roleAgents: async a => { checked.push(a.id); return { ok: false, detail: 'member role files differ from the canonical set: doer.md' }; },
    });
    expect(s).toMatchObject({ state: 'unavailable', reason: 'role-agents-hide-member-tools', version: VERSION });
    expect(s.detail).toContain('doer.md');
    expect(checked).toEqual([agent.id]);
  });

  it('role files that grant the member tools -> available', async () => {
    const agent = remoteClaude();
    const world = newWorld();
    world.claudeJson = entryFor(agent);
    const s = await probeMemberFleetMcp(agent, { ...deps(world), roleAgents: async () => ({ ok: true }) });
    expect(s).toMatchObject({ state: 'available', version: VERSION });
  });

  it('the role check runs only once the member session is verified (not on an earlier failure)', async () => {
    const agent = remoteClaude();
    const world = newWorld({ listTools: ['version'] });
    let called = false;
    const s = await probeMemberFleetMcp(agent, { ...deps(world), roleAgents: async () => { called = true; return { ok: true }; } });
    expect(s).toMatchObject({ state: 'unavailable', reason: 'member-tools-missing' });
    expect(called).toBe(false);
  });

  it('role files the check healed are named on the available status', async () => {
    const agent = remoteClaude();
    const s = await probeMemberFleetMcp(agent, { ...deps(newWorld()), roleAgents: async () => ({ ok: true, healed: ['doer.md'] }) });
    expect(s).toMatchObject({ state: 'available' });
    expect(s.detail).toContain('rewrote role files that hid the member kb_*/code_* tools: doer.md');
  });

  it('a session that lists no kb_*/code_* tools is unavailable(member-tools-missing)', async () => {
    const agent = remoteClaude();
    const world = newWorld({ listTools: ['version', 'report_status'] });
    world.claudeJson = entryFor(agent);
    const s = await probeMemberFleetMcp(agent, deps(world));
    expect(s).toMatchObject({ state: 'unavailable', reason: 'member-tools-missing' });
  });

  it('claude: no per-folder entry is required (dispatches get the member config per session) -> available', async () => {
    const agent = remoteClaude();
    const world = newWorld({ claudeJson: { projects: {} } });
    const s = await probeMemberFleetMcp(agent, deps(world));
    expect(s).toMatchObject({ state: 'available', version: VERSION });
    expect(world.execLog.some(c => c.includes('.claude.json'))).toBe(false);
    expect(world.execLog.some(c => c.includes("'call'"))).toBe(true);
  });

  it('claude: a per-folder entry for a different member id does not gate either', async () => {
    const agent = remoteClaude();
    const other = makeTestAgent({ id: '11111111-2222-3333-4444-555555555555' });
    const s = await probeMemberFleetMcp(agent, deps(newWorld({ claudeJson: entryFor(other) })));
    expect(s).toMatchObject({ state: 'available' });
  });

  it('opencode: a missing per-folder entry still gates -> unavailable(mcp-entry-missing)', async () => {
    const agent = makeTestAgent({ os: 'linux', llmProvider: 'opencode', workFolder: WORK, friendlyName: 'bella-oc' });
    const world = newWorld();
    const s = await probeMemberFleetMcp(agent, deps(world));
    expect(s).toMatchObject({ state: 'unavailable', reason: 'mcp-entry-missing', version: VERSION });
    expect(world.execLog.some(c => c.includes("'call'"))).toBe(false);
  });

  it('--id rejected -> unavailable(install-too-old)', async () => {
    const agent = remoteClaude();
    const s = await probeMemberFleetMcp(agent, deps(newWorld({ register: 'id-rejected', claudeJson: entryFor(agent) })));
    expect(s).toMatchObject({ state: 'unavailable', reason: 'install-too-old' });
  });

  it('an install with no register-member verb at all is also install-too-old', async () => {
    const agent = remoteClaude();
    const s = await probeMemberFleetMcp(agent, deps(newWorld({ register: 'unknown-verb', claudeJson: entryFor(agent) })));
    expect(s).toMatchObject({ state: 'unavailable', reason: 'install-too-old' });
  });

  it('E-FOLDER-TAKEN -> unavailable(E-FOLDER-TAKEN), never a throw', async () => {
    const agent = remoteClaude();
    const s = await probeMemberFleetMcp(agent, deps(newWorld({ register: 'folder-taken', claudeJson: entryFor(agent) })));
    expect(s).toMatchObject({ state: 'unavailable', reason: 'E-FOLDER-TAKEN' });
  });

  it('a long register-member failure keeps the leading ERROR line and its cause in the detail', async () => {
    expect(LONG_REGISTER_ERROR.length).toBeGreaterThan(1000);
    const s = await probeMemberFleetMcp(remoteClaude(), deps(newWorld({ register: 'long-error' })));
    expect(s).toMatchObject({ state: 'unavailable', reason: 'register-failed', version: VERSION });
    expect(s.detail).toContain(`register-member exited 1: ${REGISTER_ERROR_HEAD}`);
    expect(s.detail).toContain('No complete profiles directory');
    // the whole member-side text survives (it is under the cap)
    expect(s.detail).toContain('/home/bella/.apra-fleet/searched/dir-39/skills/fleet/profiles');
  });

  it('a runaway register-member output is capped from the end, never the ERROR head', () => {
    const noisy = 'log line\n'.repeat(50) + LONG_REGISTER_ERROR + ' tail'.repeat(2000);
    const d = memberErrorDetail(noisy);
    expect(d.startsWith(REGISTER_ERROR_HEAD)).toBe(true);
    expect(d.length).toBeLessThanOrEqual(MEMBER_ERROR_DETAIL_MAX + 60);
    expect(d).toMatch(/more chars truncated\]$/);
  });

  it('PowerShell members get every member-bound command via -EncodedCommand', async () => {
    const agent = makeTestAgent({ os: 'windows', llmProvider: 'claude', workFolder: 'C:\\repo' });
    const raw: string[] = [];
    const world = newWorld();
    const d = deps(world);
    const exec = d.exec;
    d.exec = async (a, c, t) => { raw.push(c); return exec(a, c, t); };
    d.resolveHome = async () => 'C:\\Users\\bella';
    await probeMemberFleetMcp(agent, d);
    const reg = raw.find(c => text(c).includes("'register-member'"))!;
    expect(reg.startsWith('powershell -EncodedCommand ')).toBe(true);
    expect(text(reg)).toContain("& 'C:\\Users\\bella\\.apra-fleet\\bin\\apra-fleet.exe' 'register-member'");
  });
});

describe('agy and local members', () => {
  it('agy -> unavailable(no-per-project-mcp), flagged unverified, nothing probed', async () => {
    const world = newWorld();
    const s = await probeMemberFleetMcp(makeTestAgent({ llmProvider: 'agy' }), deps(world));
    expect(s).toMatchObject({ state: 'unavailable', reason: 'no-per-project-mcp', unverified: true });
    // Only the bd probe runs: agy roles still run bd on the member.
    expect(world.execLog.filter(c => !c.includes('command -v bd'))).toEqual([]);
  });

  it('local member gets its status from a direct MEMBER session with no install attempted', async () => {
    const world = newWorld();
    const agent = makeTestLocalAgent({ llmProvider: 'claude' });
    const calls: string[] = [];
    let closed = false;
    const s = await probeMemberFleetMcp(agent, deps(world, {
      connect: async id => {
        calls.push(`connect:${id}`);
        return {
          mcpClient: {
            callTool: async name => { calls.push(`call:${name}`); return { content: [{ type: 'text', text: 'apra-fleet v0.4.4_abc123' }] }; },
            listTools: async () => { calls.push('list'); return { tools: [{ name: 'kb_query' }, { name: 'code_graph' }] }; },
          },
          close: async () => { closed = true; },
        };
      },
    }));
    expect(s).toEqual({ state: 'available', version: 'v0.4.4_abc123', checkedAt: expect.any(String) });
    expect(calls).toEqual([`connect:${agent.id}`, 'call:version', 'list']);
    expect(closed).toBe(true);
    expect(world.execLog).toEqual([]);
    expect(world.transfers).toBe(0);
  });

  it('a local member the server refuses (403) is unavailable(member-session-failed)', async () => {
    const s = await probeMemberFleetMcp(makeTestLocalAgent(), deps(newWorld(), {
      connect: async () => { throw Object.assign(new Error('Forbidden'), { status: 403 }); },
    }));
    expect(s).toMatchObject({ state: 'unavailable', reason: 'member-session-failed' });
  });
});

// apra-fleet-b4g.73: a requested install that failed is reported with its own
// reason and detail, never masked by a later step run against the old install.
describe('a failed member install is reported as such', () => {
  const OLD = 'v0.4.3';

  it('installer killed (exit 143): install-failed with the installer detail, old version recorded, no register into the stale install', async () => {
    const agent = remoteClaude();
    const world = newWorld({ installed: OLD, installer: 'killed', register: 'long-error' });
    world.claudeJson = entryFor(agent);
    const s = await refreshMemberFleetMcp(agent, deps(world), { install: true });
    expect(s).toMatchObject({ state: 'unavailable', reason: 'install-failed', version: OLD });
    expect(s.detail).toContain('installer exited 143');
    expect(s.detail).toContain('Terminated');
    expect(s.detail).toContain(`still has apra-fleet ${OLD}, which was not used`);
    expect(world.execLog.some(c => c.includes("'register-member'"))).toBe(false);
    expect(world.recorded).toEqual([s]);
  });

  it('installer exits 0 but the member still reports the old version: install-unverified, not a later step error', async () => {
    const agent = remoteClaude();
    const world = newWorld({ installed: OLD, installer: 'no-upgrade', register: 'long-error' });
    world.claudeJson = entryFor(agent);
    const s = await probeMemberFleetMcp(agent, deps(world), { install: true });
    expect(s).toMatchObject({ state: 'unavailable', reason: 'install-unverified', version: OLD });
    expect(s.detail).toContain(`reports ${OLD}`);
    expect(s.detail).toContain('which was not used');
    expect(world.execLog.some(c => c.includes("'register-member'"))).toBe(false);
  });

  it('a failure with no prior install keeps the plain install reason and detail', async () => {
    const agent = remoteClaude();
    const world = newWorld({ installed: null, installer: 'killed' });
    const s = await probeMemberFleetMcp(agent, deps(world), { install: true });
    expect(s).toMatchObject({ state: 'unavailable', reason: 'install-failed' });
    expect(s).not.toHaveProperty('version');
    expect(s.detail).toContain('installer exited 143');
    expect(s.detail).not.toContain('which was not used');
  });

  it('download-timeout over an OLD marked install: the member stays usable on it, registered, and the status names the failed upgrade', async () => {
    const agent = remoteClaude();
    const world = newWorld({ installed: OLD, releaseAsset: 'timeout' });
    world.claudeJson = entryFor(agent);
    const s = await refreshMemberFleetMcp(agent, deps(world), { install: true });
    expect(s).toMatchObject({ state: 'available', version: OLD, installFailure: { reason: 'download-timeout' } });
    expect(s.detail).toContain('upgrade on the member failed (download-timeout');
    expect(s.detail).toContain(`older apra-fleet ${OLD} install is in use`);
    expect(world.execLog.some(c => c.includes("'register-member'"))).toBe(true);
    expect(world.transfers).toBe(0);
    // Visible, not silent: the fix line is shown even though the status is available.
    expect(fleetMcpFixLine(s)).toContain('release host');
  });

  it('transfer-failed over an OLD marked install: registered on the old install; a later register failure still names the failed upgrade', async () => {
    const agent = remoteClaude();
    const okWorld = newWorld({ installed: OLD, transferFails: true });
    okWorld.claudeJson = entryFor(agent);
    const ok = await probeMemberFleetMcp(agent, deps(okWorld), { install: true });
    expect(ok).toMatchObject({ state: 'available', version: OLD, installFailure: { reason: 'transfer-failed' } });
    expect(ok.detail).toContain('No space left on device');
    expect(okWorld.execLog.some(c => c.includes("'register-member'"))).toBe(true);

    const badWorld = newWorld({ installed: OLD, transferFails: true, register: 'long-error' });
    badWorld.claudeJson = entryFor(agent);
    const bad = await probeMemberFleetMcp(agent, deps(badWorld), { install: true });
    expect(bad).toMatchObject({ state: 'unavailable', reason: 'register-failed', version: OLD, installFailure: { reason: 'transfer-failed' } });
    expect(bad.detail).toContain('register-member exited 1');
    expect(bad.detail).toContain('upgrade on the member failed (transfer-failed');
  });

  it('an unmarked OLD install with a download failure still stops at full-install-running, never registered', async () => {
    const agent = remoteClaude();
    const world = newWorld({ installed: OLD, marker: false, releaseAsset: 'timeout' });
    world.claudeJson = entryFor(agent);
    const s = await probeMemberFleetMcp(agent, deps(world), { install: true });
    expect(s).toMatchObject({ state: 'unavailable', reason: 'full-install-running' });
    expect(world.execLog.some(c => c.includes("'register-member'"))).toBe(false);
  });

  it('a provider-change forced install that fails before touching the member still fails closed', async () => {
    const agent = remoteClaude();
    const world = newWorld({ installed: OLD, transferFails: true });
    world.claudeJson = entryFor(agent);
    const s = await probeMemberFleetMcp(agent, deps(world), { install: true, forceInstall: true });
    expect(s).toMatchObject({ state: 'unavailable', reason: 'transfer-failed', version: OLD });
    expect(world.execLog.some(c => c.includes("'register-member'"))).toBe(false);
  });

  it('a successful upgrade from the old version still registers and verifies', async () => {
    const agent = remoteClaude();
    const world = newWorld({ installed: OLD, installer: 'ok' });
    world.claudeJson = entryFor(agent);
    const s = await probeMemberFleetMcp(agent, deps(world), { install: true });
    expect(s).toMatchObject({ state: 'available', version: VERSION });
    expect(world.execLog.some(c => c.includes("'register-member'"))).toBe(true);
  });
});

describe('fleetMcp status is an observation, never sticky', () => {
  beforeEach(() => backupAndResetRegistry());
  afterEach(() => restoreRegistry());

  it('flips unavailable -> available on the next probe after a manual fix', async () => {
    const agent = remoteClaude();
    const world = newWorld({ listTools: ['version'] });
    const d = deps(world);
    const first = await refreshMemberFleetMcp(agent, d);
    expect(first).toMatchObject({ state: 'unavailable', reason: 'member-tools-missing' });

    world.listTools = newWorld().listTools; // the manual fix: member install upgraded
    const second = await refreshMemberFleetMcp(agent, d);
    expect(second).toMatchObject({ state: 'available', version: VERSION });
    expect(second).not.toHaveProperty('reason');
    expect(world.recorded.map(r => r.state)).toEqual(['unavailable', 'available']);
    expect(second.checkedAt > first.checkedAt).toBe(true);
  });

  it('the default recorder writes the status onto the member registry entry and overwrites it', async () => {
    const agent = remoteClaude();
    addAgent(agent);
    const world = newWorld({ listTools: ['version'] });
    const d = { ...deps(world), record: defaultMemberFleetMcpDeps().record };
    await refreshMemberFleetMcp(agent, d);
    expect(getAgent(agent.id)?.fleetMcp).toMatchObject({ state: 'unavailable', reason: 'member-tools-missing' });
    world.listTools = newWorld().listTools;
    await refreshMemberFleetMcp(agent, d);
    expect(getAgent(agent.id)?.fleetMcp).toEqual({ state: 'available', version: VERSION, checkedAt: expect.any(String), port: 7523, portSource: 'marker' });
  });

  it('recordFleetMcpStatus on an unknown id is a no-op', () => {
    expect(recordFleetMcpStatus('nope', { state: 'available', checkedAt: 'x' })).toBeUndefined();
  });
});

describe('remove the member registration on its own install', () => {
  it('runs remove-member --id <uuid> with the member binary', async () => {
    const agent = remoteClaude();
    const world = newWorld();
    const r = await removeMemberFromOwnInstall(agent, deps(world));
    expect(r).toEqual({ removed: true, detail: expect.any(String) });
    expect(world.execLog).toContain(`'${HOME}/.apra-fleet/bin/apra-fleet' 'remove-member' '--id' '${agent.id}' '--force'`);
  });

  it('a member with no install has nothing to remove; a local member runs nothing', async () => {
    const world = newWorld({ installed: null });
    expect(await removeMemberFromOwnInstall(remoteClaude(), deps(world))).toMatchObject({ removed: false });
    expect(world.execLog.some(c => c.includes('remove-member'))).toBe(false);
    const w2 = newWorld();
    expect(await removeMemberFromOwnInstall(makeTestLocalAgent(), deps(w2))).toMatchObject({ removed: false });
    expect(w2.execLog).toEqual([]);
  });

  it('an install without the remove-member verb is install-too-old', async () => {
    const world = newWorld();
    const d = deps(world);
    const exec = d.exec;
    d.exec = async (a, c, t) => (text(c).includes("'remove-member'")
      ? { stdout: '', stderr: "Error: unknown option 'remove-member'", code: 1 }
      : exec(a, c, t));
    expect(await removeMemberFromOwnInstall(remoteClaude(), d)).toMatchObject({ removed: false, reason: 'install-too-old' });
  });
});

describe('apra-fleet remove-member CLI', () => {
  beforeEach(() => backupAndResetRegistry());
  afterEach(() => { restoreRegistry(); process.exitCode = undefined; });

  it('an unregistered id is an idempotent success', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runRemoveMember(['--id', '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b']);
    expect(process.exitCode).toBeUndefined();
    expect(log.mock.calls.flat().join('\n')).toContain('E-NOT-REGISTERED');
    log.mockRestore();
  });

  it('rejects a missing or malformed id', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runRemoveMember(['--id', 'not-a-uuid']);
    expect(process.exitCode).toBe(1);
    err.mockRestore();
  });
});
