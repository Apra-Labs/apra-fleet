/**
 * register_member / update_member / remove_member / member_detail wired to the
 * member apra-fleet install + recoverable fleetMcp status, driven end-to-end
 * through the tool handlers with a FAKE member transport (exec / transfer /
 * download / local MEMBER session). No real network, no real member host;
 * registry state lives in the backed-up/restored test registry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { backupAndResetRegistry, restoreRegistry, makeConfigAwareExec, makeTestAgent, makeTestLocalAgent, decodePowerShellEncodedCommand } from './test-helpers.js';
import { registerMember } from '../src/tools/register-member.js';
import { updateMember } from '../src/tools/update-member.js';
import { removeMember } from '../src/tools/remove-member.js';
import { memberDetail } from '../src/tools/member-detail.js';
import { fleetStatus } from '../src/tools/check-status.js';
import { addAgent, getAgent, getAllAgents, recordFleetMcpStatus } from '../src/services/registry.js';
import { __setMemberFleetMcpDeps, NO_INSTALL_SENTINEL, type MemberFleetMcpDeps, type MemberSession } from '../src/services/member-fleet-install.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: mockTestConnection,
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));
vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));
vi.mock('../src/services/sftp.js', () => ({
  uploadContentToHome: vi.fn(async () => ({ success: [], failed: [] })),
}));
vi.mock('../src/cli/install.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/cli/install.js')>();
  return { ...actual, loadAgentAssets: () => [] };
});

const VERSION = 'v0.4.4';
const HOME = '/home/bella';
const WORK = '/home/bella/repo';

interface World {
  installed: string | null;
  register: 'ok' | 'id-rejected' | 'folder-taken';
  /** Per-folder MCP entry present on the member. */
  entry: boolean;
  arch: string;
  orchestrator: { os: 'macos' | 'linux'; arch: string };
  listTools: string[];
  log: string[];
  transfers: number;
  downloads: string[];
  lastId: string;
  probes: number;
}

function newWorld(over: Partial<World> = {}): World {
  return {
    installed: VERSION, register: 'ok', entry: true, arch: 'x86_64', orchestrator: { os: 'linux', arch: 'x64' },
    listTools: ['version', 'kb_query', 'kb_capture', 'code_query', 'code_context'],
    log: [], transfers: 0, downloads: [], lastId: '', probes: 0, ...over,
  };
}

const plain = (cmd: string): string => (cmd.includes('-EncodedCommand') ? decodePowerShellEncodedCommand(cmd) : cmd);

function fakeDeps(world: World, local?: () => Promise<MemberSession>, home = HOME): MemberFleetMcpDeps {
  const ok = (stdout: string): SSHExecResult => ({ stdout, stderr: '', code: 0 });
  let tick = 0;
  return {
    exec: async (agent, command) => {
      const c = plain(command);
      world.log.push(c);
      world.lastId = agent.id;
      if (c.includes("'register-member'")) {
        world.probes++;
        if (world.register === 'id-rejected') return { stdout: '', stderr: `Error: Unknown or unexpected argument "--id".`, code: 1 };
        if (world.register === 'folder-taken') return { stdout: '', stderr: 'E-FOLDER-TAKEN: folder registered to another member', code: 1 };
        return ok('registered');
      }
      if (c.includes("'remove-member'")) return ok('removed');
      if (c.includes("'call'") && c.includes("'--list-tools'")) return ok(JSON.stringify({ tools: world.listTools.map(name => ({ name })) }));
      if (c.includes("'call'") && c.includes("'version'")) return ok(JSON.stringify({ content: [{ type: 'text', text: `apra-fleet ${world.installed}` }] }));
      if (c.includes('--version')) return ok(world.installed ? `apra-fleet ${world.installed}\n` : `${NO_INSTALL_SENTINEL}\n`);
      if (c.includes('uname -m')) return ok(world.arch);
      if (c.includes("'install'")) { world.installed = VERSION; return ok('installed'); }
      if (c.includes('CLAUDE_CONFIG_DIR')) return ok('');
      if (c.includes('cat "') && c.includes('.claude.json')) {
        return ok(world.entry
          ? JSON.stringify({ projects: { [WORK]: { mcpServers: { 'apra-fleet': { type: 'http', url: `http://localhost:7523/mcp?member=${agent.id}` } } } } })
          : '');
      }
      return { stdout: '', stderr: `unexpected: ${c}`, code: 127 };
    },
    transfer: async (_a, localPaths) => { world.transfers++; return { success: localPaths, failed: [] }; },
    resolveHome: async () => home,
    orchestratorPlatform: () => world.orchestrator,
    orchestratorExecutable: () => '/opt/fleet/apra-fleet',
    orchestratorVersion: () => VERSION,
    downloadReleaseAsset: async (url) => { world.downloads.push(url); return '/tmp/fake-release-asset'; },
    removeLocal: () => {},
    connectLocalMember: local ?? (async () => { throw new Error('no local session expected'); }),
    now: () => new Date(Date.UTC(2026, 9, 1, 12, 0, tick++)),
    record: (id, status) => { recordFleetMcpStatus(id, status); },
  };
}

const withRealRecord = (d: MemberFleetMcpDeps): MemberFleetMcpDeps => d;

const REMOTE = {
  member_type: 'remote' as const,
  host: '192.168.1.120',
  username: 'bella',
  work_folder: WORK,
  auth_type: 'password' as const,
  password: 'pw',
};

function installCmds(w: World): string[] { return w.log.filter(c => c.includes("'install'")); }
function registerCmds(w: World): string[] { return w.log.filter(c => c.includes("'register-member'")); }

beforeEach(() => {
  backupAndResetRegistry();
  vi.clearAllMocks();
  mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
  mockExecCommand.mockImplementation(makeConfigAwareExec());
});

afterEach(() => {
  __setMemberFleetMcpDeps(null);
  restoreRegistry();
});

function remoteMember(over: Record<string, unknown> = {}) {
  const a = makeTestAgent({ os: 'linux', llmProvider: 'claude', workFolder: WORK, friendlyName: 'bella', ...over });
  addAgent(a);
  return a;
}

describe('register_member fleet_install', () => {
  it('auto installs on a member with no apra-fleet (same-OS copy), with member-mode flags, and reports fleetMcp available', async () => {
    const w = newWorld({ installed: null });
    __setMemberFleetMcpDeps(withRealRecord(fakeDeps(w)));
    const result = await registerMember({ ...REMOTE, friendly_name: 'bella', llm_provider: 'claude', fleet_install: 'auto', port: 22, cloud_region: 'us-east-1', cloud_idle_timeout_min: 30 } as any);
    expect(result).toContain('Member registered successfully');
    expect(result).toContain(`fleetMcp: available (apra-fleet ${VERSION})`);
    expect(w.transfers).toBe(1);
    expect(w.downloads).toEqual([]);
    const inst = installCmds(w);
    expect(inst).toHaveLength(1);
    for (const f of ["'--llm' 'claude'", "'--member'", "'--workflows' 'none'", "'--transport' 'http'"]) expect(inst[0]).toContain(f);
    expect(getAllAgents()[0].fleetMcp).toMatchObject({ state: 'available', version: VERSION });
  });

  it('cross-OS member (different arch) gets the release asset, not the orchestrator binary', async () => {
    const w = newWorld({ installed: null, orchestrator: { os: 'macos', arch: 'arm64' } });
    __setMemberFleetMcpDeps(withRealRecord(fakeDeps(w)));
    const result = await registerMember({ ...REMOTE, friendly_name: 'bella', fleet_install: 'auto', port: 22, cloud_region: 'us-east-1', cloud_idle_timeout_min: 30 } as any);
    expect(result).toContain('Member registered successfully');
    expect(w.downloads).toHaveLength(1);
    expect(w.downloads[0]).toContain('/releases/download/');
    expect(w.downloads[0]).toContain(VERSION);
  });

  it('unsupported platform -> unavailable(unsupported-platform) and registration still succeeds', async () => {
    const w = newWorld({ installed: null, arch: 'riscv64' });
    __setMemberFleetMcpDeps(withRealRecord(fakeDeps(w)));
    const result = await registerMember({ ...REMOTE, friendly_name: 'bella', fleet_install: 'auto', port: 22, cloud_region: 'us-east-1', cloud_idle_timeout_min: 30 } as any);
    expect(result).toContain('Member registered successfully');
    expect(result).toContain('fleetMcp: unavailable (');
    expect(getAllAgents()[0].fleetMcp).toMatchObject({ state: 'unavailable' });
    expect(w.transfers).toBe(0);
  });

  it('fleet_install: skip performs no install and reports the probe result only', async () => {
    const w = newWorld({ installed: null });
    __setMemberFleetMcpDeps(withRealRecord(fakeDeps(w)));
    const result = await registerMember({ ...REMOTE, friendly_name: 'bella', fleet_install: 'skip', port: 22, cloud_region: 'us-east-1', cloud_idle_timeout_min: 30 } as any);
    expect(result).toContain('Member registered successfully');
    expect(result).toContain('fleetMcp: unavailable (install-unverified)');
    expect(w.transfers).toBe(0);
    expect(installCmds(w)).toEqual([]);
  });

  it('an unavailable fleetMcp never fails register_member: --id rejected -> install-too-old', async () => {
    const w = newWorld({ register: 'id-rejected' });
    __setMemberFleetMcpDeps(withRealRecord(fakeDeps(w)));
    const result = await registerMember({ ...REMOTE, friendly_name: 'bella', fleet_install: 'auto', port: 22, cloud_region: 'us-east-1', cloud_idle_timeout_min: 30 } as any);
    expect(result).toContain('Member registered successfully');
    expect(result).toContain('fleetMcp: unavailable (install-too-old)');
    expect(getAllAgents()).toHaveLength(1);
  });

  it('E-FOLDER-TAKEN on the member is carried as the fleetMcp reason', async () => {
    const w = newWorld({ register: 'folder-taken' });
    __setMemberFleetMcpDeps(withRealRecord(fakeDeps(w)));
    const result = await registerMember({ ...REMOTE, friendly_name: 'bella', fleet_install: 'auto', port: 22, cloud_region: 'us-east-1', cloud_idle_timeout_min: 30 } as any);
    expect(result).toContain('Member registered successfully');
    expect(result).toContain('fleetMcp: unavailable (E-FOLDER-TAKEN)');
  });

  it('a missing per-folder MCP entry -> unavailable(mcp-entry-missing)', async () => {
    const w = newWorld({ entry: false });
    __setMemberFleetMcpDeps(withRealRecord(fakeDeps(w)));
    const result = await registerMember({ ...REMOTE, friendly_name: 'bella', fleet_install: 'auto', port: 22, cloud_region: 'us-east-1', cloud_idle_timeout_min: 30 } as any);
    expect(result).toContain('Member registered successfully');
    expect(result).toContain('fleetMcp: unavailable (mcp-entry-missing)');
  });

  it('agy member -> unavailable(no-per-project-mcp), unverified; nothing installed', async () => {
    const w = newWorld();
    __setMemberFleetMcpDeps(withRealRecord(fakeDeps(w)));
    const a = remoteMember({ llmProvider: 'agy' });
    const r = JSON.parse(await memberDetail({ member_id: a.id, format: 'json', refresh: true }));
    expect(r.fleetMcp).toMatchObject({ state: 'unavailable', reason: 'no-per-project-mcp', unverified: true });
    expect(installCmds(w)).toEqual([]);
  });

  it('local member: a direct MEMBER session is used, nothing is installed or exec\'d on a member host', async () => {
    const w = newWorld();
    const connect = vi.fn(async (): Promise<MemberSession> => ({
      mcpClient: {
        callTool: async () => ({ content: [{ type: 'text', text: `apra-fleet ${VERSION}` }] }),
        listTools: async () => ({ tools: w.listTools.map(name => ({ name })) }),
      },
      close: async () => {},
    }));
    __setMemberFleetMcpDeps(withRealRecord(fakeDeps(w, connect)));
    const dir = makeTestLocalAgent().workFolder;
    const fs = await import('node:fs');
    fs.mkdirSync(dir, { recursive: true });
    try {
      const result = await registerMember({ friendly_name: 'loc', member_type: 'local', work_folder: dir, llm_provider: 'claude', fleet_install: 'auto', port: 22, cloud_region: 'us-east-1', cloud_idle_timeout_min: 30 } as any);
      expect(result).toContain('Member registered successfully');
      expect(result).toContain('fleetMcp: available');
      expect(connect).toHaveBeenCalledTimes(1);
      expect(w.log).toEqual([]);
      expect(w.transfers).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('recoverable: unavailable -> available on re-probe, no restart', () => {
  it('member_detail refresh:true flips the recorded status after the cause is fixed', async () => {
    const w = newWorld({ entry: false });
    __setMemberFleetMcpDeps(withRealRecord(fakeDeps(w)));
    const a = remoteMember();
    const first = JSON.parse(await memberDetail({ member_id: a.id, format: 'json', refresh: true }));
    expect(first.fleetMcp).toMatchObject({ state: 'unavailable', reason: 'mcp-entry-missing' });
    expect(getAgent(a.id)!.fleetMcp).toMatchObject({ state: 'unavailable' });
    w.entry = true; // operator fixes the member
    const second = JSON.parse(await memberDetail({ member_id: a.id, format: 'json', refresh: true }));
    expect(second.fleetMcp).toMatchObject({ state: 'available', version: VERSION });
    expect(getAgent(a.id)!.fleetMcp).toMatchObject({ state: 'available' });
  });
});

describe('member_detail refresh', () => {
  it('refresh:true probes exactly once and returns the new status', async () => {
    const w = newWorld();
    __setMemberFleetMcpDeps(withRealRecord(fakeDeps(w)));
    const a = remoteMember();
    const r = JSON.parse(await memberDetail({ member_id: a.id, format: 'json', refresh: true }));
    expect(w.probes).toBe(1);
    expect(r.fleetMcp).toMatchObject({ state: 'available', version: VERSION });
    expect(installCmds(w)).toEqual([]); // refresh never installs
  });

  it('without refresh returns the recorded status and never probes', async () => {
    const w = newWorld();
    __setMemberFleetMcpDeps(withRealRecord(fakeDeps(w)));
    const recorded = { state: 'unavailable' as const, reason: 'install-too-old', checkedAt: '2026-10-01T00:00:00.000Z' };
    const a = remoteMember({ fleetMcp: recorded });
    const r = JSON.parse(await memberDetail({ member_id: a.id, format: 'json' }));
    expect(r.fleetMcp).toEqual(recorded);
    expect(w.log.filter(c => c.includes("'register-member'") || c.includes("'call'") || c.includes('--version'))).toEqual([]);
    expect(w.probes).toBe(0);
  });

  it('fleet_status never probes', async () => {
    const w = newWorld();
    __setMemberFleetMcpDeps(withRealRecord(fakeDeps(w)));
    remoteMember({ fleetMcp: { state: 'available', checkedAt: '2026-10-01T00:00:00.000Z' } });
    await fleetStatus({ format: 'json' } as any);
    expect(w.log).toEqual([]);
    expect(w.probes).toBe(0);
  });
});

describe('update_member', () => {
  it('a provider change re-runs the install with --llm <new provider>', async () => {
    const w = newWorld(); // already current: only a FORCED install re-runs
    __setMemberFleetMcpDeps(withRealRecord(fakeDeps(w)));
    const a = remoteMember({ llmProvider: 'claude' });
    const result = await updateMember({ member_id: a.id, llm_provider: 'opencode' } as any);
    expect(result).toContain('updated');
    const inst = installCmds(w);
    expect(inst).toHaveLength(1);
    expect(inst[0]).toContain("'--llm' 'opencode'");
    expect(w.transfers).toBe(1);
  });

  it('a new name re-runs register-member --id on the member, without reinstalling', async () => {
    const w = newWorld();
    __setMemberFleetMcpDeps(withRealRecord(fakeDeps(w)));
    const a = remoteMember();
    await updateMember({ member_id: a.id, friendly_name: 'bella2' } as any);
    const regs = registerCmds(w);
    expect(regs).toHaveLength(1);
    expect(regs[0]).toContain(`'--id' '${a.id}'`);
    expect(regs[0]).toContain("'--name' 'bella2'");
    expect(installCmds(w)).toEqual([]);
  });

  it('a new work folder re-runs register-member --id with the new --path', async () => {
    const w = newWorld();
    __setMemberFleetMcpDeps(withRealRecord(fakeDeps(w)));
    const a = remoteMember();
    await updateMember({ member_id: a.id, work_folder: '/home/bella/repo2' } as any);
    const regs = registerCmds(w);
    expect(regs).toHaveLength(1);
    expect(regs[0]).toContain(`'--id' '${a.id}'`);
    expect(regs[0]).toContain("'--path' '/home/bella/repo2'");
  });

  it('an update that changes neither provider, name nor folder runs no member-side command', async () => {
    const w = newWorld();
    __setMemberFleetMcpDeps(withRealRecord(fakeDeps(w)));
    const a = remoteMember();
    await updateMember({ member_id: a.id, category: 'doers' } as any);
    expect(w.log).toEqual([]);
  });
});

describe('PowerShell members', () => {
  it('the version probe on a Windows PowerShell member tests $LASTEXITCODE', async () => {
    const w = newWorld();
    __setMemberFleetMcpDeps(withRealRecord(fakeDeps(w, undefined, 'C:\\Users\\bella')));
    const a = remoteMember({ os: 'windows', shell: 'powershell5', workFolder: 'C:\\Users\\bella\\repo' });
    await memberDetail({ member_id: a.id, format: 'json', refresh: true });
    const probe = w.log.find(c => c.includes('--version'))!;
    expect(probe).toBeDefined();
    expect(probe).toContain('LASTEXITCODE');
  });
});

describe('remove_member', () => {
  it('runs remove-member --id on the member\'s own install', async () => {
    const w = newWorld();
    __setMemberFleetMcpDeps(withRealRecord(fakeDeps(w)));
    const a = remoteMember();
    const result = await removeMember({ member_id: a.id, force: false });
    expect(result).toContain('has been removed');
    const rm = w.log.filter(c => c.includes("'remove-member'"));
    expect(rm).toHaveLength(1);
    expect(rm[0]).toContain(`'--id' '${a.id}'`);
    expect(getAgent(a.id)).toBeUndefined();
  });

  it('a failing member-side remove is reported as a warning, never silent, and the member is still removed', async () => {
    const w = newWorld();
    const d = withRealRecord(fakeDeps(w));
    const baseExec = d.exec;
    d.exec = async (agent, command, t) => {
      if (plain(command).includes("'remove-member'")) return { stdout: '', stderr: 'boom', code: 2 };
      return baseExec(agent, command, t);
    };
    __setMemberFleetMcpDeps(d);
    const a = remoteMember();
    const result = await removeMember({ member_id: a.id, force: false });
    expect(result).toContain('has been removed');
    expect(result).toContain('remove-failed');
    expect(getAgent(a.id)).toBeUndefined();
  });
});
