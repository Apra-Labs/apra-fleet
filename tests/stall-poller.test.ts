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

  describe('Claude -- timestamp extraction from assistant entries', () => {
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

    // apra-fleet-6z8.2: activity is tracked from the most recent entry of ANY
    // type. A newly appended user/tool_result line is real progress; the old
    // assistant-only scan reported "no activity" for it, which is what made the
    // 120s stall threshold unreachable on a bd/git-tool-heavy turn.
    it('picks the most recent entry of ANY type, not just the last assistant entry', async () => {
      const stdout = jsonLines(
        { type: 'assistant', timestamp: '2026-05-05T10:00:00.000Z' },
        { type: 'user', timestamp: '2026-05-05T10:02:00.000Z' },
      );
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.lastTimestamp).toBe('2026-05-05T10:02:00.000Z');
    });

    it('returns a timestamp when the tail contains only tool_result/user entries', async () => {
      const stdout = jsonLines(
        { type: 'user', timestamp: '2026-05-05T10:00:00.000Z', message: { content: [{ type: 'tool_result', content: 'bd list output' }] } },
      );
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.lastTimestamp).toBe('2026-05-05T10:00:00.000Z');
      expect(result.error).toBeUndefined();
      expect(mockLogLine).not.toHaveBeenCalledWith('stall_poll_format_error', expect.any(String));
    });

    it('keeps scanning backwards past an entry with no timestamp', async () => {
      const stdout = jsonLines(
        { type: 'user', timestamp: '2026-05-05T10:00:00.000Z' },
        { type: 'summary', summary: 'compacted' },
      );
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.lastTimestamp).toBe('2026-05-05T10:00:00.000Z');
    });

    it('logs stall_poll_format_error when no entry in the tail carries a timestamp', async () => {
      const stdout = jsonLines({ type: 'assistant', content: 'hello' });
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.lastTimestamp).toBeNull();
      expect(mockLogLine).toHaveBeenCalledWith(
        'stall_poll_format_error',
        expect.stringContaining('no entry with a timestamp in tail')
      );
    });

    it('falls back to the raw tail when a single huge entry leaves no complete line', async () => {
      // The sampled window lands INSIDE one oversized tool_result: the leading
      // fragment is unparseable JSON, but the timestamp text is still there.
      const stdout = '{"type":"user","timestamp":"2026-05-05T10:07:00.000Z","message":{"content":[{"type":"tool_result","content":"' + 'x'.repeat(200);
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.lastTimestamp).toBe('2026-05-05T10:07:00.000Z');
    });

    // apra-fleet-979: the raw-tail fallback must not mistake a "timestamp"
    // key embedded (JSON-escaped) inside a tool_result's content for a
    // genuine transcript-entry timestamp. When a tool_result's content is
    // itself JSON-serialized into a string field, any "timestamp" key inside
    // that payload appears with its opening quote backslash-escaped
    // (`\"timestamp\"`) -- never as a bare `"timestamp"` the way a real
    // top-level transcript-entry key would. Pre-fix, RAW_TIMESTAMP_RE had no
    // lookbehind and matched this embedded form too, letting a stale/future
    // value inside tool output spuriously advance lastActivityAt and mask a
    // real stall.
    it('does not advance lastActivityAt from a "timestamp" embedded in tool_result content', async () => {
      // No line here parses as complete JSON (trailing padding keeps it
      // unterminated), and the only "timestamp" text in the tail is the
      // escaped/embedded one carrying a future-dated (fake) value.
      const stdout =
        '{"type":"user","message":{"content":[{"type":"tool_result","content":"blah \\"timestamp":"2099-01-01T00:00:00.000Z","note":"fake"}]}}' +
        'x'.repeat(200);
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.lastTimestamp).toBeNull();
    });

    it('still picks up a genuine top-level transcript-entry timestamp even when an embedded fake timestamp follows it in the same raw tail', async () => {
      const stdout =
        '{"type":"user","timestamp":"2026-05-05T10:07:00.000Z","message":{"content":[{"type":"tool_result","content":"blah \\"timestamp":"2099-01-01T00:00:00.000Z","note":"fake"}]}}' +
        'x'.repeat(200);
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.lastTimestamp).toBe('2026-05-05T10:07:00.000Z');
    });

    it('skips partial/unparseable lines at start of tail', async () => {
      const stdout = 'partial-json-line\n' + jsonLines(
        { type: 'assistant', timestamp: '2026-05-05T10:05:00.000Z' },
      );
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.lastTimestamp).toBe('2026-05-05T10:05:00.000Z');
    });

    // apra-fleet-6z8.2: the window is line-based and much wider than the old
    // 500-byte slice, which was thinner than a single tool_result payload.
    it('samples a wide, line-based tail on Unix', async () => {
      mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
      await pollLogFile('member-1', '/home/user/log.jsonl');
      expect(mockExecCommand).toHaveBeenCalledWith(
        expect.stringContaining('tail -n 20'),
        5000
      );
      expect(mockExecCommand).not.toHaveBeenCalledWith(
        expect.stringContaining('tail -c 500 '),
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

  describe('Gemini -- lastUpdated extraction from $set lines', () => {
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

  // apra-fleet-iuc.2: the transcript file's own OS mtime, fetched independently
  // of the content-based read above, so a content-parsing gap never has to be
  // the sole determinant of "is this session dead."
  describe('mtime cross-check (apra-fleet-iuc.2)', () => {
    it('parses mtimeMs from unix `stat -c %Y` output (seconds -> ms)', async () => {
      mockExecCommand.mockImplementation(async (cmd: string) => {
        if (cmd.includes('stat -c')) {
          return { stdout: '1700000000\n', stderr: '', code: 0 };
        }
        return { stdout: '', stderr: '', code: 0 };
      });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.mtimeMs).toBe(1_700_000_000_000);
    });

    it('parses mtimeMs from the PowerShell LastWriteTimeUtc command on Windows (already ms)', async () => {
      mockGetAgentOS.mockReturnValue('windows');
      mockExecCommand.mockImplementation(async (cmd: string) => {
        if (cmd.includes('LastWriteTimeUtc')) {
          return { stdout: '1700000000000\n', stderr: '', code: 0 };
        }
        return { stdout: '', stderr: '', code: 0 };
      });

      const result = await pollLogFile('member-1', 'C:\\logs\\log.jsonl');
      expect(result.mtimeMs).toBe(1_700_000_000_000);
    });

    it('is null (not an error) when the file does not exist yet', async () => {
      mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.mtimeMs).toBeNull();
      expect(result.error).toBeUndefined();
    });

    it('is null (never throws) when the stat command itself throws', async () => {
      mockExecCommand.mockImplementation(async (cmd: string) => {
        if (cmd.includes('stat -c')) throw new Error('ssh dropped mid-stat');
        const stdout = jsonLines({ type: 'user', timestamp: '2026-05-05T10:00:00.000Z' });
        return { stdout, stderr: '', code: 0 };
      });

      const result = await pollLogFile('member-1', '/log.jsonl');
      // The content-based read is unaffected by the stat failure.
      expect(result.lastTimestamp).toBe('2026-05-05T10:00:00.000Z');
      expect(result.mtimeMs).toBeNull();
      expect(result.error).toBeUndefined();
    });

    it('is null for non-finite/non-positive stat output rather than a bogus timestamp', async () => {
      mockExecCommand.mockImplementation(async (cmd: string) => {
        if (cmd.includes('stat -c')) return { stdout: 'not-a-number\n', stderr: '', code: 0 };
        return { stdout: '', stderr: '', code: 0 };
      });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.mtimeMs).toBeNull();
    });
  });

  describe('AGY -- timestamp extraction from created_at entries', () => {
    it('extracts created_at ISO timestamp from AGY entries', async () => {
      mockGetAgent.mockReturnValue(makeAgent({ llmProvider: 'agy' }));
      const stdout = jsonLines(
        { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-08-05T05:00:00.000Z' },
        { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-08-05T05:01:00.000Z' },
      );
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/brain/session-1/logs/transcript.jsonl');
      expect(result.lastTimestamp).toBe('2026-08-05T05:01:00.000Z');
      expect(result.error).toBeUndefined();
    });

    it('textually recovers created_at from partial line in raw tail', async () => {
      mockGetAgent.mockReturnValue(makeAgent({ llmProvider: 'agy' }));
      const stdout = '...truncated line...\n{"step_index":2,"source":"MODEL","created_at":"2026-08-05T05:02:30.000Z"}';
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/brain/session-1/logs/transcript.jsonl');
      expect(result.lastTimestamp).toBe('2026-08-05T05:02:30.000Z');
    });
  });
});
