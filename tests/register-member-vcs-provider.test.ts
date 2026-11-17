/**
 * Wiring pins for register_member's VCS-provider detection (apra-fleet-5oo).
 *
 * Before this, a member could be fully registered with llm_provider 'claude'
 * (i.e. fully dispatch-capable) while Agent.vcsProvider stayed unset -- nothing
 * in registration ever asked for or detected it -- and the gap only surfaced
 * reactively, hours into an unattended sprint, as fleet-sprint's
 * "member has no registered VCS provider" throw on the first push/PR.
 *
 * Everything runs against a faked AgentStrategy (same approach as
 * register-member-shell-probe.test.ts), so the suite is OS-independent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { registerMember } from '../src/tools/register-member.js';
import { getAllAgents } from '../src/services/registry.js';
import { LinuxCommands } from '../src/os/index.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();
const mockTestConnection = vi.fn();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: mockTestConnection,
    transferFiles: vi.fn(),
    receiveFiles: vi.fn(),
    deleteFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
}));

// compose_permissions writes (and reads back) a settings file ON THE MEMBER via
// the strategy above; against a fake strategy that read-back can never succeed,
// and register_member correctly refuses to report success when it fails. That
// axis is already covered by register-member.test.ts -- stub it to a success
// here so these cases test the VCS-provider axis alone. The literal is written
// as an escape so this source file stays ASCII (repo convention).
vi.mock('../src/tools/compose-permissions.js', () => ({
  composePermissions: vi.fn(async () => '\u2705 Permissions composed (test stub).'),
}));

// Provisioning role-agent files and seeding workspace trust are separate,
// already-covered SSH round trips that a fake strategy makes slow and
// meaningless here.
vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn(async () => ({ pushed: [], skipped: [], warning: undefined })),
}));
vi.mock('../src/utils/workspace-trust.js', () => ({
  seedWorkspaceTrust: vi.fn(async () => undefined),
}));

const FOLDER = '/srv/work';
const REMOTE_CMD = new LinuxCommands().gitRemoteOrigin(FOLDER);

/** A healthy Linux member whose `origin` remote reads back as `remote`
 *  (pass null for "no git repo here yet" -- empty output, the common
 *  register-before-clone case). */
function useFakeMember(remote: string | null) {
  mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
  mockExecCommand.mockImplementation(async (cmd: string) => {
    if (cmd === 'uname -s') return { stdout: 'Linux', stderr: '', code: 0 };
    if (cmd === REMOTE_CMD) return { stdout: remote ?? '', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
}

function sentCommands(): string[] {
  return mockExecCommand.mock.calls.map(c => c[0]);
}

function registeredProvider(name: string): string | undefined {
  const agent = getAllAgents().find(a => a.friendlyName === name);
  expect(agent, `member ${name} was not registered`).toBeTruthy();
  return agent!.vcsProvider;
}

const WARNING = /VCS provider could not be determined/;

const base = {
  member_type: 'remote',
  host: '10.0.0.5',
  username: 'dev',
  auth_type: 'password',
  password: 'x',
  work_folder: FOLDER,
};

describe('register_member: VCS-provider detection (apra-fleet-5oo)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('an explicit vcs_provider is honored and suppresses the remote probe entirely', async () => {
    useFakeMember('https://github.com/acme/widgets.git');
    const result = await registerMember({
      ...base, friendly_name: 'explicit-azdo', vcs_provider: 'azure-devops',
    } as never);

    expect(result).toContain('registered successfully');
    // The explicit value wins over what the remote would have said.
    expect(registeredProvider('explicit-azdo')).toBe('azure-devops');
    expect(sentCommands()).not.toContain(REMOTE_CMD);
    expect(result).toContain('VCS Provider: azure-devops');
    expect(result).not.toContain('(auto-detected from origin)');
    expect(result).not.toMatch(WARNING);
  });

  it('auto-detects the provider from the git origin remote and reports it as auto-detected', async () => {
    useFakeMember('https://github.com/acme/widgets.git');
    const result = await registerMember({ ...base, friendly_name: 'auto-gh' } as never);

    expect(result).toContain('registered successfully');
    expect(registeredProvider('auto-gh')).toBe('github');
    expect(sentCommands()).toContain(REMOTE_CMD);
    expect(result).toContain('VCS Provider: github (auto-detected from origin)');
    expect(result).not.toMatch(WARNING);
  });

  it('auto-detects azure-devops from an scp-like ssh remote', async () => {
    useFakeMember('git@ssh.dev.azure.com:v3/org/project/repo');
    const result = await registerMember({ ...base, friendly_name: 'auto-azdo' } as never);

    expect(registeredProvider('auto-azdo')).toBe('azure-devops');
    expect(result).toContain('VCS Provider: azure-devops (auto-detected from origin)');
  });

  it('no git remote yet + default llm_provider (claude): registration SUCCEEDS but warns loudly', async () => {
    useFakeMember(null);
    const result = await registerMember({ ...base, friendly_name: 'no-remote' } as never);

    expect(result).toContain('registered successfully');
    expect(registeredProvider('no-remote')).toBeUndefined();
    expect(result).toMatch(WARNING);
    expect(result).toContain('UNABLE to push or open a PR');
    expect(result).not.toContain('VCS Provider:');
  });

  it('an unrecognized remote host also warns rather than guessing a provider', async () => {
    useFakeMember('https://gitlab.com/group/repo.git');
    const result = await registerMember({
      ...base, friendly_name: 'gitlab-remote', llm_provider: 'claude',
    } as never);

    expect(result).toContain('registered successfully');
    expect(registeredProvider('gitlab-remote')).toBeUndefined();
    expect(result).toMatch(WARNING);
  });

  it('a failing remote probe never sinks the registration', async () => {
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd === 'uname -s') return { stdout: 'Linux', stderr: '', code: 0 };
      if (cmd === REMOTE_CMD) throw new Error('connection reset');
      return { stdout: '', stderr: '', code: 0 };
    });

    const result = await registerMember({ ...base, friendly_name: 'broken-probe' } as never);

    expect(result).toContain('registered successfully');
    expect(registeredProvider('broken-probe')).toBeUndefined();
    expect(result).toMatch(WARNING);
  });

  it('llm_provider "none" never triggers the warning -- it never dispatches and never pushes', async () => {
    useFakeMember(null);
    const result = await registerMember({
      ...base, friendly_name: 'no-llm', llm_provider: 'none',
    } as never);

    expect(result).toContain('registered successfully');
    expect(result).not.toMatch(WARNING);
  });

  it('an explicit vcs_provider "none" records no provider, suppresses the warning, and says so', async () => {
    useFakeMember(null);
    const result = await registerMember({
      ...base, friendly_name: 'declared-none', vcs_provider: 'none',
    } as never);

    expect(result).toContain('registered successfully');
    expect(registeredProvider('declared-none')).toBeUndefined();
    expect(sentCommands()).not.toContain(REMOTE_CMD);
    expect(result).not.toMatch(WARNING);
    expect(result).toContain('VCS Provider: none (declared explicitly');
  });
});
