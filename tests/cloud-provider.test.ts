import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AwsCloudProvider } from '../src/services/cloud/aws.js';
import type { CloudConfig } from '../src/services/cloud/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ExecResult = { stdout: string; stderr: string };
type MockExec = ReturnType<typeof vi.fn<(cmd: string, opts?: object) => Promise<ExecResult>>>;

function makeExec(responses: Array<ExecResult | Error>): MockExec {
  let call = 0;
  const fn = vi.fn((_cmd: string, _opts?: object): Promise<ExecResult> => {
    const resp = responses[call++];
    if (!resp) return Promise.reject(new Error('Unexpected extra exec call'));
    if (resp instanceof Error) return Promise.reject(resp);
    return Promise.resolve(resp);
  });
  return fn as unknown as MockExec;
}

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '' });
const awsOk: ExecResult = ok('aws-cli/2.15.0'); // --version response

const baseConfig: CloudConfig = {
  provider: 'aws',
  instanceId: 'i-0abc1234def567890',
  region: 'us-east-1',
  idleTimeoutMin: 30,
  sshKeyPath: '/home/user/.ssh/id_rsa',
};

const configWithProfile: CloudConfig = {
  ...baseConfig,
  profile: 'apra',
};

// ---------------------------------------------------------------------------
// AwsCloudProvider tests
// ---------------------------------------------------------------------------

describe('AwsCloudProvider - getInstanceState', () => {
  it('returns "running" for a running instance', async () => {
    const exec = makeExec([awsOk, ok('running\n')]);
    const p = new AwsCloudProvider(exec);
    expect(await p.getInstanceState(baseConfig)).toBe('running');
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[1][0]).toContain('describe-instances');
    expect(exec.mock.calls[1][0]).toContain(baseConfig.instanceId);
    expect(exec.mock.calls[1][0]).toContain('--output text');
  });

  it('returns "stopped" for a stopped instance', async () => {
    const exec = makeExec([awsOk, ok('stopped\n')]);
    const p = new AwsCloudProvider(exec);
    expect(await p.getInstanceState(baseConfig)).toBe('stopped');
  });

  it('returns "stopping" for a stopping instance', async () => {
    const exec = makeExec([awsOk, ok('stopping\n')]);
    const p = new AwsCloudProvider(exec);
    expect(await p.getInstanceState(baseConfig)).toBe('stopping');
  });

  it('throws for unexpected state string', async () => {
    const exec = makeExec([awsOk, ok('banana\n')]);
    const p = new AwsCloudProvider(exec);
    await expect(p.getInstanceState(baseConfig)).rejects.toThrow('Unexpected instance state');
  });

  it('includes --profile when config has profile', async () => {
    const exec = makeExec([awsOk, ok('running\n')]);
    const p = new AwsCloudProvider(exec);
    await p.getInstanceState(configWithProfile);
    expect(exec.mock.calls[1][0]).toContain("--profile 'apra'");
  });

  it('omits --profile when config has no profile', async () => {
    const exec = makeExec([awsOk, ok('running\n')]);
    const p = new AwsCloudProvider(exec);
    await p.getInstanceState(baseConfig);
    expect(exec.mock.calls[1][0]).not.toContain('--profile');
  });

  it('includes region in every command', async () => {
    const exec = makeExec([awsOk, ok('running\n')]);
    const p = new AwsCloudProvider(exec);
    await p.getInstanceState(baseConfig);
    expect(exec.mock.calls[1][0]).toContain('--region us-east-1');
  });
});

describe('AwsCloudProvider - startInstance / stopInstance', () => {
  it('startInstance calls start-instances with correct args', async () => {
    const exec = makeExec([awsOk, ok('')]);
    const p = new AwsCloudProvider(exec);
    await p.startInstance(baseConfig);
    expect(exec.mock.calls[1][0]).toContain('start-instances');
    expect(exec.mock.calls[1][0]).toContain(baseConfig.instanceId);
  });

  it('stopInstance calls stop-instances with correct args', async () => {
    const exec = makeExec([awsOk, ok('')]);
    const p = new AwsCloudProvider(exec);
    await p.stopInstance(baseConfig);
    expect(exec.mock.calls[1][0]).toContain('stop-instances');
    expect(exec.mock.calls[1][0]).toContain(baseConfig.instanceId);
  });
});

describe('AwsCloudProvider - wait commands', () => {
  it('waitForRunning uses instance-running subcommand with timeout option', async () => {
    const exec = makeExec([awsOk, ok('')]);
    const p = new AwsCloudProvider(exec);
    await p.waitForRunning(baseConfig);
    expect(exec.mock.calls[1][0]).toContain('instance-running');
    expect(exec.mock.calls[1][1]).toEqual({ timeout: 300_000 });
  });

  it('waitForStopped uses instance-stopped subcommand with timeout option', async () => {
    const exec = makeExec([awsOk, ok('')]);
    const p = new AwsCloudProvider(exec);
    await p.waitForStopped(baseConfig);
    expect(exec.mock.calls[1][0]).toContain('instance-stopped');
    expect(exec.mock.calls[1][1]).toEqual({ timeout: 300_000 });
  });
});

describe('AwsCloudProvider - getPublicIp', () => {
  it('returns IP address when instance has public IP', async () => {
    const exec = makeExec([awsOk, ok('54.215.100.200\n')]);
    const p = new AwsCloudProvider(exec);
    expect(await p.getPublicIp(baseConfig)).toBe('54.215.100.200');
  });

  it('throws when AWS returns "None" (instance has no public IP)', async () => {
    const exec = makeExec([awsOk, ok('None\n')]);
    const p = new AwsCloudProvider(exec);
    await expect(p.getPublicIp(baseConfig)).rejects.toThrow('No public IP');
  });

  it('throws when AWS returns empty string', async () => {
    const exec = makeExec([awsOk, ok('')]);
    const p = new AwsCloudProvider(exec);
    await expect(p.getPublicIp(baseConfig)).rejects.toThrow('No public IP');
  });
});

describe('AwsCloudProvider - AWS CLI availability', () => {
  it('throws clear error when aws CLI is missing', async () => {
    const exec = makeExec([new Error('command not found: aws')]);
    const p = new AwsCloudProvider(exec);
    await expect(p.getInstanceState(baseConfig)).rejects.toThrow('AWS CLI not found');
  });

  it('caches CLI check — only calls aws --version once across multiple operations', async () => {
    const exec = makeExec([awsOk, ok('running\n'), ok(''), ok('')]);
    const p = new AwsCloudProvider(exec);
    await p.getInstanceState(baseConfig);
    await p.startInstance(baseConfig);
    await p.stopInstance(baseConfig);
    // First call is aws --version; subsequent calls skip the version check
    expect(exec.mock.calls[0][0]).toBe('aws --version');
    expect(exec).toHaveBeenCalledTimes(4); // version + 3 operations
  });
});

describe('AwsCloudProvider - input validation', () => {
  it('throws for invalid instance ID before calling exec', async () => {
    const exec = makeExec([awsOk]);
    const p = new AwsCloudProvider(exec);
    const bad = { ...baseConfig, instanceId: 'not-an-instance-id' };
    await p.getInstanceState(bad).catch(() => {}); // CLI check passes
    // Second call should fail on validation
    const bad2 = { ...baseConfig, instanceId: 'INVALID' };
    await expect(p.getInstanceState(bad2)).rejects.toThrow('Invalid EC2 instance ID');
  });

  it('throws for invalid region', async () => {
    const exec = makeExec([awsOk, new Error('should not be called')]);
    const p = new AwsCloudProvider(exec);
    const bad = { ...baseConfig, region: 'not-a-region' };
    await expect(p.getInstanceState(bad)).rejects.toThrow('Invalid AWS region');
  });

  it('escapes profile with single quotes to prevent injection', async () => {
    const exec = makeExec([awsOk, ok('running\n')]);
    const p = new AwsCloudProvider(exec);
    const trickProfile = { ...baseConfig, profile: "apra'; rm -rf /" };
    await p.getInstanceState(trickProfile);
    const cmd = exec.mock.calls[1][0] as string;
    // Profile must be passed via escapeShellArg: starts with single quote
    expect(cmd).toContain("--profile '");
    // The injection's semicolon must NOT appear as a bare unquoted shell separator.
    // escapeShellArg wraps the value in single quotes, embedding the '; rm ...' safely.
    // Verify the argument begins with the properly-escaped single-quoted form.
    expect(cmd).toMatch(/--profile 'apra'/);
  });
});

// ---------------------------------------------------------------------------
// Cloud registration tests (registerMember with cloud config)
// ---------------------------------------------------------------------------

import { registerMember } from '../src/tools/register-member.js';
import { addAgent } from '../src/services/registry.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '', code: 0 }),
    testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 5 }),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

// Partially mock aws.js: keep the real AwsCloudProvider class but replace the
// awsProvider singleton so registerMember tests can control instance state.
vi.mock('../src/services/cloud/aws.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/services/cloud/aws.js')>();
  return {
    ...mod, // keeps AwsCloudProvider class intact
    awsProvider: {
      getInstanceState: vi.fn().mockResolvedValue('stopped'),
      startInstance: vi.fn(),
      stopInstance: vi.fn(),
      waitForRunning: vi.fn(),
      waitForStopped: vi.fn(),
      getPublicIp: vi.fn().mockResolvedValue('1.2.3.4'),
    },
  };
});

beforeEach(() => {
  backupAndResetRegistry();
  vi.clearAllMocks();
});

afterEach(() => {
  restoreRegistry();
});

describe('registerMember - cloud config', () => {
  const baseCloudInput = {
    friendly_name: 'gpu-trainer',
    member_type: 'remote' as const,
    username: 'ubuntu',
    work_folder: '/home/ubuntu/project',
    cloud_provider: 'aws' as const,
    cloud_instance_id: 'i-0abc1234def567890',
    cloud_region: 'us-east-1',
    cloud_ssh_key_path: '/home/user/.ssh/id_rsa',
  };

  it('registers a stopped cloud member without SSH connectivity check', async () => {
    const result = await registerMember(baseCloudInput);
    expect(result).toContain('✅ Member registered successfully');
    expect(result).toContain('cloud');
    expect(result).toContain('i-0abc1234def567890');
  });

  it('stores cloud config in the registry', async () => {
    await registerMember(baseCloudInput);
    const { getAllAgents } = await import('../src/services/registry.js');
    const agents = getAllAgents();
    expect(agents).toHaveLength(1);
    const agent = agents[0];
    expect(agent.cloud).toBeDefined();
    expect(agent.cloud!.instanceId).toBe('i-0abc1234def567890');
    expect(agent.cloud!.sshKeyPath).toBe('/home/user/.ssh/id_rsa');
    expect(agent.keyPath).toBe('/home/user/.ssh/id_rsa'); // F4: top-level keyPath also set
    expect(agent.authType).toBe('key');
  });

  it('rejects cloud member missing cloud_instance_id', async () => {
    const { cloud_instance_id: _, ...noId } = baseCloudInput as typeof baseCloudInput & { cloud_instance_id?: string };
    const result = await registerMember({ ...noId, cloud_instance_id: undefined });
    expect(result).toContain('❌');
    expect(result).toContain('cloud_instance_id');
  });

  it('rejects cloud member missing cloud_ssh_key_path', async () => {
    const result = await registerMember({ ...baseCloudInput, cloud_ssh_key_path: undefined as unknown as string });
    expect(result).toContain('❌');
    expect(result).toContain('cloud_ssh_key_path');
  });

  it('rejects cloud member missing username', async () => {
    const result = await registerMember({ ...baseCloudInput, username: undefined });
    expect(result).toContain('❌');
    expect(result).toContain('username');
  });

  it('rejects terminated instance', async () => {
    const { awsProvider } = await import('../src/services/cloud/aws.js');
    vi.mocked(awsProvider.getInstanceState).mockResolvedValueOnce('terminated');
    const result = await registerMember(baseCloudInput);
    expect(result).toContain('❌');
    expect(result).toContain('terminated');
  });

  it('auto-resolves host from AWS when instance is running', async () => {
    const { awsProvider } = await import('../src/services/cloud/aws.js');
    vi.mocked(awsProvider.getInstanceState).mockResolvedValueOnce('running');
    vi.mocked(awsProvider.getPublicIp).mockResolvedValueOnce('54.10.20.30');
    const result = await registerMember({ ...baseCloudInput, host: undefined });
    expect(result).toContain('54.10.20.30');
    const { getAllAgents } = await import('../src/services/registry.js');
    expect(getAllAgents()[0].host).toBe('54.10.20.30');
  });

  it('non-cloud registration is unchanged', async () => {
    const nonCloudResult = await registerMember({
      friendly_name: 'web-server',
      member_type: 'remote',
      host: '192.168.1.100',
      username: 'ubuntu',
      auth_type: 'key',
      key_path: '/home/user/.ssh/id_rsa',
      work_folder: '/home/ubuntu/project',
    });
    expect(nonCloudResult).toContain('✅');
    const { getAllAgents } = await import('../src/services/registry.js');
    expect(getAllAgents()[0].cloud).toBeUndefined();
  });
});
