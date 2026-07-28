/**
 * Extends register_member coverage for agent-provisioner integration:
 * remote members should get role-agent files pushed when connectivity is
 * confirmed; provisioning failure must not block registration; unreachable
 * cloud members skip with a warning telling the operator to retry via
 * update_member.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { registerMember } from '../src/tools/register-member.js';
import { ClaudeProvider } from '../src/providers/claude.js';
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
}));

const mockGetInstanceState = vi.fn();
vi.mock('../src/services/cloud/aws.js', () => ({
  awsProvider: {
    getInstanceState: (...args: any[]) => mockGetInstanceState(...args),
    getPublicIp: vi.fn(),
  },
}));

const mockUploadContentToHome = vi.fn();
vi.mock('../src/services/sftp.js', () => ({
  uploadContentToHome: (...args: any[]) => mockUploadContentToHome(...args),
}));

const FAKE_AGENT_ASSETS = [
  { relPath: 'planner.md', content: 'planner body' },
  { relPath: 'doer.md', content: 'doer body' },
];
vi.mock('../src/cli/install.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/cli/install.js')>();
  return {
    ...actual,
    loadAgentAssets: () => FAKE_AGENT_ASSETS,
  };
});

describe('register_member: agent provisioning integration', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    // Generic execCommand fallback for OS detect / CLI checks / mkdir.
    mockExecCommand.mockResolvedValue({ stdout: 'Linux', stderr: '', code: 0 });
    mockUploadContentToHome.mockResolvedValue({ success: [], failed: [] });
    mockGetInstanceState.mockResolvedValue('running');
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('provisions agent files for a reachable remote member and reports the count', async () => {
    // Remote agents dir is empty -> both canonical files are pushed.
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd.includes('find . -type f')) return { stdout: '', stderr: '', code: 0 };
      return { stdout: 'Linux', stderr: '', code: 0 };
    });
    mockUploadContentToHome.mockResolvedValue({ success: ['planner.md', 'doer.md'], failed: [] });

    const result = await registerMember({
      friendly_name: 'prov-test',
      member_type: 'remote',
      host: '192.168.1.110',
      username: 'akhil',
      work_folder: '~/git/prov-test',
      auth_type: 'password',
      password: 'pw',
    });

    expect(result).toContain('Member registered successfully');
    expect(result).toContain('Agents:  2 file(s) provisioned');
    expect(mockUploadContentToHome).toHaveBeenCalledTimes(1);
  });

  it('appends a warning but still registers the member when provisioning (probe) fails', async () => {
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd.includes('find . -type f')) return { stdout: '', stderr: 'boom', code: 1 };
      return { stdout: 'Linux', stderr: '', code: 0 };
    });

    const result = await registerMember({
      friendly_name: 'prov-fail-test',
      member_type: 'remote',
      host: '192.168.1.111',
      username: 'akhil',
      work_folder: '~/git/prov-fail-test',
      auth_type: 'password',
      password: 'pw',
    });

    expect(result).toContain('Member registered successfully');
    expect(result).toContain('Could not verify remote agent files');
    expect(mockUploadContentToHome).not.toHaveBeenCalled();
  });

  it('warns to run update_member for a stopped/unreachable cloud member and skips provisioning', async () => {
    mockGetInstanceState.mockResolvedValue('stopped');

    const result = await registerMember({
      friendly_name: 'cloud-stopped-test',
      member_type: 'remote',
      host: '192.168.1.112',
      username: 'akhil',
      work_folder: '~/git/cloud-test',
      auth_type: 'key',
      key_path: '~/.ssh/id_rsa',
      cloud_provider: 'aws',
      cloud_instance_id: 'i-0123456789abcdef0',
      cloud_region: 'us-east-1',
      cloud_state: 'stopped',
    } as any);

    expect(result).toContain('Agent files not provisioned -- run update_member after the instance starts.');
    expect(result).toContain('Workspace trust not seeded -- run update_member after the instance starts.');
    expect(mockUploadContentToHome).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// apra-fleet-eft.40.2 -- ensureWorkspaceTrusted invoked from register_member
// ---------------------------------------------------------------------------

describe('register_member: invokes ensureWorkspaceTrusted (apra-fleet-eft.40.2)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockTestConnection.mockResolvedValue({ ok: true, latencyMs: 5 });
    mockExecCommand.mockResolvedValue({ stdout: 'Linux', stderr: '', code: 0 });
    mockUploadContentToHome.mockResolvedValue({ success: [], failed: [] });
    mockGetInstanceState.mockResolvedValue('running');
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('calls ensureWorkspaceTrusted with the resolved work_folder for a reachable remote Claude member', async () => {
    const spy = vi.spyOn(ClaudeProvider.prototype, 'ensureWorkspaceTrusted');

    const result = await registerMember({
      friendly_name: 'trust-reg-test',
      member_type: 'remote',
      host: '192.168.1.120',
      username: 'akhil',
      work_folder: '~/git/trust-reg-test',
      auth_type: 'password',
      password: 'pw',
    });

    expect(result).toContain('Member registered successfully');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('~/git/trust-reg-test', expect.any(Function), 'linux');
    spy.mockRestore();
  });

  it('does not throw and still registers the member when ensureWorkspaceTrusted fails (non-fatal)', async () => {
    const spy = vi.spyOn(ClaudeProvider.prototype, 'ensureWorkspaceTrusted').mockRejectedValue(new Error('boom'));

    const result = await registerMember({
      friendly_name: 'trust-fail-test',
      member_type: 'remote',
      host: '192.168.1.121',
      username: 'akhil',
      work_folder: '~/git/trust-fail-test',
      auth_type: 'password',
      password: 'pw',
    });

    expect(result).toContain('Member registered successfully');
    spy.mockRestore();
  });
});
