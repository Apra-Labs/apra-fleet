/**
 * update_member re-composes the member's permission allow-list when a
 * fleet_install run actually installed/upgraded/replaced the member's own
 * apra-fleet install (the old allow-list does not grant the tools the new
 * install serves). compose_permissions itself is mocked: its OS/provider
 * behaviour is covered by its own tests; here only the trigger and the
 * failure reporting are under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { backupAndResetRegistry, restoreRegistry, makeConfigAwareExec, makeTestAgent, makeTestLocalAgent, decodePowerShellEncodedCommand } from './test-helpers.js';
import { updateMember } from '../src/tools/update-member.js';
import { composePermissions } from '../src/tools/compose-permissions.js';
import { addAgent, recordFleetMcpStatus } from '../src/services/registry.js';
import { __setMemberFleetMcpDeps, NO_INSTALL_SENTINEL, type MemberFleetMcpDeps } from '../src/services/member-fleet-install.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn();

vi.mock('../src/tools/compose-permissions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/tools/compose-permissions.js')>()),
  composePermissions: vi.fn(async () => '\u2705 Permissions composed'),
}));
vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: mockTestConnection,
    transferFiles: async (paths: string[]) => ({ success: paths, failed: [] }),
    writeSecretFile: async () => '/home/testuser/.apra-fleet-secret',
    removeSecretFile: async () => undefined,
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

const mockCompose = vi.mocked(composePermissions);
const VERSION = 'v0.4.4';
const WORK = '/home/bella/repo';

interface World { installed: string | null; log: string[] }

const plain = (cmd: string): string => (cmd.includes('-EncodedCommand') ? decodePowerShellEncodedCommand(cmd) : cmd);

/** A fake member: answers the install/version/marker/register probes. */
function fakeDeps(world: World): MemberFleetMcpDeps {
  const ok = (stdout: string): SSHExecResult => ({ stdout, stderr: '', code: 0 });
  let tick = 0;
  return {
    exec: async (agent, command) => {
      const c = plain(command);
      world.log.push(c);
      if (c.includes('member-access.key')) return ok('');
      if (c.includes('member-install.json')) return ok('');
      if (c.includes("'register-member'")) return ok('registered');
      if (c.includes('command -v bd')) return ok('bd version 1.3.0\n');
      if (c.includes("'call'") && c.includes("'--list-tools'")) return ok(JSON.stringify({ tools: [{ name: 'version' }, { name: 'kb_list' }] }));
      if (c.includes("'call'") && c.includes("'version'")) return ok(JSON.stringify({ content: [{ type: 'text', text: `apra-fleet ${world.installed}` }] }));
      if (c.includes('--version')) return ok(world.installed ? `apra-fleet ${world.installed}\n` : `${NO_INSTALL_SENTINEL}\n`);
      if (c.includes('uname -m')) return ok('x86_64');
      if (c.includes("'install'")) { world.installed = VERSION; return ok('installed'); }
      if (c.includes('CLAUDE_CONFIG_DIR')) return ok('');
      if (c.includes('cat "') && c.includes('.claude.json')) {
        return ok(JSON.stringify({ projects: { [WORK]: { mcpServers: { 'apra-fleet': { type: 'http', url: `http://localhost:7523/mcp?member=${agent.id}` } } } } }));
      }
      return { stdout: '', stderr: `unexpected: ${c}`, code: 127 };
    },
    transfer: async (_a, localPaths) => ({ success: localPaths, failed: [] }),
    resolveHome: async () => '/home/bella',
    orchestratorPlatform: () => ({ os: 'linux', arch: 'x64' }),
    orchestratorExecutable: () => '/opt/fleet/apra-fleet',
    orchestratorVersion: () => VERSION,
    downloadReleaseAsset: async () => '/tmp/fake-release-asset',
    removeLocal: () => {},
    connectLocalMember: async () => { throw new Error('no local session expected'); },
    now: () => new Date(Date.UTC(2026, 9, 1, 12, 0, tick++)),
    record: (id, status) => { recordFleetMcpStatus(id, status); },
  };
}

function remoteMember(over: Record<string, unknown> = {}) {
  const a = makeTestAgent({ os: 'linux', llmProvider: 'claude', workFolder: WORK, friendlyName: 'bella', ...over });
  addAgent(a);
  return a;
}

const installs = (w: World) => w.log.filter(c => c.includes("'install'"));

beforeEach(() => {
  backupAndResetRegistry();
  vi.clearAllMocks();
  mockCompose.mockImplementation(async () => '\u2705 Permissions composed');
  mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
  mockExecCommand.mockImplementation(makeConfigAwareExec());
});

afterEach(() => {
  __setMemberFleetMcpDeps(null);
  restoreRegistry();
});

describe('update_member re-composes permissions after a member install/upgrade', () => {
  it.each(['claude', 'opencode'] as const)('fleet_install auto upgrading a %s member re-composes it once (doer + its tags)', async (provider) => {
    const w: World = { installed: 'v0.4.3', log: [] };
    __setMemberFleetMcpDeps(fakeDeps(w));
    const a = remoteMember({ llmProvider: provider, tags: ['reviewer'] });
    const result = await updateMember({ member_id: a.id, fleet_install: 'auto' } as any);
    expect(installs(w)).toHaveLength(1);
    expect(mockCompose).toHaveBeenCalledTimes(1);
    expect(mockCompose).toHaveBeenCalledWith({ member_id: a.id, role: 'doer', tags: ['reviewer'] });
    expect(result).toContain('updated.');
    expect(result).not.toContain('compose_permissions failed');
  });

  it('an up-to-date member (no install happened) is not re-composed', async () => {
    const w: World = { installed: VERSION, log: [] };
    __setMemberFleetMcpDeps(fakeDeps(w));
    const a = remoteMember();
    await updateMember({ member_id: a.id, fleet_install: 'auto' } as any);
    expect(installs(w)).toEqual([]);
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('fleet_install skip never re-composes', async () => {
    const w: World = { installed: 'v0.4.3', log: [] };
    __setMemberFleetMcpDeps(fakeDeps(w));
    const a = remoteMember();
    await updateMember({ member_id: a.id, fleet_install: 'skip' } as any);
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('a local member (no member install) is not re-composed', async () => {
    const w: World = { installed: VERSION, log: [] };
    __setMemberFleetMcpDeps(fakeDeps(w));
    const a = makeTestLocalAgent({ friendlyName: 'loc' });
    addAgent(a);
    await updateMember({ member_id: a.id, fleet_install: 'auto' } as any);
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('a provider switch that also installs composes exactly once', async () => {
    const w: World = { installed: 'v0.4.3', log: [] };
    __setMemberFleetMcpDeps(fakeDeps(w));
    const a = remoteMember();
    await updateMember({ member_id: a.id, llm_provider: 'opencode', fleet_install: 'auto' } as any);
    expect(installs(w)).toHaveLength(1);
    expect(mockCompose).toHaveBeenCalledTimes(1);
  });

  it('a failed re-compose is a WARNING and the update still succeeds', async () => {
    const w: World = { installed: 'v0.4.3', log: [] };
    __setMemberFleetMcpDeps(fakeDeps(w));
    mockCompose.mockImplementationOnce(async () => '\u274C Failed to persist permissions to .claude/settings.local.json on "bella" (claude): disk full');
    const a = remoteMember();
    const result = await updateMember({ member_id: a.id, fleet_install: 'auto' } as any);
    expect(result).toContain('Member "bella" updated.');
    expect(result).toMatch(/WARNING: apra-fleet was installed\/upgraded on the member but compose_permissions failed.*Failed to persist permissions.*disk full/);
  });

  it('a throwing re-compose is a WARNING and the update still succeeds', async () => {
    const w: World = { installed: 'v0.4.3', log: [] };
    __setMemberFleetMcpDeps(fakeDeps(w));
    mockCompose.mockRejectedValueOnce(new Error('ssh dropped'));
    const a = remoteMember();
    const result = await updateMember({ member_id: a.id, fleet_install: 'auto' } as any);
    expect(result).toContain('Member "bella" updated.');
    expect(result).toMatch(/WARNING: .*compose_permissions threw: ssh dropped/);
  });
});
