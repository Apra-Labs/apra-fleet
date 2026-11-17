import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry, resultText } from '../test-helpers.js';
import { addAgent } from '../../src/services/registry.js';
import { executePrompt } from '../../src/tools/execute-prompt.js';
import { getStoredPid, clearStoredPid, setStoredPid } from '../../src/utils/agent-helpers.js';
import { resetCliVersionCache } from '../../src/services/session-mcp-config.js';
import type { Agent, SSHExecResult } from '../../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number, maxTotalMs?: number, onPidCaptured?: (pid: number) => void) => Promise<SSHExecResult>>();

// Project-level agent shadow check is covered by tests/agent-shadow*.test.ts;
// stubbed so the mockResolvedValueOnce sequence below stays the dispatch's own calls.
vi.mock('../../src/services/agent-shadow.js', () => ({
  ensureNoProjectAgentShadows: vi.fn(async () => undefined),
}));

// Integration mock: wraps mockExecCommand and replicates the FLEET_PID extraction logic
// inline (parsing stdout, calling setStoredPid + onPidCaptured) — mirrors what the real
// LocalStrategy/SSH streaming handlers do via the onPidCaptured callback.
vi.mock('../../src/services/strategy.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/services/strategy.js')>();
  return {
    ...original,
    getStrategy: (member: Agent) => ({
      execCommand: async (cmd: string, timeout?: number, maxTotalMs?: number, onPidCaptured?: (pid: number) => void) => {
        const result = await mockExecCommand(cmd, timeout, maxTotalMs, onPidCaptured);
        const m = /^FLEET_PID:(\d+)\r?$/m.exec(result.stdout);
        if (m) {
          const pid = parseInt(m[1], 10);
          setStoredPid(member.id, pid);
          onPidCaptured?.(pid);
          return { ...result, stdout: result.stdout.replace(/^FLEET_PID:\d+\r?(?:\n|$)/m, '') };
        }
        return result;
      },
      testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 0 }),
      transferFiles: vi.fn().mockResolvedValue({ success: [], failed: [] }),
      receiveFiles: vi.fn().mockResolvedValue({ success: [], failed: [] }),
      deleteFiles: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    }),
  };
});

/** The member CLI version probe's answer (a supported claude CLI). */
const CLI_VERSION = { stdout: '2.1.291 (Claude Code)\n', stderr: '', code: 0 };

describe('PID lifecycle — integration (T12)', () => {
  let memberId: string;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetCliVersionCache();
  });

  afterEach(() => {
    restoreRegistry();
    vi.useRealTimers();
    if (memberId) clearStoredPid(memberId);
  });

  it('PID captured from stdout is killed at the start of the next executePrompt call', async () => {
    const member = makeTestLocalAgent({ friendlyName: 'pid-capture-member', workFolder: os.tmpdir() });
    memberId = member.id;
    addAgent(member);

    // First call: emits FLEET_PID:1111, then fails with a non-retryable error.
    // PID 1111 is stored by the real extractAndStorePid but NOT cleared (no success path).
    mockExecCommand.mockResolvedValueOnce(CLI_VERSION); // member CLI version probe (cached after this)
    mockExecCommand.mockResolvedValueOnce({
      stdout: 'FLEET_PID:1111\n',
      stderr: 'something unexpected happened',
      code: 1,
    });

    const first = await executePrompt({ member_id: memberId, prompt: 'first', resume: false, timeout_s: 5 });
    expect(resultText(first)).toContain('failed');
    // PID stored by real extractAndStorePid — not cleared because the call failed
    expect(getStoredPid(memberId)).toBe(1111);

    // Second call: PID 1111 must be killed BEFORE writePromptFile and the new spawn
    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // kill 1111
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ result: 'ok', session_id: 's2' }),
        stderr: '',
        code: 0,
      });

    const second = await executePrompt({ member_id: memberId, prompt: 'second', resume: false, timeout_s: 5 });
    expect(resultText(second)).toContain('ok');

    // 4 total calls:
    //   calls[0] = first executePrompt's member CLI version probe (session MCP config)
    //   calls[1] = first executePrompt's main cmd (returns FLEET_PID:1111 + non-retryable error)
    //   calls[2] = second executePrompt's kill cmd (kills 1111)
    //   calls[3] = second executePrompt's main cmd (success; the version is cached)
    expect(mockExecCommand).toHaveBeenCalledTimes(4);
    expect(mockExecCommand.mock.calls[2][0]).toContain('1111');
  });

  it('PID is cleared after successful completion', async () => {
    const member = makeTestLocalAgent({ friendlyName: 'pid-clear-member', workFolder: os.tmpdir() });
    memberId = member.id;
    addAgent(member);

    // Command emits FLEET_PID:2222 then succeeds; PID should be cleared on the success path
    mockExecCommand.mockResolvedValueOnce(CLI_VERSION); // member CLI version probe
    mockExecCommand.mockResolvedValueOnce({
      stdout: 'FLEET_PID:2222\n' + JSON.stringify({ result: 'done', session_id: 's1' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 });

    expect(getStoredPid(memberId)).toBeUndefined();
  });

  it('PID from the failing main command is killed before the server-error retry', async () => {
    const member = makeTestLocalAgent({ friendlyName: 'retry-kill-member', workFolder: os.tmpdir() });
    memberId = member.id;
    addAgent(member);

    // Pre-existing PID from a prior failed call (the member was left running)
    setStoredPid(memberId, 3333);

    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })   // kill pre-stored 3333
      .mockResolvedValueOnce(CLI_VERSION)                             // member CLI version probe
      .mockResolvedValueOnce({                                        // main cmd: emits FLEET_PID:4444 + 500
        stdout: 'FLEET_PID:4444\n',
        stderr: 'HTTP 500 Internal Server Error',
        code: 1,
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })   // kill 4444 before retry
      .mockResolvedValueOnce({                                        // retry: success
        stdout: JSON.stringify({ result: 'retried', session_id: 's3' }),
        stderr: '',
        code: 0,
      });

    const promise = executePrompt({ member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 });
    await vi.advanceTimersByTimeAsync(5000);  // advance past SERVER_RETRY_DELAY_MS
    const result = await promise;

    expect(resultText(result)).toContain('retried');

    // Call sequence:
    //   calls[0] = kill(3333)        — pre-stored PID from prior run
    //   calls[1] = version probe     -- member CLI version (session MCP config)
    //   calls[2] = main cmd          -- emits FLEET_PID:4444 + 500 error
    //   calls[3] = kill(4444)        -- PID from the failing main cmd, killed before retry
    //   calls[4] = retry cmd         -- success
    expect(mockExecCommand).toHaveBeenCalledTimes(5);
    expect(mockExecCommand.mock.calls[0][0]).toContain('3333');
    expect(mockExecCommand.mock.calls[1][0]).toContain('--version');
    expect(mockExecCommand.mock.calls[3][0]).toContain('4444');
  });
});
