/**
 * Guards apra-fleet-ot2z.4 (execute_command long_running on Windows).
 *
 * Windows members no longer hard-fail long_running=true: the task is
 * launched detached via `Invoke-CimMethod Win32_Process.Create` (WMI
 * provider host / session 0), which survives the SSH session's job object
 * being torn down -- unlike a plain background launch, which dies with the
 * SSH channel on Windows. See src/services/cloud/task-wrapper.ts's
 * generateTaskWrapperWindows() for the PowerShell wrapper this launches and
 * src/tools/monitor-task.ts for the Windows status/pid/log read-back.
 *
 * Mocks the strategy/exec layer -- no real member connection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry, resultText } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executeCommand } from '../src/tools/execute-command.js';
import { getTaskCredentials } from '../src/services/credential-store.js';
import type { SSHExecResult } from '../src/types.js';

const { mockExecCommand } = vi.hoisted(() => ({
  mockExecCommand: vi.fn<(cmd: string, timeout?: number, maxTotalMs?: number, onPidCaptured?: (pid: number) => void) => Promise<SSHExecResult>>(),
}));

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn().mockResolvedValue({ ok: true }),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/cloud/lifecycle.js', () => ({
  ensureCloudReady: vi.fn((member: any) => Promise.resolve(member)),
}));

/**
 * monitor-task.ts / execute-command.ts wrap Windows-bound scripts as
 * `powershell -EncodedCommand <base64 utf16le>` (wrapPowerShellEncoded).
 * Decode back to the underlying script so assertions can inspect it.
 */
function decodeIfEncoded(cmd: string): string {
  const m = cmd.match(/^powershell -EncodedCommand (.+)$/);
  if (!m) return cmd;
  return Buffer.from(m[1], 'base64').toString('utf16le');
}

describe('execute_command long_running: Windows detached CIM launch (guards ot2z.4)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('1. windows + long_running=true: launches via Invoke-CimMethod, "Task launched", no POSIX-shell error', async () => {
    const member = makeTestAgent({ os: 'windows' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: 'TASK_PID:4242\n', stderr: '', code: 0 });

    const result = resultText(await executeCommand({
      member_id: member.id,
      command: 'python train.py',
      long_running: true,
      timeout_s: 5,
    }));

    expect(result).toContain('Task launched');
    expect(result).not.toContain('POSIX shell');
  });

  it('2. windows + long_running=true: dispatches exactly one Win32_Process.Create command, no POSIX tokens', async () => {
    const member = makeTestAgent({ os: 'windows' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: 'TASK_PID:4242\n', stderr: '', code: 0 });

    await executeCommand({
      member_id: member.id,
      command: 'python train.py',
      long_running: true,
      timeout_s: 5,
    });

    expect(mockExecCommand).toHaveBeenCalledTimes(1);
    const raw = mockExecCommand.mock.calls[0][0] as string;
    const decoded = decodeIfEncoded(raw);
    expect(raw).not.toBe(decoded); // must be -EncodedCommand wrapped
    expect(decoded).toContain('Invoke-CimMethod');
    expect(decoded).toContain('Win32_Process');
    expect(decoded).toContain('-MethodName Create');
    expect(decoded).not.toContain('nohup');
    expect(decoded).not.toContain('chmod');
    expect(decoded).not.toContain('2>/dev/null');
  });

  it('3. windows + long_running=true: a task id IS registered in the task-credentials registry (no error path)', async () => {
    const member = makeTestAgent({ os: 'windows' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: 'TASK_PID:4242\n', stderr: '', code: 0 });

    const result = resultText(await executeCommand({
      member_id: member.id,
      command: 'python train.py',
      long_running: true,
      timeout_s: 5,
    }));

    const taskIdMatch = result.match(/task-[a-z0-9]+/);
    expect(taskIdMatch).not.toBeNull();
    // No credentials were used, so the registry entry is empty but present
    // (getTaskCredentials never throws for a registered id with no creds).
    expect(getTaskCredentials(taskIdMatch![0])).toEqual([]);
  });

  it('4. linux + long_running=true: unchanged -- "Task launched" and nohup-bash wrapper dispatch still occur', async () => {
    const member = makeTestAgent({ os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = resultText(await executeCommand({
      member_id: member.id,
      command: 'python train.py',
      long_running: true,
      timeout_s: 5,
    }));

    expect(result).toContain('Task launched');
    expect(mockExecCommand).toHaveBeenCalledTimes(1);
    const calledCmd = mockExecCommand.mock.calls[0][0] as string;
    expect(calledCmd).toContain('nohup bash');
  });

  it('5. darwin + long_running=true: still launches, still carries the non-linux/windows advisory warning', async () => {
    const member = makeTestAgent({ os: 'macos' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = resultText(await executeCommand({
      member_id: member.id,
      command: 'python train.py',
      long_running: true,
      timeout_s: 5,
    }));

    expect(result).toContain('Task launched');
    expect(result).toContain('bash wrapper script designed for Linux');
    expect(mockExecCommand).toHaveBeenCalledTimes(1);
  });

  it('6. windows + long_running=false: ordinary command execution is untouched', async () => {
    const member = makeTestAgent({ os: 'windows' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: 'hi\n', stderr: '', code: 0 });

    const result = resultText(await executeCommand({
      member_id: member.id,
      command: 'echo hi',
      long_running: false,
      timeout_s: 5,
    }));

    expect(result).toContain('Exit code: 0');
    expect(result).toContain('hi');
    expect(mockExecCommand).toHaveBeenCalledTimes(1);
  });

  it('7. windows + long_running=true: the CIM CommandLine launches run.ps1 rooted at $env:USERPROFILE\\.fleet-tasks\\<taskId>', async () => {
    const member = makeTestAgent({ os: 'windows' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: 'TASK_PID:4242\n', stderr: '', code: 0 });

    await executeCommand({
      member_id: member.id,
      command: 'python train.py',
      long_running: true,
      timeout_s: 5,
    });

    const decoded = decodeIfEncoded(mockExecCommand.mock.calls[0][0] as string);
    expect(decoded).toContain('$env:USERPROFILE\\.fleet-tasks\\task-');
    expect(decoded).toContain('run.ps1');
    expect(decoded).toContain('TASK_PID:$($result.ProcessId)');
  });
});
