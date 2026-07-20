import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';
import { addAgent } from '../../src/services/registry.js';
import { executePrompt } from '../../src/tools/execute-prompt.js';
import { stopPrompt } from '../../src/tools/stop-prompt.js';
import { getStoredPid, clearStoredPid, setStoredPid } from '../../src/utils/agent-helpers.js';
import { launchAuthTerminal, isSSHSession } from '../../src/services/auth-socket.js';
import { getStrategy } from '../../src/services/strategy.js';
import type { Agent, SSHExecResult } from '../../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number, maxTotalMs?: number) => Promise<SSHExecResult>>();

// Integration mock: local agents use the real LocalStrategy (inactivity tests run real processes),
// remote agents use mockExecCommand (cancellation tests use controlled responses).
vi.mock('../../src/services/strategy.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/services/strategy.js')>();
  return {
    ...original,
    getStrategy: (member: Agent) => {
      if (member.agentType === 'local') {
        return original.getStrategy(member);
      }
      return {
        execCommand: mockExecCommand,
        testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 0 }),
        transferFiles: vi.fn().mockResolvedValue({ success: [], failed: [] }),
        receiveFiles: vi.fn().mockResolvedValue({ success: [], failed: [] }),
        deleteFiles: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(),
      };
    },
  };
});

// execute_prompt now auto-provisions agent files on first dispatch to a remote
// member (see execute-prompt-provisioning.test.ts) -- mock it away here so it
// doesn't consume the mockExecCommand queue and shift call-index assertions.
vi.mock('../../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: vi.fn().mockReturnValue('.claude/agents/pm'),
}));

// ── Inactivity timer ─────────────────────────────────────────────────────────
// Tests the rolling inactivity timer and max_total_s ceiling by running real
// local processes through LocalStrategy.execCommand.

describe('Inactivity timer — integration (T13)', () => {
  const WORK_DIR = os.tmpdir();

  it('command with regular output is not killed before the inactivity timeout', async () => {
    const member = makeTestLocalAgent({ workFolder: WORK_DIR });
    const strategy = getStrategy(member);  // local → real LocalStrategy

    // Prints 3 times every 100 ms — inactivity gap never reaches 3000 ms
    const cmd = process.platform === 'win32'
      ? 'for ($i=0; $i -lt 3; $i++) { Start-Sleep -Milliseconds 100; Write-Output "tick" }'
      : 'for i in 1 2 3; do sleep 0.1; echo tick; done';

    const result = await strategy.execCommand(cmd, 3000);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('tick');
  }, 15000);

  it('silent command is killed after inactivity timeout', async () => {
    const member = makeTestLocalAgent({ workFolder: WORK_DIR });
    const strategy = getStrategy(member);

    const cmd = process.platform === 'win32' ? 'Start-Sleep -Seconds 10' : 'sleep 10';
    await expect(strategy.execCommand(cmd, 300)).rejects.toThrow(/inactivity/);
  }, 5000);

  it('max_total_s hard ceiling kills command regardless of activity', async () => {
    const member = makeTestLocalAgent({ workFolder: WORK_DIR });
    const strategy = getStrategy(member);

    // Outputs every 50 ms — would never hit a 5000 ms inactivity timeout on its own
    const cmd = process.platform === 'win32'
      ? 'while ($true) { Start-Sleep -Milliseconds 50; Write-Output "ping" }'
      : 'while true; do sleep 0.05; echo ping; done';

    await expect(strategy.execCommand(cmd, 5000, 400)).rejects.toThrow(/max total time/);
  }, 5000);
});

// ── Cancellation ─────────────────────────────────────────────────────────────
// Tests the stop_prompt → executePrompt interaction: stop_prompt kills the PID
// and executePrompt can be dispatched immediately after (no error gate).

describe('Cancellation — integration (T13)', () => {
  let memberId: string;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
    if (memberId) clearStoredPid(memberId);
  });

  it('stop_prompt kills stored PID and clears it', async () => {
    const member = makeTestAgent({ friendlyName: 'stop-kill-member' });
    memberId = member.id;
    addAgent(member);
    setStoredPid(memberId, 5555);

    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });  // kill

    const result = await stopPrompt({ member_id: memberId });

    expect(result).toContain('stopped');
    expect(getStoredPid(memberId)).toBeUndefined();
    expect(mockExecCommand.mock.calls[0][0]).toContain('5555');
  });

  it('executePrompt proceeds immediately after stop_prompt — no error gate', async () => {
    const member = makeTestAgent({ friendlyName: 'stopped-then-resumed' });
    memberId = member.id;
    addAgent(member);
    setStoredPid(memberId, 7777);

    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });  // kill in stop_prompt
    await stopPrompt({ member_id: memberId });
    vi.clearAllMocks();

    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // writePromptFile
      .mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'resumed', session_id: 's1' }), stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });  // deletePromptFile

    const result = await executePrompt({ member_id: memberId, prompt: 'go', resume: false, timeout_s: 5 });

    expect(result).toContain('resumed');
    expect(mockExecCommand).toHaveBeenCalledTimes(3);
  });
});

// ── OOB SSH fallback ──────────────────────────────────────────────────────────
// Tests that launchAuthTerminal detects headless environments and returns an
// actionable fallback instead of attempting a GUI terminal launch.

describe('OOB SSH fallback — integration (T13)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('isSSHSession returns true when SSH_TTY is set', () => {
    vi.stubEnv('SSH_TTY', '/dev/ttys001');
    expect(isSSHSession()).toBe(true);
  });

  it('isSSHSession returns false when SSH_TTY is unset', () => {
    vi.stubEnv('SSH_TTY', '');
    expect(isSSHSession()).toBe(false);
  });
});
