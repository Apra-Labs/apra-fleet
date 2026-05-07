import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent, SSHExecResult } from '../src/types.js';

const { mockGetAgent, mockExecCommand, mockLogLine, mockLogWarn } = vi.hoisted(() => ({
  mockGetAgent: vi.fn<(id: string) => Agent | undefined>(),
  mockExecCommand: vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>(),
  mockLogLine: vi.fn(),
  mockLogWarn: vi.fn(),
}));

vi.mock('../src/services/registry.js', () => ({
  getAgent: mockGetAgent,
}));

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({ execCommand: mockExecCommand }),
}));

vi.mock('../src/utils/log-helpers.js', () => ({
  logLine: mockLogLine,
  logWarn: mockLogWarn,
}));

vi.mock('../src/utils/agent-helpers.js', () => ({
  getAgentOS: () => 'linux',
}));

import { readLogTail } from '../src/services/stall/read-log-tail.js';

const testAgent: Agent = {
  id: 'agent-1',
  friendlyName: 'test-agent',
  agentType: 'local',
  workFolder: '/home/user/project',
  createdAt: new Date().toISOString(),
  os: 'linux',
};

describe('readLogTail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAgent.mockReturnValue(testAgent);
  });

  it('returns lastTimestamp from last JSONL line on success', async () => {
    const logLines = [
      JSON.stringify({ type: 'user', timestamp: '2026-05-04T10:00:00.000Z' }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-05-04T10:01:00.000Z' }),
    ].join('\n');
    mockExecCommand.mockResolvedValue({ stdout: logLines, stderr: '', code: 0 });

    const result = await readLogTail('agent-1', '/home/user/.claude/session.jsonl');

    expect(result.lastTimestamp).toBe('2026-05-04T10:01:00.000Z');
    expect(result.error).toBeUndefined();
  });

  it('calls logLine before issuing execCommand', async () => {
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await readLogTail('agent-1', '/some/log/path.jsonl');

    expect(mockLogLine).toHaveBeenCalled();
    expect(mockLogLine.mock.calls[0][0]).toBe('stall_log_read');
  });

  it('calls execCommand with tail command and 5000ms timeout', async () => {
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await readLogTail('agent-1', '/home/user/.claude/session.jsonl');

    expect(mockExecCommand).toHaveBeenCalledWith(
      expect.stringContaining('tail -c 512'),
      5000
    );
  });

  it('returns null timestamp when log file does not exist', async () => {
    mockExecCommand.mockResolvedValue({
      stdout: '',
      stderr: "tail: cannot open '/home/user/.claude/session.jsonl' for reading: No such file or directory",
      code: 1,
    });

    const result = await readLogTail('agent-1', '/home/user/.claude/session.jsonl');

    expect(result.lastTimestamp).toBeNull();
    expect(result.error).toBeUndefined();
  });

  it('returns error when execCommand throws (timeout/connection failure)', async () => {
    mockExecCommand.mockRejectedValue(new Error('Command timed out after 5000ms of inactivity'));

    const result = await readLogTail('agent-1', '/home/user/.claude/session.jsonl');

    expect(result.lastTimestamp).toBeNull();
    expect(result.error).toContain('timed out');
  });

  it('returns null timestamp when stdout is empty', async () => {
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = await readLogTail('agent-1', '/home/user/.claude/session.jsonl');

    expect(result.lastTimestamp).toBeNull();
    expect(result.error).toBeUndefined();
  });

  it('returns null timestamp when JSONL line has no timestamp field', async () => {
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ type: 'user', content: 'hello' }),
      stderr: '',
      code: 0,
    });

    const result = await readLogTail('agent-1', '/home/user/.claude/session.jsonl');

    expect(result.lastTimestamp).toBeNull();
    expect(result.error).toBeUndefined();
  });

  it('returns error when agent not found', async () => {
    mockGetAgent.mockReturnValue(undefined);

    const result = await readLogTail('nonexistent', '/some/path.jsonl');

    expect(result.lastTimestamp).toBeNull();
    expect(result.error).toContain('not found');
  });

  it('returns error on non-zero exit code without file-not-found message', async () => {
    mockExecCommand.mockResolvedValue({
      stdout: '',
      stderr: 'Permission denied',
      code: 1,
    });

    const result = await readLogTail('agent-1', '/home/user/.claude/session.jsonl');

    expect(result.lastTimestamp).toBeNull();
    expect(result.error).toContain('Permission denied');
  });
});
