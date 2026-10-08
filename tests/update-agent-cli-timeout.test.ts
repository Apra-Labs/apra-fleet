/**
 * update_llm_cli: the CLI install/update step runs under the FLEET_PID
 * wrapper with an inactivity budget and a hard ceiling. A step that outlives
 * either is reported as an explicit timeout kill -- how long it ran, which
 * budget bound, and the remote PID whose tree was killed -- never a silent
 * mid-install cut. The strategy is stubbed: no SSH, no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import type { SSHExecResult } from '../src/types.js';

type ExecFn = (cmd: string, timeoutMs?: number, maxTotalMs?: number, onPid?: (pid: number) => void) => Promise<SSHExecResult>;
const mockExecCommand = vi.fn<ExecFn>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 1 })),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

const {
  updateAgentCli,
  INSTALL_INACTIVITY_TIMEOUT_MS,
  UPDATE_INACTIVITY_TIMEOUT_MS,
  INSTALL_MAX_TOTAL_MS,
} = await import('../src/tools/update-agent-cli.js');

const notInstalled: SSHExecResult = { stdout: '', stderr: 'command not found', code: 127 };
const installed = (v: string): SSHExecResult => ({ stdout: v, stderr: '', code: 0 });

/**
 * A remote step that reports its PID, runs for `ranMs`, then hits the budget:
 * rejects exactly as execCommand does when its timer fires.
 */
function timesOut(pid: number | undefined, ranMs: number, kind: 'inactivity' | 'ceiling'): ExecFn {
  return async (_cmd, timeoutMs, maxTotalMs, onPid) => {
    if (pid !== undefined) onPid?.(pid);
    await vi.advanceTimersByTimeAsync(ranMs);
    throw new Error(kind === 'inactivity'
      ? `Command timed out after ${timeoutMs}ms of inactivity`
      : `Command exceeded max total time of ${maxTotalMs}ms`);
  };
}

describe('update_llm_cli install/update timeout', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    restoreRegistry();
  });

  it('runs the install under the FLEET_PID wrapper with the inactivity budget and the ceiling', async () => {
    const member = makeTestAgent({ friendlyName: 'inst-ok', os: 'linux' });
    addAgent(member);
    mockExecCommand
      .mockResolvedValueOnce(notInstalled)
      .mockResolvedValueOnce(installed(''))
      .mockResolvedValueOnce(installed('2.0.0'));

    const report = await updateAgentCli({ member_id: member.id, install_if_missing: true });

    const [cmd, inactivity, ceiling, onPid] = mockExecCommand.mock.calls[1];
    expect(cmd).toMatch(/^\{ [\s\S]*; \} & _fleet_pid=\$!; printf 'FLEET_PID:%s\\n'/);
    expect(inactivity).toBe(INSTALL_INACTIVITY_TIMEOUT_MS);
    expect(ceiling).toBe(INSTALL_MAX_TOTAL_MS);
    expect(typeof onPid).toBe('function');
    expect(report).toContain('Installed: 2.0.0');
  });

  it('an install that goes silent past its budget is reported as an explicit timeout kill with run time and PID', async () => {
    const member = makeTestAgent({ friendlyName: 'inst-hang', os: 'linux' });
    addAgent(member);
    mockExecCommand
      .mockResolvedValueOnce(notInstalled)
      .mockImplementationOnce(timesOut(4242, 700_000, 'inactivity'));

    const report = await updateAgentCli({ member_id: member.id, install_if_missing: true });

    expect(report).toContain('\u274C inst-hang');
    expect(report).toContain(
      `CLI install killed on timeout after running 700s: it produced no output for ${INSTALL_INACTIVITY_TIMEOUT_MS / 1000}s; ` +
      'its remote process tree (PID 4242) was killed.',
    );
    expect(report).toMatch(/may be partially installed/);
    // no post-install version probe on a killed install
    expect(mockExecCommand).toHaveBeenCalledTimes(2);
  });

  it('an install that keeps printing but never finishes is killed at the ceiling and says so', async () => {
    const member = makeTestAgent({ friendlyName: 'inst-ceiling', os: 'windows' });
    addAgent(member);
    mockExecCommand
      .mockResolvedValueOnce(notInstalled)
      .mockImplementationOnce(timesOut(77, INSTALL_MAX_TOTAL_MS, 'ceiling'));

    const report = await updateAgentCli({ member_id: member.id, install_if_missing: true });

    const [cmd] = mockExecCommand.mock.calls[1];
    expect(cmd.startsWith('Write-Output "FLEET_PID:$pid"; ')).toBe(true);
    expect(report).toContain(`CLI install killed on timeout after running ${INSTALL_MAX_TOTAL_MS / 1000}s: it hit its ${INSTALL_MAX_TOTAL_MS / 1000}s ceiling; its remote process tree (PID 77) was killed.`);
  });

  it('an update that times out with no PID reported says the remote process may still be running', async () => {
    const member = makeTestAgent({ friendlyName: 'upd-hang', os: 'linux' });
    addAgent(member);
    mockExecCommand
      .mockResolvedValueOnce(installed('1.0.0'))
      .mockImplementationOnce(timesOut(undefined, 700_000, 'inactivity'));

    const report = await updateAgentCli({ member_id: member.id });

    const [, inactivity, ceiling] = mockExecCommand.mock.calls[1];
    expect(inactivity).toBe(UPDATE_INACTIVITY_TIMEOUT_MS);
    expect(ceiling).toBe(INSTALL_MAX_TOTAL_MS);
    expect(report).toContain('\u274C upd-hang');
    expect(report).toContain('CLI update killed on timeout after running 700s: it produced no output for 600s; its SSH channel was closed (no PID was reported, so the remote process may still be running).');
  });

  it('a non-timeout failure is not dressed up as a timeout kill', async () => {
    const member = makeTestAgent({ friendlyName: 'inst-err', os: 'linux' });
    addAgent(member);
    mockExecCommand
      .mockResolvedValueOnce(notInstalled)
      .mockRejectedValueOnce(new Error('connection reset'));

    const report = await updateAgentCli({ member_id: member.id, install_if_missing: true });
    expect(report).toContain('connection reset');
    expect(report).not.toContain('killed on timeout');
  });
});
