import os from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executeCommand, resolveTilde } from '../src/tools/execute-command.js';
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
    const member = makeTestAgent({ friendlyName: 'cmd-member' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: 'hello world\n', stderr: '', code: 0 });

    const result = await executeCommand({ member_id: member.id, command: 'echo hello world', timeout_s: 5 });
    expect(result).toContain('Exit code: 0');
    expect(result).toContain('hello world');
  });

  it('wraps command with work folder', async () => {
    const member = makeTestAgent({ workFolder: '/home/user/project' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await executeCommand({ member_id: member.id, command: 'ls', timeout_s: 5 });
    expect(mockExecCommand).toHaveBeenCalledWith(
      expect.stringContaining('/home/user/project'),
      5000,
    );
  });

  it('uses custom run_from when provided', async () => {
    const member = makeTestAgent({ workFolder: '/home/user/project' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await executeCommand({ member_id: member.id, command: 'ls', timeout_s: 5, run_from: '/tmp/other' });
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
    const member = makeTestAgent({ friendlyName: 'fail-member' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: 'command not found', code: 127 });

    const result = await executeCommand({ member_id: member.id, command: 'nonexistent', timeout_s: 5 });
    expect(result).toContain('Exit code: 127');
    expect(result).toContain('command not found');
  });

  it('returns error message on exception', async () => {
    const member = makeTestAgent({ friendlyName: 'err-member' });
    addAgent(member);
    mockExecCommand.mockRejectedValue(new Error('connection timeout'));

    const result = await executeCommand({ member_id: member.id, command: 'echo hi', timeout_s: 5 });
    expect(result).toContain('Failed to execute command');
    expect(result).toContain('connection timeout');
  });

  it('returns member not found for invalid ID', async () => {
    const result = await executeCommand({ member_id: 'nonexistent', command: 'echo hi', timeout_s: 5 });
    expect(result).toContain('not found');
  });

  it('shows (no output) when stdout and stderr are empty', async () => {
    const member = makeTestAgent();
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await executeCommand({ member_id: member.id, command: 'true', timeout_s: 5 });
    expect(result).toContain('(no output)');
  });

  it('includes both stdout and stderr when both present', async () => {
    const member = makeTestAgent();
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: 'output', stderr: 'warning', code: 0 });

    const result = await executeCommand({ member_id: member.id, command: 'cmd', timeout_s: 5 });
    expect(result).toContain('output');
    expect(result).toContain('[stderr]');
    expect(result).toContain('warning');
  });
});

describe('resolveTilde', () => {
  it('expands ~/path to homedir/path', () => {
    expect(resolveTilde('~/git/project')).toBe(os.homedir() + '/git/project');
  });

  it('expands bare ~ to homedir', () => {
    expect(resolveTilde('~')).toBe(os.homedir());
  });

  it('passes through absolute paths unchanged', () => {
    expect(resolveTilde('/absolute/path')).toBe('/absolute/path');
  });

  it('passes through relative paths unchanged', () => {
    expect(resolveTilde('relative/path')).toBe('relative/path');
  });
});
