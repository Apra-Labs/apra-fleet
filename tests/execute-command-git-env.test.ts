// execute_command registers the member's own git credential helpers for the
// command through its environment (src/services/vcs-git-env.ts): every git the
// command starts -- including bd/dolt's -- finds them, with no git config file
// written. Mocked strategy; no real member.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executeCommand } from '../src/tools/execute-command.js';
import type { Agent, SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
    transferFiles: vi.fn(),
    writeSecretFile: vi.fn(),
    removeSecretFile: vi.fn(),
    close: vi.fn(),
  }),
}));

const scoped: Partial<Agent> = {
  vcsCredentials: {
    'github-issues': { provider: 'github', scopeUrl: 'https://github.com', memberScoped: true },
    github: { provider: 'github', scopeUrl: 'https://github.com', memberScoped: true },
  },
};

describe('execute_command: git credential environment', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
  });
  afterEach(() => restoreRegistry());

  it('POSIX member: the command is prefixed with its GIT_CONFIG_PARAMETERS (provider-named label first)', async () => {
    const member = makeTestAgent({ friendlyName: 'posix', os: 'linux', ...scoped });
    addAgent(member);
    await executeCommand({ member_id: member.id, command: 'bd dolt push', timeout_s: 5 });
    const sent = String(mockExecCommand.mock.calls[0][0]);
    expect(sent.startsWith('_fleet_gh=$(')).toBe(true);
    expect(sent).toContain('; export GIT_CONFIG_PARAMETERS="\'credential.https://github.com.helper=\' ');
    expect(sent.indexOf(`.fleet-git-credential-github.${member.id}`)).toBeLessThan(sent.indexOf(`.fleet-git-credential-github-issues.${member.id}`));
    expect(sent).toContain('bd dolt push');
    expect(sent).not.toContain('git config');
  });

  it('PowerShell member: the PowerShell form of the same registration', async () => {
    const member = makeTestAgent({ friendlyName: 'pwsh', os: 'windows', shell: 'powershell5', ...scoped });
    addAgent(member);
    await executeCommand({ member_id: member.id, command: 'bd dolt push', timeout_s: 5 });
    const sent = String(mockExecCommand.mock.calls[0][0]);
    expect(sent.startsWith('$fleetGitH = ')).toBe(true);
    expect(sent).toContain('; $env:GIT_CONFIG_PARAMETERS = ');
    expect(sent).toContain(`.fleet-git-credential-github.${member.id}.bat`);
  });

  it('a member with no member-scoped credential gets no prefix', async () => {
    const member = makeTestAgent({ friendlyName: 'none', os: 'linux', vcsProvider: 'github', vcsCredentialLabel: 'github' });
    addAgent(member);
    await executeCommand({ member_id: member.id, command: 'git status', timeout_s: 5 });
    expect(String(mockExecCommand.mock.calls[0][0])).not.toContain('GIT_CONFIG_PARAMETERS');
  });

  it('long-running POSIX task: the registration is inside the detached wrapper script', async () => {
    const member = makeTestAgent({ friendlyName: 'long', os: 'linux', ...scoped });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: '12345\n', stderr: '', code: 0 });
    await executeCommand({ member_id: member.id, command: 'bd dolt push', long_running: true, timeout_s: 5 });
    const launch = String(mockExecCommand.mock.calls[0][0]);
    const b64 = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(launch)?.[1];
    expect(b64).toBeDefined();
    const script = Buffer.from(b64!, 'base64').toString('utf-8');
    // The wrapper base64-encodes the command once more (MAIN_CMD).
    const mainB64 = /MAIN_CMD=\$\(printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d\)/.exec(script)?.[1];
    expect(mainB64).toBeDefined();
    const mainCmd = Buffer.from(mainB64!, 'base64').toString('utf-8');
    expect(mainCmd.startsWith('_fleet_gh=$(')).toBe(true);
    expect(mainCmd).toContain('; export GIT_CONFIG_PARAMETERS=');
    expect(mainCmd).toContain(`.fleet-git-credential-github.${member.id}`);
    expect(mainCmd.endsWith('bd dolt push')).toBe(true);
  });
});
