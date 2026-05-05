import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Agent, SSHExecResult } from '../src/types.js';

const {
  mockGetAgent,
  mockExecCommand,
  mockLogLine,
  mockLogWarn,
  mockGetAgentOS,
  mockReaddirSync,
  mockStatSync,
  mockReadFileSync,
} = vi.hoisted(() => ({
  mockGetAgent: vi.fn<(id: string) => Agent | undefined>(),
  mockExecCommand: vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>(),
  mockLogLine: vi.fn(),
  mockLogWarn: vi.fn(),
  mockGetAgentOS: vi.fn<(agent: Agent) => string>(),
  mockReaddirSync: vi.fn(),
  mockStatSync: vi.fn(),
  mockReadFileSync: vi.fn(),
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
  getAgentOS: mockGetAgentOS,
}));

vi.mock('node:fs', () => ({
  readdirSync: mockReaddirSync,
  statSync: mockStatSync,
  readFileSync: mockReadFileSync,
}));

import { findLogFile } from '../src/services/stall/find-log-file.js';

const T0 = 1_000_000_000; // arbitrary reference timestamp (ms)

function makeLocalAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'local-1',
    friendlyName: 'local-agent',
    agentType: 'local',
    workFolder: '/home/user/project',
    createdAt: new Date().toISOString(),
    os: 'linux',
    llmProvider: 'claude',
    ...overrides,
  };
}

function makeRemoteAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'remote-1',
    friendlyName: 'remote-agent',
    agentType: 'remote',
    host: '10.0.0.1',
    port: 22,
    username: 'user',
    workFolder: '/home/user/project',
    createdAt: new Date().toISOString(),
    os: 'linux',
    llmProvider: 'claude',
    ...overrides,
  };
}

describe('findLogFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetAgentOS.mockReturnValue('linux');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Agent not found ---

  it('returns null immediately and logs warning when agent not found', async () => {
    mockGetAgent.mockReturnValue(undefined);

    const result = await findLogFile('nonexistent', T0, 'inv1', '/some/dir');

    expect(result).toBeNull();
    expect(mockLogWarn).toHaveBeenCalledWith('find_log_file', expect.stringContaining('nonexistent'));
    expect(mockLogLine).not.toHaveBeenCalled();
  });

  // --- Local — Case B Claude (sessionId known) ---

  describe('local — Case B Claude', () => {
    it('returns direct path when file exists with mtime > t0', async () => {
      mockGetAgent.mockReturnValue(makeLocalAgent({ sessionId: 'sess-abc' }));
      mockStatSync.mockReturnValue({ mtimeMs: T0 + 5000 });

      const result = await findLogFile('local-1', T0, 'inv1', '/logs/proj');

      expect(result).toContain('sess-abc.jsonl');
      expect(mockLogLine).toHaveBeenCalledWith('find_log_file', expect.stringContaining('find_log_file_found'));
    });

    it('returns null (retries then fails) when file mtime is not newer than t0', async () => {
      mockGetAgent.mockReturnValue(makeLocalAgent({ sessionId: 'sess-abc' }));
      mockStatSync.mockReturnValue({ mtimeMs: T0 - 1000 }); // too old

      const promise = findLogFile('local-1', T0, 'inv1', '/logs/proj');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBeNull();
      expect(mockLogLine).toHaveBeenCalledWith('stall_log_not_found', expect.any(String));
    });

    it('returns null (retries then fails) when file does not exist', async () => {
      mockGetAgent.mockReturnValue(makeLocalAgent({ sessionId: 'sess-abc' }));
      mockStatSync.mockImplementation(() => { throw new Error('ENOENT: no such file'); });

      const promise = findLogFile('local-1', T0, 'inv1', '/logs/proj');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBeNull();
      expect(mockLogLine).toHaveBeenCalledWith('stall_log_not_found', expect.any(String));
    });

    it('does NOT fall through to mtime scan — only checks direct path', async () => {
      mockGetAgent.mockReturnValue(makeLocalAgent({ sessionId: 'sess-abc' }));
      mockStatSync.mockImplementation(() => { throw new Error('ENOENT'); });

      const promise = findLogFile('local-1', T0, 'inv1', '/logs/proj');
      await vi.runAllTimersAsync();
      await promise;

      expect(mockReaddirSync).not.toHaveBeenCalled();
    });
  });

  // --- Local — Case A (no sessionId, fresh session) ---

  describe('local — Case A (fresh session, mtime scan)', () => {
    it('returns null when no files found in directory', async () => {
      mockGetAgent.mockReturnValue(makeLocalAgent({ sessionId: undefined }));
      mockReaddirSync.mockReturnValue([]);

      const promise = findLogFile('local-1', T0, 'inv1', '/logs/dir');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBeNull();
    });

    it('returns the single candidate with mtime > t0', async () => {
      mockGetAgent.mockReturnValue(makeLocalAgent({ sessionId: undefined }));
      mockReaddirSync.mockReturnValue([
        { isFile: () => true, name: 'session1.jsonl' },
        { isFile: () => true, name: 'old.jsonl' },
        { isFile: () => false, name: 'not-a-file' },
      ]);
      mockStatSync.mockImplementation((p: string) => {
        if ((p as string).includes('session1')) return { mtimeMs: T0 + 5000 };
        return { mtimeMs: T0 - 1000 };
      });

      const result = await findLogFile('local-1', T0, 'inv1', '/logs/dir');

      expect(result).toContain('session1.jsonl');
    });

    it('filters out non-jsonl files from mtime scan', async () => {
      mockGetAgent.mockReturnValue(makeLocalAgent({ sessionId: undefined }));
      mockReaddirSync.mockReturnValue([
        { isFile: () => true, name: 'session.jsonl' },
        { isFile: () => true, name: 'session.log' },
      ]);
      mockStatSync.mockReturnValue({ mtimeMs: T0 + 1000 });

      const result = await findLogFile('local-1', T0, 'inv1', '/logs/dir');

      expect(result).toContain('session.jsonl');
    });

    it('uses [inv] tiebreaker when multiple candidates match mtime filter', async () => {
      mockGetAgent.mockReturnValue(makeLocalAgent({ sessionId: undefined }));
      mockReaddirSync.mockReturnValue([
        { isFile: () => true, name: 'session-a.jsonl' },
        { isFile: () => true, name: 'session-b.jsonl' },
      ]);
      mockStatSync.mockReturnValue({ mtimeMs: T0 + 1000 });
      mockReadFileSync.mockImplementation((p: string) => {
        if ((p as string).includes('session-b')) return '{"content":"[inv42] do task"}';
        return '{"content":"other prompt"}';
      });

      const result = await findLogFile('local-1', T0, 'inv42', '/logs/dir');

      expect(result).toContain('session-b.jsonl');
      expect(mockLogLine).toHaveBeenCalledWith('find_log_file_tiebreaker', expect.any(String));
    });

    it('falls back to first candidate when no file matches [inv] token', async () => {
      mockGetAgent.mockReturnValue(makeLocalAgent({ sessionId: undefined }));
      mockReaddirSync.mockReturnValue([
        { isFile: () => true, name: 'session-a.jsonl' },
        { isFile: () => true, name: 'session-b.jsonl' },
      ]);
      mockStatSync.mockReturnValue({ mtimeMs: T0 + 1000 });
      mockReadFileSync.mockReturnValue('no token here');

      const result = await findLogFile('local-1', T0, 'invXYZ', '/logs/dir');

      expect(result).toContain('session-a.jsonl');
      expect(mockLogLine).not.toHaveBeenCalledWith('find_log_file_tiebreaker', expect.any(String));
    });
  });

  // --- Local — Case B Gemini (sessionId known, uses mtime scan) ---

  describe('local — Case B Gemini', () => {
    it('uses mtime scan (not direct path) even when sessionId is set', async () => {
      mockGetAgent.mockReturnValue(makeLocalAgent({ sessionId: 'gem-sess', llmProvider: 'gemini' }));
      mockReaddirSync.mockReturnValue([
        { isFile: () => true, name: 'gem-sess.jsonl' },
      ]);
      mockStatSync.mockReturnValue({ mtimeMs: T0 + 1000 });

      const result = await findLogFile('local-1', T0, 'inv1', '/logs/gemini/chats');

      expect(result).toContain('gem-sess.jsonl');
      expect(mockReaddirSync).toHaveBeenCalled();
    });
  });

  // --- Retry logic ---

  describe('retry logic', () => {
    it('logs stall_log_not_found after all 4 attempts exhausted', async () => {
      mockGetAgent.mockReturnValue(makeLocalAgent({ sessionId: undefined }));
      mockReaddirSync.mockReturnValue([]); // always empty

      const promise = findLogFile('local-1', T0, 'inv1', '/logs/dir');
      await vi.runAllTimersAsync();
      await promise;

      expect(mockLogLine).toHaveBeenCalledWith(
        'stall_log_not_found',
        expect.stringContaining('stall_log_not_found')
      );
    });

    it('returns result on second attempt when file appears after first retry', async () => {
      mockGetAgent.mockReturnValue(makeLocalAgent({ sessionId: undefined }));

      let callCount = 0;
      mockReaddirSync.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return []; // first attempt: no files
        return [{ isFile: () => true, name: 'session.jsonl' }]; // subsequent: file present
      });
      mockStatSync.mockReturnValue({ mtimeMs: T0 + 1000 });

      const promise = findLogFile('local-1', T0, 'inv1', '/logs/dir');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toContain('session.jsonl');
      expect(mockLogLine).not.toHaveBeenCalledWith('stall_log_not_found', expect.any(String));
    });

    it('makes exactly 4 attempts before giving up (initial + 3 retries)', async () => {
      mockGetAgent.mockReturnValue(makeLocalAgent({ sessionId: undefined }));
      mockReaddirSync.mockReturnValue([]);

      const promise = findLogFile('local-1', T0, 'inv1', '/logs/dir');
      await vi.runAllTimersAsync();
      await promise;

      expect(mockReaddirSync).toHaveBeenCalledTimes(4);
    });
  });

  // --- Remote — Case B Claude (sessionId known) ---

  describe('remote — Case B Claude', () => {
    it('returns path from find command when file is found and newer than t0', async () => {
      mockGetAgent.mockReturnValue(makeRemoteAgent({ sessionId: 'rem-sess' }));
      mockExecCommand.mockResolvedValue({
        stdout: '/home/user/.claude/projects/proj/rem-sess.jsonl\n',
        stderr: '',
        code: 0,
      });

      const result = await findLogFile('remote-1', T0, 'inv1', '/home/user/.claude/projects/proj');

      expect(result).toBe('/home/user/.claude/projects/proj/rem-sess.jsonl');
      expect(mockExecCommand).toHaveBeenCalledWith(
        expect.stringContaining('rem-sess.jsonl'),
        expect.any(Number)
      );
    });

    it('returns null when remote find returns empty output', async () => {
      mockGetAgent.mockReturnValue(makeRemoteAgent({ sessionId: 'rem-sess' }));
      mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

      const promise = findLogFile('remote-1', T0, 'inv1', '/home/user/.claude/projects/proj');
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBeNull();
    });

    it('uses -newermt flag in find command for Linux remote', async () => {
      mockGetAgent.mockReturnValue(makeRemoteAgent({ sessionId: 'rem-sess', os: 'linux' }));
      mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

      const promise = findLogFile('remote-1', T0, 'inv1', '/logs');
      await vi.runAllTimersAsync();
      await promise;

      expect(mockExecCommand).toHaveBeenCalledWith(
        expect.stringContaining('-newermt'),
        expect.any(Number)
      );
    });

    it('uses PowerShell Get-Item for Windows remote', async () => {
      mockGetAgentOS.mockReturnValue('windows');
      mockGetAgent.mockReturnValue(makeRemoteAgent({ sessionId: 'rem-sess', os: 'windows' }));
      mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

      const promise = findLogFile('remote-1', T0, 'inv1', 'C:\\logs');
      await vi.runAllTimersAsync();
      await promise;

      expect(mockExecCommand).toHaveBeenCalledWith(
        expect.stringContaining('Get-Item'),
        expect.any(Number)
      );
    });
  });

  // --- Remote — Case A / Case B Gemini (mtime scan) ---

  describe('remote — mtime scan', () => {
    it('returns single candidate from remote mtime scan', async () => {
      mockGetAgent.mockReturnValue(makeRemoteAgent({ sessionId: undefined, llmProvider: 'claude' }));
      mockExecCommand.mockResolvedValue({
        stdout: '/logs/session-x.jsonl\n',
        stderr: '',
        code: 0,
      });

      const result = await findLogFile('remote-1', T0, 'inv1', '/logs');

      expect(result).toBe('/logs/session-x.jsonl');
    });

    it('uses [inv] tiebreaker via grep when multiple remote candidates match', async () => {
      mockGetAgent.mockReturnValue(makeRemoteAgent({ sessionId: undefined }));
      mockExecCommand
        .mockResolvedValueOnce({
          // mtime scan returns two candidates
          stdout: '/logs/session-a.jsonl\n/logs/session-b.jsonl\n',
          stderr: '',
          code: 0,
        })
        .mockResolvedValueOnce({
          // grep tiebreaker matches session-b
          stdout: '/logs/session-b.jsonl\n',
          stderr: '',
          code: 0,
        });

      const result = await findLogFile('remote-1', T0, 'inv99', '/logs');

      expect(result).toBe('/logs/session-b.jsonl');
      expect(mockLogLine).toHaveBeenCalledWith('find_log_file_tiebreaker', expect.any(String));
    });

    it('uses grep with [inv] pattern for Linux tiebreaker', async () => {
      mockGetAgent.mockReturnValue(makeRemoteAgent({ sessionId: undefined }));
      mockExecCommand
        .mockResolvedValueOnce({
          stdout: '/logs/a.jsonl\n/logs/b.jsonl\n',
          stderr: '',
          code: 0,
        })
        .mockResolvedValueOnce({ stdout: '', stderr: '', code: 1 });

      await findLogFile('remote-1', T0, 'inv5', '/logs');

      const tiebreakCall = mockExecCommand.mock.calls[1];
      expect(tiebreakCall[0]).toContain('grep');
      expect(tiebreakCall[0]).toContain('inv5');
    });

    it('uses PowerShell Select-String for Windows tiebreaker', async () => {
      mockGetAgentOS.mockReturnValue('windows');
      mockGetAgent.mockReturnValue(makeRemoteAgent({ sessionId: undefined, os: 'windows' }));
      mockExecCommand
        .mockResolvedValueOnce({
          stdout: 'C:\\logs\\a.jsonl\nC:\\logs\\b.jsonl\n',
          stderr: '',
          code: 0,
        })
        .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

      await findLogFile('remote-1', T0, 'inv5', 'C:\\logs');

      const tiebreakCall = mockExecCommand.mock.calls[1];
      expect(tiebreakCall[0]).toContain('Select-String');
      expect(tiebreakCall[0]).toContain('inv5');
    });
  });
});
