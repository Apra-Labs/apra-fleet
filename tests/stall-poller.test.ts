import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent, SSHExecResult } from '../src/types.js';

const {
  mockGetAgent,
  mockExecCommand,
  mockLogLine,
  mockLogWarn,
  mockGetAgentOS,
} = vi.hoisted(() => ({
  mockGetAgent: vi.fn<(id: string) => Agent | undefined>(),
  mockExecCommand: vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>(),
  mockLogLine: vi.fn(),
  mockLogWarn: vi.fn(),
  mockGetAgentOS: vi.fn<(agent: Agent) => string>(),
}));

vi.mock('../src/services/registry.js', () => ({
  getAgent: mockGetAgent,
  updateAgent: vi.fn(),
}));

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({ execCommand: mockExecCommand }),
}));

vi.mock('../src/utils/log-helpers.js', () => ({
  logLine: mockLogLine,
  logWarn: mockLogWarn,
}));

vi.mock('../src/utils/agent-helpers.js', () => ({
  getAgentOS: mockGetAgentOS,
}));

import { pollLogFile } from '../src/services/stall/stall-poller.js';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'member-1',
    friendlyName: 'alice',
    agentType: 'local',
    workFolder: '/home/user/project',
    createdAt: new Date().toISOString(),
    os: 'linux',
    llmProvider: 'claude',
    ...overrides,
  };
}

function jsonLines(...objs: Record<string, unknown>[]): string {
  return objs.map(o => JSON.stringify(o)).join('\n');
}

describe('pollLogFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAgentOS.mockReturnValue('linux');
    mockGetAgent.mockReturnValue(makeAgent());
  });

  it('returns error when agent not found', async () => {
    mockGetAgent.mockReturnValue(undefined);
    const result = await pollLogFile('nonexistent', '/log.jsonl');
    expect(result.lastTimestamp).toBeNull();
    expect(result.error).toContain('not found');
  });

  describe('Claude — timestamp extraction from assistant entries', () => {
    it('extracts timestamp from the last assistant entry', async () => {
      const stdout = jsonLines(
        { type: 'user', timestamp: '2026-05-05T10:00:00.000Z' },
        { type: 'assistant', timestamp: '2026-05-05T10:01:00.000Z' },
      );
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.lastTimestamp).toBe('2026-05-05T10:01:00.000Z');
      expect(result.error).toBeUndefined();
    });

    it('ignores non-assistant entries and picks the last assistant entry', async () => {
      const stdout = jsonLines(
        { type: 'assistant', timestamp: '2026-05-05T10:00:00.000Z' },
        { type: 'user', timestamp: '2026-05-05T10:02:00.000Z' },
      );
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.lastTimestamp).toBe('2026-05-05T10:00:00.000Z');
    });

    it('returns null without format error when no assistant entries exist', async () => {
      const stdout = jsonLines(
        { type: 'user', timestamp: '2026-05-05T10:00:00.000Z' },
      );
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.lastTimestamp).toBeNull();
      expect(result.error).toBeUndefined();
      expect(mockLogLine).not.toHaveBeenCalledWith('stall_poll_format_error', expect.any(String));
    });

    it('logs stall_poll_format_error when assistant entry is missing timestamp', async () => {
      const stdout = jsonLines({ type: 'assistant', content: 'hello' });
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.lastTimestamp).toBeNull();
      expect(mockLogLine).toHaveBeenCalledWith(
        'stall_poll_format_error',
        expect.stringContaining('assistant entry missing timestamp')
      );
    });

    it('skips partial/unparseable lines at start of tail', async () => {
      const stdout = 'partial-json-line\n' + jsonLines(
        { type: 'assistant', timestamp: '2026-05-05T10:05:00.000Z' },
      );
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.lastTimestamp).toBe('2026-05-05T10:05:00.000Z');
    });

    it('uses tail -c 500 on Unix', async () => {
      mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
      await pollLogFile('member-1', '/home/user/log.jsonl');
      expect(mockExecCommand).toHaveBeenCalledWith(
        expect.stringContaining('tail -c 500'),
        5000
      );
    });

    it('uses PowerShell Get-Content -Tail on Windows', async () => {
      mockGetAgentOS.mockReturnValue('windows');
      mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
      await pollLogFile('member-1', 'C:\\logs\\log.jsonl');
      expect(mockExecCommand).toHaveBeenCalledWith(
        expect.stringContaining('Get-Content -Tail'),
        5000
      );
    });
  });

  describe('Gemini — lastUpdated extraction from $set lines', () => {
    beforeEach(() => {
      mockGetAgent.mockReturnValue(makeAgent({ llmProvider: 'gemini' }));
    });

    it('extracts lastUpdated from the last $set line', async () => {
      const stdout = jsonLines(
        { type: 'user', content: 'hello' },
        { '$set': { lastUpdated: '2026-05-05T10:03:00.000Z', other: 'field' } },
      );
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.lastTimestamp).toBe('2026-05-05T10:03:00.000Z');
      expect(result.error).toBeUndefined();
    });

    it('picks the last $set line when multiple are present', async () => {
      const stdout = jsonLines(
        { '$set': { lastUpdated: '2026-05-05T10:00:00.000Z' } },
        { '$set': { lastUpdated: '2026-05-05T10:05:00.000Z' } },
      );
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.lastTimestamp).toBe('2026-05-05T10:05:00.000Z');
    });

    it('returns null without format error when no $set lines exist', async () => {
      const stdout = jsonLines({ type: 'user', content: 'hello' });
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.lastTimestamp).toBeNull();
      expect(mockLogLine).not.toHaveBeenCalledWith('stall_poll_format_error', expect.any(String));
    });

    it('logs stall_poll_format_error when $set entry is missing lastUpdated', async () => {
      const stdout = jsonLines({ '$set': { otherField: 'value' } });
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.lastTimestamp).toBeNull();
      expect(mockLogLine).toHaveBeenCalledWith(
        'stall_poll_format_error',
        expect.stringContaining('$set entry missing lastUpdated')
      );
    });
  });

  describe('error handling', () => {
    it('returns null without error when file does not exist', async () => {
      mockExecCommand.mockResolvedValue({
        stdout: '',
        stderr: "tail: cannot open '/log.jsonl': No such file or directory",
        code: 1,
      });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.lastTimestamp).toBeNull();
      expect(result.error).toBeUndefined();
    });

    it('returns error on non-zero exit without file-not-found message', async () => {
      mockExecCommand.mockResolvedValue({
        stdout: '',
        stderr: 'Permission denied',
        code: 1,
      });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.lastTimestamp).toBeNull();
      expect(result.error).toContain('Permission denied');
    });

    it('returns error when execCommand throws', async () => {
      mockExecCommand.mockRejectedValue(new Error('SSH timeout'));

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.lastTimestamp).toBeNull();
      expect(result.error).toContain('SSH timeout');
    });
  });
});
