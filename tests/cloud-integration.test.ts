/**
 * T12: Cloud lifecycle integration tests.
 *
 * Covers the full end-to-end flows with mocked AWS CLI + SSH:
 *   1. Full lifecycle: stopped agent → execute_command → ensureCloudReady starts it → SSH runs
 *   2. Idle auto-stop: idle past timeout → idleManager.checkOnce → stopInstance called
 *   3. Long-running task launch: execute_command with long_running=true → nohup wrapper
 *   4. monitor_task: SSH returns completed status.json → auto_stop → stopInstance called
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import type { Agent } from '../src/types.js';
import type { SSHExecResult } from '../src/types.js';

// ---------------------------------------------------------------------------
// Hoisted mock references
// ---------------------------------------------------------------------------

const {
  mockEnsureCloudReady,
  mockExecCommand,
  mockGetInstanceState,
  mockStartInstance,
  mockStopInstance,
  mockGetInstanceDetails,
  mockGetAllAgents,
  mockCheckMemberActivity,
  mockSetIdleTouchHook,
} = vi.hoisted(() => ({
  mockEnsureCloudReady: vi.fn<(agent: any) => Promise<any>>((a) => Promise.resolve(a)),
  mockExecCommand: vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>(),
  mockGetInstanceState: vi.fn(),
  mockStartInstance: vi.fn(),
  mockStopInstance: vi.fn(),
  mockGetInstanceDetails: vi.fn(),
  mockGetAllAgents: vi.fn<() => Agent[]>(() => []),
  mockCheckMemberActivity: vi.fn(),
  mockSetIdleTouchHook: vi.fn<(fn: (id: string) => void) => void>(),
}));

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 5 }),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/cloud/lifecycle.js', () => ({
  ensureCloudReady: mockEnsureCloudReady,
}));

vi.mock('../src/services/cloud/aws.js', () => ({
  awsProvider: {
    getInstanceState: mockGetInstanceState,
    startInstance: mockStartInstance,
    stopInstance: mockStopInstance,
    getInstanceDetails: mockGetInstanceDetails,
    getPublicIp: vi.fn(),
    waitForRunning: vi.fn(),
    waitForStopped: vi.fn(),
  },
}));

vi.mock('../src/services/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/registry.js')>();
  return {
    ...actual,
    getAllAgents: mockGetAllAgents,
  };
});

vi.mock('../src/services/cloud/activity.js', () => ({
  checkMemberActivity: mockCheckMemberActivity,
}));

vi.mock('../src/utils/agent-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/agent-helpers.js')>();
  return {
    ...actual,
    setIdleTouchHook: mockSetIdleTouchHook,
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCloudAgent(overrides: Partial<Agent> = {}): Agent {
  return makeTestAgent({
    host: '10.0.0.1',
    lastUsed: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
    cloud: {
      provider: 'aws' as const,
      instanceId: 'i-0abc1234def567890',
      region: 'us-east-1',
      idleTimeoutMin: 1,
      sshKeyPath: '/home/user/.ssh/key.pem',
    },
    ...overrides,
  });
}

beforeEach(() => {
  backupAndResetRegistry();
  vi.clearAllMocks();
  mockEnsureCloudReady.mockImplementation((a) => Promise.resolve(a));
  mockExecCommand.mockResolvedValue({ stdout: 'ok', stderr: '', code: 0 });
  mockGetInstanceState.mockResolvedValue('stopped');
  mockStartInstance.mockResolvedValue(undefined);
  mockStopInstance.mockResolvedValue(undefined);
  mockGetAllAgents.mockReturnValue([]);
  mockCheckMemberActivity.mockResolvedValue('idle');
});

afterEach(() => {
  restoreRegistry();
});

// ---------------------------------------------------------------------------
// Test 1: Full lifecycle — stopped agent auto-starts via ensureCloudReady
// ---------------------------------------------------------------------------

describe('Cloud lifecycle: execute_command auto-start', () => {
  it('calls ensureCloudReady which starts the instance, then runs the SSH command', async () => {
    const { executeCommand } = await import('../src/tools/execute-command.js');
    const agent = makeCloudAgent({ host: '10.0.0.1' });
    addAgent(agent);

    // ensureCloudReady simulates starting instance and returning updated IP
    const startedAgent = { ...agent, host: '54.10.20.30' };
    mockEnsureCloudReady.mockResolvedValueOnce(startedAgent);

    await executeCommand({ member_id: agent.id, command: 'echo hello', timeout_ms: 5000 });

    // ensureCloudReady was called (this is where startInstance happens in real code)
    expect(mockEnsureCloudReady).toHaveBeenCalledOnce();
    expect(mockEnsureCloudReady).toHaveBeenCalledWith(expect.objectContaining({ id: agent.id }));
    // SSH command was executed after start
    expect(mockExecCommand).toHaveBeenCalledOnce();
  });

  it('returns error string if ensureCloudReady fails (terminated instance)', async () => {
    const { executeCommand } = await import('../src/tools/execute-command.js');
    const agent = makeCloudAgent();
    addAgent(agent);
    mockEnsureCloudReady.mockRejectedValueOnce(new Error('Instance i-0abc is terminated'));

    const result = await executeCommand({ member_id: agent.id, command: 'ls', timeout_ms: 5000 });

    expect(result).toContain('Instance i-0abc is terminated');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 2: Idle auto-stop — idle manager stops instance after timeout
// ---------------------------------------------------------------------------

describe('Cloud lifecycle: idle auto-stop', () => {
  it('stops a cloud agent that has been idle past its idleTimeoutMin', async () => {
    const { IdleManager } = await import('../src/services/cloud/idle-manager.js');
    const agent = makeCloudAgent(); // lastUsed 2h ago, idleTimeoutMin=1

    mockGetAllAgents.mockReturnValue([agent]);
    mockGetInstanceState.mockResolvedValue('running');
    mockCheckMemberActivity.mockResolvedValue('idle');
    mockStopInstance.mockResolvedValue(undefined);

    const manager = new IdleManager();
    manager.start(60_000); // global fallback = 1min; per-agent also 1min

    await manager.checkOnce();

    expect(mockGetInstanceState).toHaveBeenCalledWith(agent.cloud);
    expect(mockCheckMemberActivity).toHaveBeenCalledWith(agent);
    expect(mockStopInstance).toHaveBeenCalledWith(agent.cloud);

    manager.stop();
  });

  it('does NOT stop an agent that was recently active (timer reset)', async () => {
    const { IdleManager } = await import('../src/services/cloud/idle-manager.js');
    const agent = makeCloudAgent(); // lastUsed 2h ago

    mockGetAllAgents.mockReturnValue([agent]);
    mockGetInstanceState.mockResolvedValue('running');

    const manager = new IdleManager();
    manager.start(60_000);

    // Reset timer to now — should prevent stop
    manager.resetTimer(agent.id);

    await manager.checkOnce();

    expect(mockStopInstance).not.toHaveBeenCalled();
    manager.stop();
  });
});

// ---------------------------------------------------------------------------
// Test 3: Long-running task launch
// ---------------------------------------------------------------------------

describe('Cloud lifecycle: long_running execute_command', () => {
  it('launches a background task and returns task_id', async () => {
    const { executeCommand } = await import('../src/tools/execute-command.js');
    const agent = makeCloudAgent();
    addAgent(agent);

    const result = await executeCommand({
      member_id: agent.id,
      command: 'python train.py',
      timeout_ms: 5000,
      long_running: true,
      max_retries: 2,
    });

    // Result contains task_id
    expect(result).toMatch(/task_id=task-[0-9a-z]+/);
    expect(result).toContain('monitor_task');

    // SSH command contained nohup and base64 wrapper script
    expect(mockExecCommand).toHaveBeenCalledOnce();
    const cmd = mockExecCommand.mock.calls[0][0] as string;
    expect(cmd).toContain('nohup');
    expect(cmd).toContain('base64 -d');
  });

  it('uses restart_command: wrapper script contains both base64-encoded commands', async () => {
    const { executeCommand } = await import('../src/tools/execute-command.js');
    const { generateTaskWrapper } = await import('../src/services/cloud/task-wrapper.js');
    const agent = makeCloudAgent();
    addAgent(agent);

    const mainCmd = 'python train.py --epochs 100';
    const restartCmd = 'python train.py --resume checkpoint.pt';

    await executeCommand({
      member_id: agent.id,
      command: mainCmd,
      restart_command: restartCmd,
      timeout_ms: 5000,
      long_running: true,
    });

    // Verify generateTaskWrapper produces distinct main+restart b64 strings
    const script = generateTaskWrapper({
      taskId: 'test-task',
      command: mainCmd,
      restartCommand: restartCmd,
      maxRetries: 3,
      activityIntervalSec: 300,
    });
    const mainB64 = Buffer.from(mainCmd).toString('base64');
    const restartB64 = Buffer.from(restartCmd).toString('base64');
    expect(script).toContain(mainB64);
    expect(script).toContain(restartB64);
    // They should differ
    expect(mainB64).not.toBe(restartB64);
  });
});

// ---------------------------------------------------------------------------
// Test 4: monitor_task — completed status → auto_stop
// ---------------------------------------------------------------------------

describe('Cloud lifecycle: monitor_task', () => {
  it('returns completed status and calls stopInstance when auto_stop=true', async () => {
    const { monitorTask } = await import('../src/tools/monitor-task.js');
    const agent = makeCloudAgent();
    addAgent(agent);

    const statusJson = JSON.stringify({
      taskId: 'task-abc123',
      status: 'completed',
      exitCode: 0,
      retries: 0,
      started: '2026-03-18T10:00:00Z',
      updated: '2026-03-18T10:30:00Z',
    });

    // Mock SSH calls: status.json, PID check, GPU util, log tail
    mockExecCommand
      .mockResolvedValueOnce({ stdout: statusJson, stderr: '', code: 0 })  // status.json
      .mockResolvedValueOnce({ stdout: 'dead', stderr: '', code: 0 })       // PID check
      .mockResolvedValueOnce({ stdout: '45', stderr: '', code: 0 })         // GPU util
      .mockResolvedValueOnce({ stdout: 'Training complete.', stderr: '', code: 0 }); // log tail

    const result = await monitorTask({
      member_id: agent.id,
      task_id: 'task-abc123',
      auto_stop: true,
    });

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('completed');
    expect(parsed.exitCode).toBe(0);
    expect(parsed.pidAlive).toBe(false);
    expect(parsed.gpuUtilization).toBe(45);
    expect(parsed.logTail).toBe('Training complete.');
    expect(parsed.autoStopped).toBe(true);

    // stopInstance was called because auto_stop=true and status=completed
    expect(mockStopInstance).toHaveBeenCalledWith(agent.cloud);
  });

  it('does NOT stop instance when task is still running', async () => {
    const { monitorTask } = await import('../src/tools/monitor-task.js');
    const agent = makeCloudAgent();
    addAgent(agent);

    const statusJson = JSON.stringify({
      taskId: 'task-running',
      status: 'running',
      exitCode: null,
      retries: 0,
    });

    mockExecCommand
      .mockResolvedValueOnce({ stdout: statusJson, stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'alive', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '72', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'epoch 15/100', stderr: '', code: 0 });

    const result = await monitorTask({
      member_id: agent.id,
      task_id: 'task-running',
      auto_stop: true, // true but task not done
    });

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe('running');
    expect(parsed.pidAlive).toBe(true);
    expect(parsed.autoStopped).toBeUndefined();

    // stopInstance NOT called because task is not completed/failed
    expect(mockStopInstance).not.toHaveBeenCalled();
  });

  it('returns member not found for unknown member_id', async () => {
    const { monitorTask } = await import('../src/tools/monitor-task.js');

    const result = await monitorTask({
      member_id: 'nonexistent-id',
      task_id: 'task-abc',
    });

    expect(result).toContain('not found');
  });
});
