import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executeCommand } from '../src/tools/execute-command.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

describe('executeCommand', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('returns stdout on success', async () => {
    const agent = makeTestAgent({ friendlyName: 'cmd-agent' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({ stdout: 'hello world\n', stderr: '', code: 0 });

    const result = await executeCommand({ member_id: agent.id, command: 'echo hello world', timeout_ms: 5000 });
    expect(result).toContain('Exit code: 0');
    expect(result).toContain('hello world');
  });

  it('wraps command with work folder', async () => {
    const agent = makeTestAgent({ workFolder: '/home/user/project' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await executeCommand({ member_id: agent.id, command: 'ls', timeout_ms: 5000 });
    expect(mockExecCommand).toHaveBeenCalledWith(
      expect.stringContaining('/home/user/project'),
      5000,
    );
  });

  it('uses custom work_folder when provided', async () => {
    const agent = makeTestAgent({ workFolder: '/home/user/project' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await executeCommand({ member_id: agent.id, command: 'ls', timeout_ms: 5000, work_folder: '/tmp/other' });
    expect(mockExecCommand).toHaveBeenCalledWith(
      expect.stringContaining('/tmp/other'),
      5000,
    );
    expect(mockExecCommand).toHaveBeenCalledWith(
      expect.not.stringContaining('/home/user/project'),
      5000,
    );
  });

  it('returns non-zero exit code and stderr', async () => {
    const agent = makeTestAgent({ friendlyName: 'fail-agent' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: 'command not found', code: 127 });

    const result = await executeCommand({ member_id: agent.id, command: 'nonexistent', timeout_ms: 5000 });
    expect(result).toContain('Exit code: 127');
    expect(result).toContain('command not found');
  });

  it('returns error message on exception', async () => {
    const agent = makeTestAgent({ friendlyName: 'err-agent' });
    addAgent(agent);
    mockExecCommand.mockRejectedValue(new Error('connection timeout'));

    const result = await executeCommand({ member_id: agent.id, command: 'echo hi', timeout_ms: 5000 });
    expect(result).toContain('Failed to execute command');
    expect(result).toContain('connection timeout');
  });

  it('returns agent not found for invalid ID', async () => {
    const result = await executeCommand({ member_id: 'nonexistent', command: 'echo hi', timeout_ms: 5000 });
    expect(result).toContain('not found');
  });

  it('shows (no output) when stdout and stderr are empty', async () => {
    const agent = makeTestAgent();
    addAgent(agent);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await executeCommand({ member_id: agent.id, command: 'true', timeout_ms: 5000 });
    expect(result).toContain('(no output)');
  });

  it('includes both stdout and stderr when both present', async () => {
    const agent = makeTestAgent();
    addAgent(agent);
    mockExecCommand.mockResolvedValue({ stdout: 'output', stderr: 'warning', code: 0 });

    const result = await executeCommand({ member_id: agent.id, command: 'cmd', timeout_ms: 5000 });
    expect(result).toContain('output');
    expect(result).toContain('[stderr]');
    expect(result).toContain('warning');
  });
});
