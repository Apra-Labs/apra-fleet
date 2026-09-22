/**
 * Guards apra-fleet-ot2z.4 (execute_command long_running on Windows).
 *
 * Windows members no longer hard-fail long_running=true: the task is
 * launched detached via `Invoke-CimMethod Win32_Process.Create` (WMI
 * provider host / session 0), which survives the SSH session's job object
 * being torn down -- unlike a plain background launch, which dies with the
 * SSH channel on Windows. See src/services/cloud/task-wrapper.ts's
 * generateTaskWrapperWindows() for the PowerShell wrapper this launches and
 * src/tools/monitor-task.ts for the Windows status/pid/log read-back.
 *
 * Mocks the strategy/exec layer -- no real member connection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry, resultText } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executeCommand } from '../src/tools/execute-command.js';
import { getTaskCredentials } from '../src/services/credential-store.js';
import type { SSHExecResult } from '../src/types.js';

const { mockExecCommand } = vi.hoisted(() => ({
  mockExecCommand: vi.fn<(cmd: string, timeout?: number, maxTotalMs?: number, onPidCaptured?: (pid: number) => void) => Promise<SSHExecResult>>(),
}));

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn().mockResolvedValue({ ok: true }),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/cloud/lifecycle.js', () => ({
  ensureCloudReady: vi.fn((member: any) => Promise.resolve(member)),
}));

/**
 * monitor-task.ts / execute-command.ts wrap Windows-bound scripts as
 * `powershell -EncodedCommand <base64 utf16le>` (wrapPowerShellEncoded).
 * Decode back to the underlying script so assertions can inspect it.
 */
function decodeIfEncoded(cmd: string): string {
  const m = cmd.match(/^powershell -EncodedCommand (.+)$/);
  if (!m) return cmd;
  return Buffer.from(m[1], 'base64').toString('utf16le');
}

describe('execute_command long_running: Windows detached CIM launch (guards ot2z.4)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('1. windows + long_running=true: launches via Invoke-CimMethod, "Task launched", no POSIX-shell error', async () => {
    const member = makeTestAgent({ os: 'windows' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: 'TASK_PID:4242\n', stderr: '', code: 0 });

    const result = resultText(await executeCommand({
      member_id: member.id,
      command: 'python train.py',
      long_running: true,
      timeout_s: 5,
    }));

    expect(result).toContain('Task launched');
    expect(result).not.toContain('POSIX shell');
  });

  it('2. windows + long_running=true: dispatches exactly one Win32_Process.Create command, no POSIX tokens', async () => {
    const member = makeTestAgent({ os: 'windows' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: 'TASK_PID:4242\n', stderr: '', code: 0 });

    await executeCommand({
      member_id: member.id,
      command: 'python train.py',
      long_running: true,
      timeout_s: 5,
    });

    expect(mockExecCommand).toHaveBeenCalledTimes(1);
    const raw = mockExecCommand.mock.calls[0][0] as string;
    const decoded = decodeIfEncoded(raw);
    expect(raw).not.toBe(decoded); // must be -EncodedCommand wrapped
    expect(decoded).toContain('Invoke-CimMethod');
    expect(decoded).toContain('Win32_Process');
    expect(decoded).toContain('-MethodName Create');
    expect(decoded).not.toContain('nohup');
    expect(decoded).not.toContain('chmod');
    expect(decoded).not.toContain('2>/dev/null');
  });

  it('3. windows + long_running=true: a task id IS registered in the task-credentials registry (no error path)', async () => {
    const member = makeTestAgent({ os: 'windows' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: 'TASK_PID:4242\n', stderr: '', code: 0 });

    const result = resultText(await executeCommand({
      member_id: member.id,
      command: 'python train.py',
      long_running: true,
      timeout_s: 5,
    }));

    const taskIdMatch = result.match(/task-[a-z0-9]+/);
    expect(taskIdMatch).not.toBeNull();
    // No credentials were used, so the registry entry is empty but present
    // (getTaskCredentials never throws for a registered id with no creds).
    expect(getTaskCredentials(taskIdMatch![0])).toEqual([]);
  });

  it('4. linux + long_running=true: unchanged -- "Task launched" and nohup-bash wrapper dispatch still occur', async () => {
    const member = makeTestAgent({ os: 'linux' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = resultText(await executeCommand({
      member_id: member.id,
      command: 'python train.py',
      long_running: true,
      timeout_s: 5,
    }));

    expect(result).toContain('Task launched');
    expect(mockExecCommand).toHaveBeenCalledTimes(1);
    const calledCmd = mockExecCommand.mock.calls[0][0] as string;
    expect(calledCmd).toContain('nohup bash');
  });

  it('5. darwin + long_running=true: still launches, still carries the non-linux/windows advisory warning', async () => {
    const member = makeTestAgent({ os: 'macos' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const result = resultText(await executeCommand({
      member_id: member.id,
      command: 'python train.py',
      long_running: true,
      timeout_s: 5,
    }));

    expect(result).toContain('Task launched');
    expect(result).toContain('bash wrapper script designed for Linux');
    expect(mockExecCommand).toHaveBeenCalledTimes(1);
  });

  it('6. windows + long_running=false: ordinary command execution is untouched', async () => {
    const member = makeTestAgent({ os: 'windows' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: 'hi\n', stderr: '', code: 0 });

    const result = resultText(await executeCommand({
      member_id: member.id,
      command: 'echo hi',
      long_running: false,
      timeout_s: 5,
    }));

    expect(result).toContain('Exit code: 0');
    expect(result).toContain('hi');
    expect(mockExecCommand).toHaveBeenCalledTimes(1);
  });

  it('7. windows + long_running=true: the CIM CommandLine launches run.ps1 rooted at $env:USERPROFILE\\.fleet-tasks\\<taskId>', async () => {
    const member = makeTestAgent({ os: 'windows' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({ stdout: 'TASK_PID:4242\n', stderr: '', code: 0 });

    await executeCommand({
      member_id: member.id,
      command: 'python train.py',
      long_running: true,
      timeout_s: 5,
    });

    const decoded = decodeIfEncoded(mockExecCommand.mock.calls[0][0] as string);
    expect(decoded).toContain('$env:USERPROFILE\\.fleet-tasks\\task-');
    expect(decoded).toContain('run.ps1');
    expect(decoded).toContain('TASK_PID:$($result.ProcessId)');
  });
});

/**
 * grandchild-pins-pipe -- reproduction for apra-fleet-am7w (deploy dispatch on a
 * Windows member never completes because a grandchild inherited the dispatch's
 * stdout pipe) and guard for its fix in src/services/exit-drain.ts.
 *
 * The real scenario: the deployer's claude.exe starts the sandbox pair (or the
 * harvester's bash leaves an orphaned find.exe behind), exits, and the exec side
 * sits waiting for a pipe EOF that the surviving grandchild will never deliver --
 * observed live for 25-70 minutes. Here a PowerShell parent plays claude.exe and
 * a node keep-alive plays the sandbox server; the exact same parent script is
 * used by the by-hand reproduction scripts/repro/win-orphan-pipe.mjs.
 *
 * Windows-only by nature. On Linux/macOS it degrades to a wrapper-shape
 * assertion (below) so the suite stays green there.
 */
const isWindows = process.platform === 'win32';

describe('grandchild-pins-pipe: a dispatch completes when the process exits, not when the pipe EOFs', () => {
  const survivors: number[] = [];
  let repro: any;
  const savedDrain = process.env.FLEET_EXIT_DRAIN_MS;

  beforeEach(async () => {
    repro = await import('../scripts/repro/win-orphan-pipe.mjs' as any);
    // Keep the drain window short so the test stays fast; production default
    // (2000 ms) is asserted separately below.
    process.env.FLEET_EXIT_DRAIN_MS = '300';
  });

  afterEach(() => {
    if (savedDrain === undefined) delete process.env.FLEET_EXIT_DRAIN_MS;
    else process.env.FLEET_EXIT_DRAIN_MS = savedDrain;
    // Nothing this test started may survive it (verified with tasklist).
    for (const pid of survivors.splice(0)) {
      repro.killPidTree(pid);
      expect(repro.isPidAlive(pid)).toBe(false);
    }
  });

  it.runIf(isWindows)('windows: returns within seconds of the parent exit while the inherited-stdio grandchild keeps running', async () => {
    const { getStrategy } = await vi.importActual<typeof import('../src/services/strategy.js')>('../src/services/strategy.js');
    const agent = makeTestLocalAgent({ os: 'windows', workFolder: process.cwd() });
    const script = repro.buildOrphanPipeParentScript();

    const started = Date.now();
    // Pre-fix this call never resolves: it rejects at the 20 s inactivity
    // deadline (or hangs for the full dispatch timeout in production), because
    // `close` waits for every holder of the stdio handles to let go.
    const result = await getStrategy(agent).execCommand(script, 20_000);
    const elapsed = Date.now() - started;

    const m = /GRANDCHILD_PID:(\d+)/.exec(result.stdout);
    expect(m).not.toBeNull();
    const grandchildPid = Number(m![1]);
    survivors.push(grandchildPid);

    // The grandchild MUST survive the dispatch -- the deploy phase's sandbox
    // pair is expected to still be listening when the integ phase arrives.
    expect(repro.isPidAlive(grandchildPid)).toBe(true);
    // Completion is driven by the parent's exit plus the drain window, not by
    // the grandchild's lifetime.
    expect(elapsed).toBeLessThan(15_000);
    // eslint-disable-next-line no-console
    console.log(`[grandchild-pins-pipe] elapsed=${elapsed}ms grandchildPid=${grandchildPid} aliveAfterDispatch=true`);
  }, 60_000);

  it.runIf(!isWindows)('non-windows: wrapper shape only -- process-exit completion is Windows-scoped and POSIX is untouched', async () => {
    const { completesOnProcessExit, exitDrainMs, DEFAULT_EXIT_DRAIN_MS } =
      await import('../src/services/exit-drain.js');
    expect(completesOnProcessExit('windows')).toBe(true);
    expect(completesOnProcessExit('linux')).toBe(false);
    expect(completesOnProcessExit('macos')).toBe(false);
    expect(completesOnProcessExit(undefined)).toBe(false);
    expect(DEFAULT_EXIT_DRAIN_MS).toBeGreaterThan(0);
    expect(exitDrainMs()).toBe(300); // honours FLEET_EXIT_DRAIN_MS from beforeEach

    // The parent script the reproduction runs starts its grandchild with
    // inherited handles -- nothing redirected -- which is the mechanism that
    // pins the pipe on Windows.
    const script: string = repro.buildOrphanPipeParentScript();
    expect(script).toContain('UseShellExecute = $false');
    expect(script).not.toContain('RedirectStandardOutput');
    expect(script).toContain('GRANDCHILD_PID');
  });

  it('the production drain default is a short, bounded window', async () => {
    const { exitDrainMs, DEFAULT_EXIT_DRAIN_MS } = await import('../src/services/exit-drain.js');
    const saved = process.env.FLEET_EXIT_DRAIN_MS;
    delete process.env.FLEET_EXIT_DRAIN_MS;
    try {
      expect(exitDrainMs()).toBe(DEFAULT_EXIT_DRAIN_MS);
      expect(DEFAULT_EXIT_DRAIN_MS).toBeLessThanOrEqual(5000);
      process.env.FLEET_EXIT_DRAIN_MS = 'not-a-number';
      expect(exitDrainMs()).toBe(DEFAULT_EXIT_DRAIN_MS);
    } finally {
      if (saved === undefined) delete process.env.FLEET_EXIT_DRAIN_MS;
      else process.env.FLEET_EXIT_DRAIN_MS = saved;
    }
  });
});
