import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { getStallDetector } from '../src/services/stall/index.js';
import { _resetKnownSessions } from '../src/services/known-sessions.js';
import type { SSHExecResult } from '../src/types.js';
import type { LlmProvider } from '../src/types.js';

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

const mockExecCommand = vi.fn<
  (
    cmd: string,
    timeout?: number,
    maxTotalMs?: number,
    onPidCaptured?: (pid: number) => void,
    signal?: AbortSignal,
  ) => Promise<SSHExecResult>
>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: vi.fn().mockReturnValue('.claude/agents/pm'),
}));

vi.mock('../src/services/workspace-trust.js', () => ({
  seedWorkspaceTrust: vi.fn().mockResolvedValue(undefined),
}));

import { executePrompt, provisionedRemoteAgents, type ExecutePromptInput } from '../src/tools/execute-prompt.js';

// apra-fleet-25yl.2.1's "CORRECTION to part 2": the exec-level ROLLING
// (inactivity) deadline handed to strategy.execCommand() follows a
// PER-PROVIDER matrix (ProviderAdapter.execTimeoutSource()), not a blanket
// decouple from timeout_s. This suite locks that matrix down at the
// execute_prompt tool-call level, per provider, with a stubbed strategy --
// no live SSH, no real CLI, no artifacts outside the test sandbox.
//
// A "dispatch" call is any strategy.execCommand invocation that passes the
// onPidCaptured 4th argument -- writePromptFile/deletePromptFile/tryKillPid
// never do, so filtering on that identifies the main dispatch (and any
// retry) regardless of how many setup exec calls a given provider's
// dispatch path happens to make (apra-fleet-25yl.2.2 review note: do not
// rely on a fixed calls[N] index across providers).
function dispatchCalls(): (typeof mockExecCommand)['mock']['calls'] {
  return mockExecCommand.mock.calls.filter((c) => typeof c[3] === 'function');
}

const EXEC_TIMER_NEVER_BINDS_MS = 86_400_000;

interface ProviderCase {
  provider: LlmProvider;
  /** stdout the stubbed strategy returns for a clean 0-exit dispatch, in the
   *  exact shape that provider's parseResponse() expects a real successful
   *  turn to look like -- taken from this repo's existing per-provider
   *  execute_prompt coverage (tests/unattended-mode.test.ts,
   *  tests/tool-provider.test.ts) so a non-empty parsed.result never
   *  triggers the exit-0/empty-stdout orphan-recovery branch. */
  successStdout: string;
}

const CASES: ProviderCase[] = [
  { provider: 'claude', successStdout: JSON.stringify({ result: 'ok', session_id: 'sess-claude' }) },
  { provider: 'agy', successStdout: 'FLEET_SESSION_ID:sess-agy\nresult done' },
  { provider: 'codex', successStdout: [
    JSON.stringify({ type: 'start' }),
    JSON.stringify({ type: 'message', role: 'assistant', content: 'codex response' }),
    JSON.stringify({ type: 'done', exitCode: 0 }),
  ].join('\n') },
  { provider: 'copilot', successStdout: JSON.stringify({ result: 'copilot response' }) },
  { provider: 'opencode', successStdout: JSON.stringify({ result: 'done', session_id: 'sess-opencode' }) },
];

function setupSuccessfulDispatch(stdout: string): void {
  mockExecCommand.mockImplementation(async (cmd, _timeout, _maxTotalMs, onPidCaptured) => {
    onPidCaptured?.(4242);
    return { stdout, stderr: '', code: 0 };
  });
}

describe('execute_prompt per-provider exec-level rolling timeout matrix (apra-fleet-25yl.2.2)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    provisionedRemoteAgents.clear();
    _resetKnownSessions();
  });

  afterEach(() => {
    restoreRegistry();
    _resetKnownSessions();
    getStallDetector().stallCheckList.clear();
    vi.restoreAllMocks();
  });

  for (const { provider, successStdout } of CASES) {
    it(`[${provider}] with timeout_s=60 and max_total_s=3600, StallDetector still gets thresholdMs=60000 (Part 1 threading survives)`, async () => {
      const member = makeTestAgent({ friendlyName: `${provider}-stall`, llmProvider: provider });
      addAgent(member);
      const addSpy = vi.spyOn(getStallDetector(), 'add');
      setupSuccessfulDispatch(successStdout);

      await executePrompt({
        member_id: member.id, prompt: 'hi', resume: false, timeout_s: 60, max_total_s: 3600,
      } as ExecutePromptInput);

      expect(addSpy).toHaveBeenCalled();
      const entryArg = addSpy.mock.calls[0][1];
      expect(entryArg.thresholdMs).toBe(60_000);
    });
  }

  it('[claude] with timeout_s=60/max_total_s=3600, the recorded exec timeoutMs mirrors 3600s, NOT 60_000', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-total-ceiling', llmProvider: 'claude' });
    addAgent(member);
    setupSuccessfulDispatch(JSON.stringify({ result: 'ok', session_id: 'sess-claude' }));

    await executePrompt({
      member_id: member.id, prompt: 'hi', resume: false, timeout_s: 60, max_total_s: 3600,
    } as ExecutePromptInput);

    const calls = dispatchCalls();
    expect(calls.length).toBe(1);
    const [, timeoutMs, maxTotalMs] = calls[0];
    expect(timeoutMs).toBe(3_600_000);
    expect(timeoutMs).not.toBe(60_000);
    expect(maxTotalMs).toBe(3_600_000);
  });

  it('[agy] with timeout_s=60/max_total_s=3600, the recorded exec timeoutMs mirrors 3600s, NOT 60_000', async () => {
    const member = makeTestAgent({ friendlyName: 'agy-total-ceiling', llmProvider: 'agy' });
    addAgent(member);
    setupSuccessfulDispatch('FLEET_SESSION_ID:sess-agy\nresult done');

    await executePrompt({
      member_id: member.id, prompt: 'hi', resume: false, timeout_s: 60, max_total_s: 3600,
    } as ExecutePromptInput);

    const calls = dispatchCalls();
    expect(calls.length).toBe(1);
    const [, timeoutMs, maxTotalMs] = calls[0];
    expect(timeoutMs).toBe(3_600_000);
    expect(timeoutMs).not.toBe(60_000);
    expect(maxTotalMs).toBe(3_600_000);
  });

  it('[codex] with the SAME timeout_s=60/max_total_s=3600 inputs, the recorded exec timeoutMs IS 60_000 -- the exec timer is NOT disabled for Codex', async () => {
    const member = makeTestAgent({ friendlyName: 'codex-inactivity', llmProvider: 'codex' });
    addAgent(member);
    setupSuccessfulDispatch([
      JSON.stringify({ type: 'start' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'codex response' }),
      JSON.stringify({ type: 'done', exitCode: 0 }),
    ].join('\n'));

    await executePrompt({
      member_id: member.id, prompt: 'hi', resume: false, timeout_s: 60, max_total_s: 3600,
    } as ExecutePromptInput);

    const calls = dispatchCalls();
    expect(calls.length).toBe(1);
    const [, timeoutMs] = calls[0];
    expect(timeoutMs).toBe(60_000);
  });

  it('[copilot] the recorded exec timeoutMs is identical to pre-change behaviour: derived from timeout_s, unaffected by max_total_s', async () => {
    const member = makeTestAgent({ friendlyName: 'copilot-inactivity', llmProvider: 'copilot' });
    addAgent(member);
    setupSuccessfulDispatch(JSON.stringify({ result: 'copilot response' }));

    await executePrompt({
      member_id: member.id, prompt: 'hi', resume: false, timeout_s: 60, max_total_s: 3600,
    } as ExecutePromptInput);

    const calls = dispatchCalls();
    expect(calls.length).toBe(1);
    const [, timeoutMs] = calls[0];
    expect(timeoutMs).toBe(60_000);
  });

  it('[opencode] the exec-level timer is still armed (inactivity_timeout) AND the StallDetector entry is still added with its own thresholdMs -- neither signal is removed', async () => {
    const member = makeTestAgent({ friendlyName: 'opencode-both-signals', llmProvider: 'opencode' });
    addAgent(member);
    const addSpy = vi.spyOn(getStallDetector(), 'add');
    setupSuccessfulDispatch(JSON.stringify({ result: 'done', session_id: 'sess-opencode' }));

    await executePrompt({
      member_id: member.id, prompt: 'hi', resume: false, timeout_s: 60, max_total_s: 3600,
    } as ExecutePromptInput);

    const calls = dispatchCalls();
    expect(calls.length).toBe(1);
    const [, timeoutMs] = calls[0];
    // exec-level timer: armed and inactivity-sourced (unaffected by max_total_s).
    expect(timeoutMs).toBe(60_000);
    // StallDetector: independently armed with its own threshold.
    expect(addSpy).toHaveBeenCalled();
    expect(addSpy.mock.calls[0][1].thresholdMs).toBe(60_000);
  });

  it('[claude] with max_total_s omitted, the recorded exec timeoutMs is the documented never-binds constant (86_400_000), not timeout_s', async () => {
    const member = makeTestAgent({ friendlyName: 'claude-no-ceiling', llmProvider: 'claude' });
    addAgent(member);
    setupSuccessfulDispatch(JSON.stringify({ result: 'ok', session_id: 'sess-claude' }));

    await executePrompt({
      member_id: member.id, prompt: 'hi', resume: false, timeout_s: 60,
    } as ExecutePromptInput);

    const calls = dispatchCalls();
    expect(calls.length).toBe(1);
    const [, timeoutMs, maxTotalMs] = calls[0];
    expect(maxTotalMs).toBeUndefined();
    expect(timeoutMs).toBe(EXEC_TIMER_NEVER_BINDS_MS);
    expect(timeoutMs).not.toBe(60_000);
  });

  it('[agy] with max_total_s omitted, the recorded exec timeoutMs is the documented never-binds constant (86_400_000), not timeout_s', async () => {
    const member = makeTestAgent({ friendlyName: 'agy-no-ceiling', llmProvider: 'agy' });
    addAgent(member);
    setupSuccessfulDispatch('FLEET_SESSION_ID:sess-agy\nresult done');

    await executePrompt({
      member_id: member.id, prompt: 'hi', resume: false, timeout_s: 60,
    } as ExecutePromptInput);

    const calls = dispatchCalls();
    expect(calls.length).toBe(1);
    const [, timeoutMs, maxTotalMs] = calls[0];
    expect(maxTotalMs).toBeUndefined();
    expect(timeoutMs).toBe(EXEC_TIMER_NEVER_BINDS_MS);
    expect(timeoutMs).not.toBe(60_000);
  });

  it('[claude] the retry-budget invariant survives: a retry\'s maxTotalMs is the REMAINING max_total_s, not the full original budget', async () => {
    vi.useFakeTimers();
    try {
      const member = makeTestAgent({ friendlyName: 'claude-retry-budget', llmProvider: 'claude' });
      addAgent(member);

      // apra-fleet-y8q.1's retryBudget() is computed at the moment the failed
      // attempt's result is observed -- BEFORE the SERVER_RETRY_DELAY_MS
      // pause below it in the source (execute-prompt.ts ~1473-1477) -- so a
      // retry test must burn measurable clock DURING the failing exec call
      // itself, not merely across the fixed retry delay: with a same-tick
      // failure (elapsed ~= 0), "remaining budget" and "the full original
      // budget" read identically, which is exactly the pre-y8q.1 bug this
      // assertion exists to catch.
      const ORIGINAL_ATTEMPT_ELAPSED_MS = 30_000;
      mockExecCommand
        .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }) // writePromptFile
        .mockImplementationOnce(async () => {
          await new Promise((resolve) => setTimeout(resolve, ORIGINAL_ATTEMPT_ELAPSED_MS));
          return { stdout: '', stderr: 'HTTP 500 Internal Server Error', code: 1 }; // retryable server error
        })
        .mockResolvedValueOnce({ // overloaded retry succeeds
          stdout: JSON.stringify({ result: 'recovered', session_id: 'sess-retry' }),
          stderr: '',
          code: 0,
        })
        .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }); // deletePromptFile

      // resume: false so the stale-session retry (gated on resume===true &&
      // agent.sessionId) never fires and consumes a mock call first -- only
      // the overloaded-error retry path below should run.
      const promise = executePrompt({
        member_id: member.id, prompt: 'hi', resume: false, timeout_s: 60, max_total_s: 3600,
      } as ExecutePromptInput);
      await vi.advanceTimersByTimeAsync(ORIGINAL_ATTEMPT_ELAPSED_MS); // let the failing main dispatch resolve
      await vi.advanceTimersByTimeAsync(5000); // SERVER_RETRY_DELAY_MS before the retry fires
      await promise;

      const calls = dispatchCalls();
      expect(calls.length).toBe(2);
      const [, originalTimeoutMs, originalMaxTotalMs] = calls[0];
      const [, retryTimeoutMs, retryMaxTotalMs] = calls[1];
      expect(originalMaxTotalMs).toBe(3_600_000);
      expect(originalTimeoutMs).toBe(3_600_000);
      // Exactly the remaining budget since dispatchStartedAt -- not the full
      // original ceiling (that would let original-plus-retry exceed 3_600_000s).
      expect(retryMaxTotalMs).toBe(3_600_000 - ORIGINAL_ATTEMPT_ELAPSED_MS);
      expect(retryMaxTotalMs).toBeLessThan(3_600_000);
      expect(retryTimeoutMs).toBe(retryMaxTotalMs);
    } finally {
      vi.useRealTimers();
    }
  });
});
