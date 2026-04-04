import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent, SSHExecResult } from '../src/types.js';

const { mockExecCommand, mockGetStrategy, mockGpuProcessCheck, mockFleetProcessCheck } = vi.hoisted(() => {
  const gpuProcessCheck = vi.fn<() => string>(() => 'gpu-check-cmd');
  const fleetProcessCheck = vi.fn<(folder: string) => string>(() => 'fleet-check-cmd');
  return {
    mockExecCommand: vi.fn<(cmd: string, timeoutMs?: number) => Promise<SSHExecResult>>(),
    mockGetStrategy: vi.fn(),
    mockGpuProcessCheck: gpuProcessCheck,
    mockFleetProcessCheck: fleetProcessCheck,
  };
});

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: mockGetStrategy,
}));

vi.mock('../src/os/index.js', () => ({
  getOsCommands: () => ({
    gpuProcessCheck: mockGpuProcessCheck,
    gpuUtilization: vi.fn(() => 'gpu-util-cmd'),
    fleetProcessCheck: mockFleetProcessCheck,
  }),
}));

// agent-helpers only used for getAgentOS — stub it
vi.mock('../src/utils/agent-helpers.js', () => ({
  getAgentOS: () => 'linux',
  setIdleTouchHook: vi.fn(),
  touchAgent: vi.fn(),
}));

import { checkMemberActivity } from '../src/services/cloud/activity.js';

const baseAgent: Agent = {
  id: 'test-id',
  friendlyName: 'test-agent',
  agentType: 'remote',
  host: '1.2.3.4',
  port: 22,
  username: 'ubuntu',
  workFolder: '/home/ubuntu/work',
  os: 'linux',
  icon: '🤖',
  createdAt: '2026-01-01T00:00:00.000Z',
  cloud: { instanceId: 'i-12345678', region: 'us-east-1' },
};

function sshResult(stdout: string, code = 0): SSHExecResult {
  return { stdout, stderr: '', code };
}

describe('checkMemberActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStrategy.mockReturnValue({ execCommand: mockExecCommand });
    mockGpuProcessCheck.mockReturnValue('gpu-check-cmd');
    mockFleetProcessCheck.mockReturnValue('fleet-check-cmd');
  });

  it('returns busy-gpu when GPU compute processes are running', async () => {
    mockExecCommand.mockResolvedValueOnce(sshResult('busy')); // gpuProcessCheck
    const result = await checkMemberActivity(baseAgent);
    expect(result).toBe('busy-gpu');
    expect(mockExecCommand).toHaveBeenCalledTimes(1);
  });

  it('skips GPU check when nvidia-smi not installed (exit 2) and falls through', async () => {
    mockExecCommand.mockResolvedValueOnce(sshResult('', 2)); // gpuProcessCheck: not available
    mockExecCommand.mockResolvedValueOnce(sshResult('idle'));  // fleetProcessCheck
    const result = await checkMemberActivity(baseAgent);
    expect(result).toBe('idle');
  });

  it('skips GPU check when it returns other non-zero exit', async () => {
    mockExecCommand.mockResolvedValueOnce(sshResult('error', 1)); // gpuProcessCheck: error
    mockExecCommand.mockResolvedValueOnce(sshResult('idle'));       // fleetProcessCheck
    const result = await checkMemberActivity(baseAgent);
    expect(result).toBe('idle');
  });

  it('returns busy-process when fleet process is running', async () => {
    mockExecCommand.mockResolvedValueOnce(sshResult('idle'));        // gpuProcessCheck
    mockExecCommand.mockResolvedValueOnce(sshResult('fleet-busy')); // fleetProcessCheck
    const result = await checkMemberActivity(baseAgent);
    expect(result).toBe('busy-process');
  });

  it('returns busy-process for other-busy process', async () => {
    mockExecCommand.mockResolvedValueOnce(sshResult('', 2));         // gpuProcessCheck: skip
    mockExecCommand.mockResolvedValueOnce(sshResult('other-busy')); // fleetProcessCheck
    const result = await checkMemberActivity(baseAgent);
    expect(result).toBe('busy-process');
  });

  it('returns idle when all checks show no activity', async () => {
    mockExecCommand.mockResolvedValueOnce(sshResult('idle')); // gpuProcessCheck
    mockExecCommand.mockResolvedValueOnce(sshResult('idle')); // fleetProcessCheck
    const result = await checkMemberActivity(baseAgent);
    expect(result).toBe('idle');
  });

  it('returns unknown when getStrategy throws', async () => {
    mockGetStrategy.mockImplementation(() => { throw new Error('no strategy'); });
    const result = await checkMemberActivity(baseAgent);
    expect(result).toBe('unknown');
  });

  it('returns unknown when process check SSH call throws', async () => {
    mockExecCommand.mockResolvedValueOnce(sshResult('', 2));         // gpuProcessCheck: skip
    mockExecCommand.mockRejectedValueOnce(new Error('SSH timeout')); // fleetProcessCheck
    const result = await checkMemberActivity(baseAgent);
    expect(result).toBe('unknown');
  });

  it('continues to process check when GPU check SSH call throws', async () => {
    mockExecCommand.mockRejectedValueOnce(new Error('SSH error')); // gpuProcessCheck throws
    mockExecCommand.mockResolvedValueOnce(sshResult('idle'));       // fleetProcessCheck
    const result = await checkMemberActivity(baseAgent);
    expect(result).toBe('idle');
  });

  it('treats unrecognised GPU output defensively (continues to process check)', async () => {
    mockExecCommand.mockResolvedValueOnce(sshResult('NVSMI LOG', 0)); // unexpected output
    mockExecCommand.mockResolvedValueOnce(sshResult('idle'));          // fleetProcessCheck
    const result = await checkMemberActivity(baseAgent);
    expect(result).toBe('idle');
  });
});

describe('checkMemberActivity - custom activityCommand (U4)', () => {
  const agentWithCmd: Agent = {
    ...baseAgent,
    cloud: {
      ...baseAgent.cloud!,
      activityCommand: 'check-workload.sh',
    } as any,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetStrategy.mockReturnValue({ execCommand: mockExecCommand });
    mockGpuProcessCheck.mockReturnValue('gpu-check-cmd');
    mockFleetProcessCheck.mockReturnValue('fleet-check-cmd');
  });

  it('returns busy-process when activityCommand outputs "busy"', async () => {
    mockExecCommand.mockResolvedValueOnce(sshResult('', 2));    // gpuProcessCheck: skip
    mockExecCommand.mockResolvedValueOnce(sshResult('busy'));   // activityCommand: busy
    const result = await checkMemberActivity(agentWithCmd);
    expect(result).toBe('busy-process');
    // Should not reach process check
    expect(mockExecCommand).toHaveBeenCalledTimes(2);
  });

  it('falls through to process check when activityCommand returns "idle"', async () => {
    mockExecCommand.mockResolvedValueOnce(sshResult('', 2));    // gpuProcessCheck: skip
    mockExecCommand.mockResolvedValueOnce(sshResult('idle'));   // activityCommand: idle
    mockExecCommand.mockResolvedValueOnce(sshResult('idle'));   // fleetProcessCheck
    const result = await checkMemberActivity(agentWithCmd);
    expect(result).toBe('idle');
  });

  it('falls through to process check when activityCommand fails (defensive)', async () => {
    mockExecCommand.mockResolvedValueOnce(sshResult('', 2));              // gpuProcessCheck: skip
    mockExecCommand.mockRejectedValueOnce(new Error('command timeout')); // activityCommand throws
    mockExecCommand.mockResolvedValueOnce(sshResult('idle'));             // fleetProcessCheck
    const result = await checkMemberActivity(agentWithCmd);
    expect(result).toBe('idle');
  });

  it('falls through when activityCommand returns non-zero exit', async () => {
    mockExecCommand.mockResolvedValueOnce(sshResult('', 2));      // gpuProcessCheck: skip
    mockExecCommand.mockResolvedValueOnce(sshResult('', 1));      // activityCommand: error exit
    mockExecCommand.mockResolvedValueOnce(sshResult('idle'));      // fleetProcessCheck
    const result = await checkMemberActivity(agentWithCmd);
    expect(result).toBe('idle');
  });

  it('skips activityCommand when agent has no cloud config', async () => {
    const noCloudAgent: Agent = { ...baseAgent, cloud: undefined };
    mockExecCommand.mockResolvedValueOnce(sshResult('', 2));    // gpuProcessCheck: skip
    mockExecCommand.mockResolvedValueOnce(sshResult('idle'));   // fleetProcessCheck (no activity cmd)
    const result = await checkMemberActivity(noCloudAgent);
    expect(result).toBe('idle');
    expect(mockExecCommand).toHaveBeenCalledTimes(2);
  });
});
