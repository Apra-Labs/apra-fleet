import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Agent, SSHExecResult } from '../src/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { decodePowerShellEncodedCommand } from './test-helpers.js';

const execAsync = promisify(exec);

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

import { pollLogFile, pollDirectoryActivity } from '../src/services/stall/stall-poller.js';
import { getProvider } from '../src/providers/index.js';
import { clearMemberHomeDirCache } from '../src/services/member-home.js';

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

    // apra-fleet: fleet-win-dev1 sprint apra-fleet-ivxi/u1qw/69pp, confirmed
    // stall site d2e30668-83bd-422f-b439-25d0a92133f6. The transcript's last
    // entry was this exact unresolved Bash tool_use (command/timeout verbatim
    // from the raw transcript) -- fleet killed the dispatch at 136s idle even
    // though the model itself had declared a 900000ms (15 min) budget for
    // this specific call.
    it('reads the pending tool_use timeout verbatim from a real stalled session (900000ms)', async () => {
      const stdout = jsonLines(
        { type: 'assistant', timestamp: '2026-08-14T12:38:34.128Z', model: 'claude-opus-5' },
        {
          type: 'assistant',
          timestamp: '2026-08-14T12:38:36.128Z',
          model: 'claude-opus-5',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_01WR9ZvHAmquoGZUSeYdm6wo',
                name: 'Bash',
                input: {
                  command:
                    'until grep -q "VITEST_EXIT=" /tmp/fulltest3.txt 2>/dev/null; do sleep 10; done; grep -E "Test Files|Tests  |VITEST_EXIT" /tmp/fulltest3.txt | tail -6',
                  timeout: 900000,
                },
              },
            ],
          },
        },
      );
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.pendingToolTimeoutMs).toBe(900000);
    });

    // apra-fleet: same sprint, confirmed stall site
    // 963a1740-4a1c-4a63-b84f-8d6b9961aa2c -- last entry an unresolved Bash
    // tool_use with an explicit 600000ms (10 min) budget, killed at 131s idle.
    it('reads the pending tool_use timeout verbatim from a real stalled session (600000ms)', async () => {
      const stdout = jsonLines({
        type: 'assistant',
        timestamp: '2026-08-14T11:38:42.451Z',
        model: 'claude-opus-5',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_0159oAzyBrTcZcWoLJ72DGGX',
              name: 'Bash',
              input: {
                command:
                  'until [ -s /tmp/test.log ] && grep -q "TEST EXIT" /tmp/test.log 2>/dev/null; do sleep 5; done; echo done',
                description: 'Wait until tests finish',
                timeout: 600000,
              },
            },
          ],
        },
      });
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.pendingToolTimeoutMs).toBe(600000);
    });

    it('reports no pending tool timeout when the tail ends on plain assistant text, not a tool_use', async () => {
      const stdout = jsonLines({
        type: 'assistant',
        timestamp: '2026-08-14T14:42:22.062Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'All steps completed and pushed successfully.' }] },
      });
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.pendingToolTimeoutMs).toBeNull();
    });

    it('reports no pending tool timeout when the pending tool_use has no timeout input', async () => {
      const stdout = jsonLines({
        type: 'assistant',
        timestamp: '2026-08-14T14:32:31.803Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_01CyiQ9FZSM9jM6R4wdGCZw5',
              name: 'Bash',
              input: { command: 'node scripts/run-integ-suites.mjs --status --wait=45 2>&1 | head -14', description: 'Poll integ suite status' },
            },
          ],
        },
      });
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.pendingToolTimeoutMs).toBeNull();
    });

    it('reports no pending tool timeout when the last entry is a resolved tool_result, not a pending tool_use', async () => {
      const stdout = jsonLines(
        {
          type: 'assistant',
          timestamp: '2026-08-14T10:00:00.000Z',
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'sleep 5', timeout: 900000 } }] },
        },
        {
          type: 'user',
          timestamp: '2026-08-14T10:00:05.000Z',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'done' }] },
        },
      );
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.pendingToolTimeoutMs).toBeNull();
    });

    it('never reads a pending tool timeout for non-claude providers (gemini)', async () => {
      mockGetAgent.mockReturnValue(makeAgent({ llmProvider: 'gemini' }));
      const stdout = jsonLines({
        $set: { lastUpdated: '2026-08-14T10:00:00.000Z' },
      });
      mockExecCommand.mockResolvedValue({ stdout, stderr: '', code: 0 });

      const result = await pollLogFile('member-1', '/log.jsonl');
      expect(result.pendingToolTimeoutMs).toBeNull();
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

  describe('pollDirectoryActivity', () => {
    it('reports no signal available if agent not found or provider has no log dir', async () => {
      mockGetAgent.mockReturnValue(undefined);
      expect(await pollDirectoryActivity('unknown')).toEqual({ mtimeMs: null, signalAvailable: false });

      // apra-fleet-igoe / issue #390: codex/copilot/none have NO pollable log
      // directory at all. That must be reported as "no signal available", not as
      // "polled and found nothing" -- the stall detector keys its no-kill
      // decision off exactly this distinction.
      mockGetAgent.mockReturnValue(makeAgent({ llmProvider: 'none' }));
      expect(await pollDirectoryActivity('member-1')).toEqual({ mtimeMs: null, signalAvailable: false });
      expect(mockExecCommand).not.toHaveBeenCalled();
    });

    it('reports signalAvailable=true but mtimeMs=null when the directory exists but yields nothing', async () => {
      mockGetAgent.mockReturnValue(makeAgent({ llmProvider: 'agy' }));
      mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
      expect(await pollDirectoryActivity('member-1')).toEqual({ mtimeMs: null, signalAvailable: true });
    });

    /**
     * SF-14: the directory-scan depth bound must be deep enough to actually
     * reach an AGY transcript.
     *
     * The previous version of this test built the fixture tree but then mocked
     * `execCommand` to hand back an mtime derived from `fs.statSync`, so the
     * generated `find`/`Get-ChildItem` command was never run against the tree
     * and the test passed identically with `-maxdepth 1`. Here `execCommand`
     * really executes the generated command (that IS the member-side shell in
     * production), against a real fixture at the real AGY layout depth -- so a
     * too-shallow bound produces no output and the assertions fail.
     *
     * macOS is skipped: the POSIX branch uses GNU `stat -c %Y`, which BSD stat
     * does not accept, and that would be a toolchain failure rather than a
     * depth-bound failure.
     */
    describe.skipIf(process.platform === 'darwin')('AGY brain-dir depth bound (SF-14)', () => {
      const targetOs: 'windows' | 'linux' = process.platform === 'win32' ? 'windows' : 'linux';
      const agy = getProvider('agy');
      let fixtureHome: string;
      let logDir: string;
      let transcriptPath: string;

      beforeEach(() => {
        clearMemberHomeDirCache();
        fixtureHome = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agy-depth-'));
        // Layout comes from the provider itself, so it tracks agy.ts rather
        // than a hardcoded guess about how deep the transcript sits.
        logDir = agy.resolveSessionLogDir('/work/repo', fixtureHome, targetOs)!;
        transcriptPath = agy.resolveSessionLogPath('sess-456', '/work/repo', fixtureHome, targetOs);
        fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
        fs.writeFileSync(transcriptPath, '{"created_at":"2026-08-05T05:01:00.000Z"}\n');

        // Remote member so the home dir comes from the (mocked-transport) probe
        // and lands on the fixture tree instead of this machine's real home.
        mockGetAgent.mockReturnValue(makeAgent({
          id: 'member-1',
          agentType: 'remote',
          username: 'bella',
          llmProvider: 'agy',
          workFolder: '/work/repo',
        }));
        mockGetAgentOS.mockReturnValue(targetOs);
        mockExecCommand.mockImplementation(async (cmd: string) => {
          // Only the home-dir probe is stubbed (it asks the member "where is
          // your home"; here that answer is the fixture root). Every other
          // command -- i.e. the directory scan under test -- is executed for
          // real by the host shell.
          // Windows probe is delivered via wrapPowerShellEncoded (base64
          // -EncodedCommand), not a raw inline string -- decode to inspect it.
          const decodedCmd = decodePowerShellEncodedCommand(cmd);
          if (decodedCmd.includes('$HOME') || decodedCmd.includes('USERPROFILE')) {
            return { stdout: fixtureHome, stderr: '', code: 0 };
          }
          const { stdout, stderr } = await execAsync(cmd, { timeout: 30_000, maxBuffer: 1024 * 1024 });
          return { stdout: String(stdout), stderr: String(stderr), code: 0 };
        });
      });

      afterEach(() => {
        fs.rmSync(fixtureHome, { recursive: true, force: true });
        clearMemberHomeDirCache();
      });

      it('the generated scan command really finds the transcript nested under the brain dir', async () => {
        const activity = await pollDirectoryActivity('member-1');

        const scanCmd = mockExecCommand.mock.calls.map(c => c[0]).find(c => c.includes('find ') || c.includes('Get-ChildItem'));
        expect(scanCmd).toBeDefined();
        expect(scanCmd).toContain(logDir);

        expect(activity.signalAvailable).toBe(true);
        // The real command really located the real file: its mtime comes back.
        expect(activity.mtimeMs).not.toBeNull();
        const actualMtime = fs.statSync(transcriptPath).mtimeMs;
        // POSIX branch reports whole seconds, so allow a 1s truncation window.
        expect(Math.abs(activity.mtimeMs! - actualMtime)).toBeLessThan(1500);
      });

      it('the depth bound in the generated command covers the full AGY transcript layout', async () => {
        await pollDirectoryActivity('member-1');
        const scanCmd = mockExecCommand.mock.calls.map(c => c[0]).find(c => c.includes('find ') || c.includes('Get-ChildItem'))!;

        // How far below the polled root the transcript actually lives, derived
        // from the provider (currently brain/<sessionId>/.system_generated/
        // logs/transcript.jsonl == 4 levels), not assumed.
        const relSegments = transcriptPath
          .slice(logDir.length)
          .split(/[\\/]/)
          .filter(Boolean);
        const requiredDepth = relSegments.length;
        expect(requiredDepth).toBeGreaterThan(1);

        if (targetOs === 'windows') {
          // Get-ChildItem -Depth 0 == direct children, so a file `requiredDepth`
          // levels down needs at least `requiredDepth - 1`.
          const bound = Number(/-Depth (\d+)/.exec(scanCmd)![1]);
          expect(bound).toBeGreaterThanOrEqual(requiredDepth - 1);
        } else {
          // find -maxdepth 1 == direct children, so it needs at least `requiredDepth`.
          const bound = Number(/-maxdepth (\d+)/.exec(scanCmd)![1]);
          expect(bound).toBeGreaterThanOrEqual(requiredDepth);
        }
      });
    });
  });
});
