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
  /** register-member outcome on the member's own install. */
  register: 'ok' | 'id-rejected' | 'folder-taken' | 'unknown-verb' | 'long-error';
  /** ~/.claude.json content on the member. */
  claudeJson: Record<string, unknown> | null;
  listTools: string[];
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
      if (c.includes("'install'")) { world.installed = VERSION; return ok('installed'); }
      if (c.includes('CLAUDE_CONFIG_DIR')) return ok('');
      if (c.includes('cat "') && c.includes('.claude.json')) return ok(world.claudeJson ? JSON.stringify(world.claudeJson) : '');
      return { stdout: '', stderr: `unexpected: ${c}`, code: 127 };
    },
    transfer: async (_a, localPaths) => { world.transfers++; return { success: localPaths, failed: [] }; },
    resolveHome: async () => HOME,
    orchestratorPlatform: () => ({ os: 'linux', arch: 'x64' }),
    orchestratorExecutable: () => '/opt/fleet/apra-fleet',
    orchestratorVersion: () => VERSION,
    downloadReleaseAsset: async () => { throw new Error('not expected'); },
    removeLocal: () => {},
    connectLocalMember: local?.connect ?? (async () => { throw new Error('no local session expected'); }),
    now: () => new Date(Date.UTC(2026, 9, 1, 12, 0, tick++)),
    record: (_id, status) => { world.recorded.push(status); },
  };
}

function newWorld(over: Partial<World> = {}): World {
  return {
    installed: VERSION, register: 'ok', claudeJson: null,
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
    expect(s).toEqual({ state: 'available', version: VERSION, checkedAt: expect.any(String), fleetInstalledAt: expect.any(String) });
    expect(world.transfers).toBe(1); // an install actually ran
    const reg = world.execLog.find(c => c.includes("'register-member'"))!;
    expect(reg).toContain(`'register-member' '--type' 'local' '--id' '${agent.id}' '--name' 'bella' '--path' '${WORK}' '--llm' 'claude'`);
    expect(reg.startsWith(`'${HOME}/.apra-fleet/bin/apra-fleet'`)).toBe(true);
    const ver = world.execLog.find(c => c.includes("'call'") && c.includes("'version'"))!;
    expect(ver).toContain(`'call' '--member' '${agent.id}' 'version' '--args-file'`);
    expect(world.execLog.some(c => c.includes(`'call' '--member' '${agent.id}' '--list-tools'`))).toBe(true);
  });

  it('a session that lists no kb_*/code_* tools is unavailable(member-tools-missing)', async () => {
    const agent = remoteClaude();
    const world = newWorld({ listTools: ['version', 'report_status'] });
    world.claudeJson = entryFor(agent);
    const s = await probeMemberFleetMcp(agent, deps(world));
    expect(s).toMatchObject({ state: 'unavailable', reason: 'member-tools-missing' });
  });

  it('missing per-folder entry -> unavailable(mcp-entry-missing)', async () => {
    const agent = remoteClaude();
    const world = newWorld({ claudeJson: { projects: {} } });
    const s = await probeMemberFleetMcp(agent, deps(world));
    expect(s).toMatchObject({ state: 'unavailable', reason: 'mcp-entry-missing', version: VERSION });
    expect(world.execLog.some(c => c.includes("'call'"))).toBe(false);
  });

  it('a per-folder entry for a different member id is also mcp-entry-missing', async () => {
    const agent = remoteClaude();
    const other = makeTestAgent({ id: '11111111-2222-3333-4444-555555555555' });
    const world = newWorld({ claudeJson: entryFor(other) });
    const s = await probeMemberFleetMcp(agent, deps(world));
    expect(s).toMatchObject({ state: 'unavailable', reason: 'mcp-entry-missing' });
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
    expect(world.execLog).toEqual([]);
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

describe('fleetMcp status is an observation, never sticky', () => {
  beforeEach(() => backupAndResetRegistry());
  afterEach(() => restoreRegistry());

  it('flips unavailable -> available on the next probe after a manual fix', async () => {
    const agent = remoteClaude();
    const world = newWorld({ claudeJson: { projects: {} } });
    const d = deps(world);
    const first = await refreshMemberFleetMcp(agent, d);
    expect(first).toMatchObject({ state: 'unavailable', reason: 'mcp-entry-missing' });

    world.claudeJson = entryFor(agent); // the manual fix: compose_permissions re-run
    const second = await refreshMemberFleetMcp(agent, d);
    expect(second).toMatchObject({ state: 'available', version: VERSION });
    expect(second).not.toHaveProperty('reason');
    expect(world.recorded.map(r => r.state)).toEqual(['unavailable', 'available']);
    expect(second.checkedAt > first.checkedAt).toBe(true);
  });

  it('the default recorder writes the status onto the member registry entry and overwrites it', async () => {
    const agent = remoteClaude();
    addAgent(agent);
    const world = newWorld({ claudeJson: { projects: {} } });
    const d = { ...deps(world), record: defaultMemberFleetMcpDeps().record };
    await refreshMemberFleetMcp(agent, d);
    expect(getAgent(agent.id)?.fleetMcp).toMatchObject({ state: 'unavailable', reason: 'mcp-entry-missing' });
    world.claudeJson = entryFor(agent);
    await refreshMemberFleetMcp(agent, d);
    expect(getAgent(agent.id)?.fleetMcp).toEqual({ state: 'available', version: VERSION, checkedAt: expect.any(String) });
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
