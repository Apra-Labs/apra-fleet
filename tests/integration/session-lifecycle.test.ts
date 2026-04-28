import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';
import { addAgent } from '../../src/services/registry.js';
import { executePrompt } from '../../src/tools/execute-prompt.js';
import { stopPrompt } from '../../src/tools/stop-prompt.js';
import {
  getStoredPid, clearStoredPid,
  isAgentStopped, clearAgentStopped, setStoredPid,
} from '../../src/utils/agent-helpers.js';
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
    getStrategy: (agent: Agent) => {
      if (agent.agentType === 'local') {
        return original.getStrategy(agent);
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

// ── Inactivity timer ─────────────────────────────────────────────────────────
// Tests the rolling inactivity timer and max_total_ms ceiling by running real
// local processes through LocalStrategy.execCommand.

describe('Inactivity timer — integration (T13)', () => {
  const WORK_DIR = os.tmpdir();

  it('command with regular output is not killed before the inactivity timeout', async () => {
    const agent = makeTestLocalAgent({ workFolder: WORK_DIR });
    const strategy = getStrategy(agent);  // local → real LocalStrategy

    // Prints 3 times every 100 ms — inactivity gap never reaches 3000 ms
    const cmd = process.platform === 'win32'
      ? 'for ($i=0; $i -lt 3; $i++) { Start-Sleep -Milliseconds 100; Write-Output "tick" }'
      : 'for i in 1 2 3; do sleep 0.1; echo tick; done';

    const result = await strategy.execCommand(cmd, 3000);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('tick');
  }, 15000);

  it('silent command is killed after inactivity timeout', async () => {
    const agent = makeTestLocalAgent({ workFolder: WORK_DIR });
    const strategy = getStrategy(agent);

    const cmd = process.platform === 'win32' ? 'Start-Sleep -Seconds 10' : 'sleep 10';
    await expect(strategy.execCommand(cmd, 300)).rejects.toThrow(/inactivity/);
  }, 5000);

  it('max_total_ms hard ceiling kills command regardless of activity', async () => {
    const agent = makeTestLocalAgent({ workFolder: WORK_DIR });
    const strategy = getStrategy(agent);

    // Outputs every 50 ms — would never hit a 5000 ms inactivity timeout on its own
    const cmd = process.platform === 'win32'
      ? 'while ($true) { Start-Sleep -Milliseconds 50; Write-Output "ping" }'
      : 'while true; do sleep 0.05; echo ping; done';

    await expect(strategy.execCommand(cmd, 5000, 400)).rejects.toThrow(/max total time/);
  }, 5000);
});

// ── Cancellation ─────────────────────────────────────────────────────────────
// Tests the stop_agent → executePrompt interaction: stopped flag set by stop_agent
// is enforced by executePrompt, then cleared so the next call proceeds normally.

describe('Cancellation — integration (T13)', () => {
  let agentId: string;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
    if (agentId) {
      clearStoredPid(agentId);
      clearAgentStopped(agentId);
    }
  });

  it('stop_agent kills stored PID and sets the stopped flag', async () => {
    const agent = makeTestAgent({ friendlyName: 'stop-kill-agent' });
    agentId = agent.id;
    addAgent(agent);
    setStoredPid(agentId, 5555);

    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });  // kill

    const result = await stopPrompt({ member_id: agentId });

    expect(result).toContain('stopped');
    expect(getStoredPid(agentId)).toBeUndefined();
    expect(isAgentStopped(agentId)).toBe(true);
    expect(mockExecCommand.mock.calls[0][0]).toContain('5555');
  });

  it('executePrompt on a stopped agent returns an error and clears the stopped flag', async () => {
    const agent = makeTestAgent({ friendlyName: 'stopped-agent' });
    agentId = agent.id;
    addAgent(agent);
    // Simulate stop_agent having already been called
    setStoredPid(agentId, 7777);
    await stopPrompt({ member_id: agentId });
    vi.clearAllMocks();

    const result = await executePrompt({ member_id: agentId, prompt: 'go', resume: false, timeout_ms: 5000 });

    expect(result).toContain('stopped');
    expect(result).toContain('stopped-agent');
    // Stopped flag is cleared so the next call can proceed
    expect(isAgentStopped(agentId)).toBe(false);
    // No command should have been dispatched
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('executePrompt proceeds normally after the stopped flag is cleared', async () => {
    const agent = makeTestAgent({ friendlyName: 'cleared-agent' });
    agentId = agent.id;
    addAgent(agent);

    // Trigger stopped error (sets flag via stop_agent, then executePrompt clears it)
    await stopPrompt({ member_id: agentId });
    vi.clearAllMocks();
    await executePrompt({ member_id: agentId, prompt: 'first', resume: false, timeout_ms: 5000 });
    expect(isAgentStopped(agentId)).toBe(false);

    // Next call proceeds normally using the mocked remote strategy
    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // writePromptFile
      .mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'back', session_id: 's1' }), stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });  // deletePromptFile

    const result = await executePrompt({ member_id: agentId, prompt: 'second', resume: false, timeout_ms: 5000 });
    expect(result).toContain('back');
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

  it('returns fallback with actual member name when DISPLAY is unset on Linux', () => {
    if (process.platform !== 'linux') return;
    vi.stubEnv('DISPLAY', '');
    vi.stubEnv('WAYLAND_DISPLAY', '');
    const onExit = vi.fn();

    const result = launchAuthTerminal('my-worker', [], onExit);

    expect(result).toMatch(/^fallback:/);
    expect(result).toContain('! apra-fleet auth my-worker');
    expect(result).not.toContain('<name>');
    expect(result).not.toContain('<member>');
    expect(onExit).not.toHaveBeenCalled();
  });

  it('returns fallback with actual member name when SESSIONNAME is not Console on Windows', () => {
    if (process.platform !== 'win32') return;
    vi.stubEnv('SESSIONNAME', 'RDP-Tcp#0');
    const onExit = vi.fn();

    const result = launchAuthTerminal('my-worker', [], onExit);

    expect(result).toMatch(/^fallback:/);
    expect(result).toContain('! apra-fleet auth my-worker');
    expect(result).not.toContain('<name>');
    expect(result).not.toContain('<member>');
    expect(onExit).not.toHaveBeenCalled();
  });

  it('does not return the headless-display fallback when DISPLAY is set on Linux', () => {
    if (process.platform !== 'linux') return;
    vi.stubEnv('DISPLAY', ':0');
    const onExit = vi.fn();

    const result = launchAuthTerminal('my-worker', [], onExit);

    // The headless-specific fallback must not fire — display check passed
    expect(result).not.toContain('No graphical display detected');
  });

  it('does not return the headless-desktop fallback when SESSIONNAME is Console on Windows', () => {
    if (process.platform !== 'win32') return;
    vi.stubEnv('SESSIONNAME', 'Console');
    const onExit = vi.fn();

    const result = launchAuthTerminal('my-worker', [], onExit);

    // The headless-specific fallback must not fire — interactive desktop check passed
    expect(result).not.toContain('No interactive desktop session detected');
  });

  it('returns fallback on macOS when SSH_TTY is set', () => {
    if (process.platform !== 'darwin') return;
    vi.stubEnv('SSH_TTY', '/dev/ttys001');
    const onExit = vi.fn();

    const result = launchAuthTerminal('my-worker', [], onExit);

    expect(result).toMatch(/^fallback:/);
    expect(result).toContain('! apra-fleet auth my-worker');
    expect(onExit).not.toHaveBeenCalled();
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
