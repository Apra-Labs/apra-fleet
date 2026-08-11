/**
 * Guards apra-fleet-ot2z.4 (execute_command long_running Windows hard-fail).
 * Covers UPDATED ACCEPTANCE CRITERION 5 for that fix only: long_running=true
 * on a Windows member must be refused before any dispatch or task
 * registration, while darwin/linux behavior is untouched.
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
  mockExecCommand: vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>(),
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

describe('execute_command long_running: Windows hard-fail (guards ot2z.4)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('1. windows + long_running=true: explicit POSIX-shell error, no "Task launched"', async () => {
    const member = makeTestAgent({ os: 'windows' });
    addAgent(member);

    const result = resultText(await executeCommand({
      member_id: member.id,
      command: 'python train.py',
      long_running: true,
      timeout_s: 5,
    }));

    expect(result).toContain('POSIX shell');
    expect(result).not.toContain('Task launched');
  });

  it('2. windows + long_running=true: mocked exec layer receives ZERO dispatches', async () => {
    const member = makeTestAgent({ os: 'windows' });
    addAgent(member);

    await executeCommand({
      member_id: member.id,
      command: 'python train.py',
      long_running: true,
      timeout_s: 5,
    });

    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('3. windows + long_running=true: no task id is registered in the task-credentials registry', async () => {
    const member = makeTestAgent({ os: 'windows' });
    addAgent(member);

    const result = resultText(await executeCommand({
      member_id: member.id,
      command: 'python train.py',
      long_running: true,
      timeout_s: 5,
    }));

    // Extract any task_id-looking token from the response text (there should be none)
    const taskIdMatch = result.match(/task-[a-z0-9]+/);
    expect(taskIdMatch).toBeNull();

    // Defensive: even if some task id shape leaked into the text, the registry
    // must not have an entry for it -- registerTaskCredentials should never
    // have been reached on the windows hard-fail path.
    if (taskIdMatch) {
      expect(getTaskCredentials(taskIdMatch[0])).toEqual([]);
    }
  });

  it('4. linux + long_running=true: unchanged -- "Task launched" and wrapper dispatch still occur', async () => {
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

  it('5. darwin + long_running=true: still launches, still carries the non-linux advisory warning', async () => {
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
});
