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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, makeTestLocalAgent, backupAndResetRegistry, restoreRegistry, resultText } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executeCommand } from '../src/tools/execute-command.js';
import { getTaskCredentials } from '../src/services/credential-store.js';
import type { SSHExecResult } from '../src/types.js';

const { mockExecCommand } = vi.hoisted(() => ({
  mockExecCommand: vi.fn<(cmd: string, timeout?: number, maxTotalMs?: number, onPidCaptured?: (pid: number) => void) => Promise<SSHExecResult>>(),
}));

/**
 * apra-fleet-qe83.8: the exit-drain completion path is OS-gated
 * (completesOnProcessExit() is true only for a Windows member), but the
 * late-output guarantee it provides is not Windows-specific logic -- it is
 * plain strategy.ts control flow. Rather than let the assertion silently skip
 * on a POSIX member (the failure mode this sprint already paid for once), the
 * predicate is forced on for that one test via this passthrough mock, so the
 * SAME real strategy.ts exit-drain branch runs on every member OS.
 *
 * `force` defaults to false, so every other test in this file still sees the
 * genuine, unmodified predicate (including the wrapper-shape test below, which
 * asserts completesOnProcessExit('linux') === false).
 */
const drainCtl = vi.hoisted(() => ({ force: false }));

vi.mock('../src/services/exit-drain.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/exit-drain.js')>();
  return {
    ...actual,
    completesOnProcessExit: (agentOs: string | undefined) =>
      drainCtl.force || actual.completesOnProcessExit(agentOs),
  };
});

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

const LATE_MARKER = 'LATE_OUTPUT_MARKER';
const TEST_DRAIN_MS = 300;

/**
 * apra-fleet-qe83.8 (local half). A PORTABLE stand-in for the PowerShell
 * reproduction in scripts/repro/win-orphan-pipe.mjs: a node parent that
 * spawns a DETACHED grandchild inheriting fd 1/2, prints a burst of output,
 * and then writes one last marker immediately before exiting.
 *
 * Why the detached grandchild matters: it holds the write end of the dispatch
 * pipe open, so `child.on('close')` (the other -- and much easier -- path to
 * finalize()) can NEVER fire during the test. The only way the dispatch can
 * settle at all is the exit-drain timer, which is exactly the code path under
 * test. Without the grandchild this assertion would be vacuous: `close` would
 * deliver the marker and the test would pass with the drain branch disabled.
 *
 * Why the write callback: writes to a pipe are asynchronous on every platform,
 * and a bare process.exit() right after write() can truncate them. Exiting
 * from inside the write callback means the bytes are already handed to the OS
 * pipe, so "output written immediately before exit" is tested deterministically
 * instead of racing Node's stdout flush (criterion 5: no sleep-based flake).
 */
function buildLateOutputParentScript(): string {
  return [
    "import { spawn } from 'node:child_process';",
    "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], {",
    '  detached: true,',
    "  stdio: ['ignore', 1, 2],",
    '});',
    'g.unref();',
    "process.stdout.write('GRANDCHILD_PID:' + g.pid + '\\n');",
    "for (let i = 0; i < 50; i++) process.stdout.write('filler line ' + i + '\\n');",
    `process.stdout.write('${LATE_MARKER}\\n', () => { process.exit(0); });`,
    '',
  ].join('\n');
}

/** Shell-correct invocation of a node script for the member's own shell. */
function nodeScriptCommand(scriptPath: string): string {
  // getOsCommands().cleanExec() resolves powershell.exe on a Windows member
  // and /bin/bash on a POSIX one; PowerShell needs the call operator to run a
  // quoted executable path.
  return isWindows
    ? `& "${process.execPath}" "${scriptPath}"`
    : `"${process.execPath}" "${scriptPath}"`;
}

describe('grandchild-pins-pipe: a dispatch completes when the process exits, not when the pipe EOFs', () => {
  const survivors: number[] = [];
  const tempScripts: string[] = [];
  let repro: any;
  const savedDrain = process.env.FLEET_EXIT_DRAIN_MS;

  beforeEach(async () => {
    repro = await import('../scripts/repro/win-orphan-pipe.mjs' as any);
    // Keep the drain window short so the test stays fast; production default
    // (2000 ms) is asserted separately below.
    process.env.FLEET_EXIT_DRAIN_MS = String(TEST_DRAIN_MS);
  });

  afterEach(() => {
    drainCtl.force = false;
    if (savedDrain === undefined) delete process.env.FLEET_EXIT_DRAIN_MS;
    else process.env.FLEET_EXIT_DRAIN_MS = savedDrain;
    // Nothing this test started may survive it (verified with tasklist).
    for (const pid of survivors.splice(0)) {
      repro.killPidTree(pid);
      expect(repro.isPidAlive(pid)).toBe(false);
    }
    // ...and no temp file either: the scratch scripts are the only filesystem
    // state these tests create.
    for (const p of tempScripts.splice(0)) {
      try { fs.rmSync(p, { force: true }); } catch { /* best-effort */ }
      expect(fs.existsSync(p)).toBe(false);
    }
  });

  /**
   * apra-fleet-qe83.8, criterion 1: output written by the child immediately
   * before process exit still reaches result.stdout on the local
   * (src/services/strategy.ts) path.
   *
   * Runs -- not skips -- on every member OS: the OS gate is forced via
   * drainCtl above rather than gating the test on process.platform, while the
   * spawned command itself stays shell-correct for the host. Reported member
   * OS is logged below so the run output names it (criterion 4).
   *
   * Criterion 3 note (destroy-before-finalize): the recorded hand-check on
   * this bead found the old ordering does NOT lose the marker -- 13 real
   * subprocess runs across 0 ms and 300 ms drain windows and a ~229 KB burst,
   * zero losses -- because finalize() reads stdout/stderr closure variables
   * the 'data' listeners already populated synchronously, and the
   * destroy()/unref() calls have no path that mutates them or wins the
   * settle() race. The ordering in strategy.ts is kept as a consistency
   * invariant (it matches ssh.ts and guards future drift), not as a fix for a
   * reproducible loss, and this test deliberately does NOT manufacture that
   * failure with a mocked destroy() side effect -- that would assert the mock,
   * not the product.
   */
  it('local path: output written immediately before process exit survives the exit-drain window', async () => {
    const { getStrategy } = await vi.importActual<typeof import('../src/services/strategy.js')>('../src/services/strategy.js');
    const agent = makeTestLocalAgent({ workFolder: process.cwd() });
    const scriptPath = path.join(os.tmpdir(), `fleet-late-output-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
    fs.writeFileSync(scriptPath, buildLateOutputParentScript());
    tempScripts.push(scriptPath);

    drainCtl.force = true;
    const started = Date.now();
    const result = await getStrategy(agent).execCommand(nodeScriptCommand(scriptPath), 20_000);
    const elapsed = Date.now() - started;

    const m = /GRANDCHILD_PID:(\d+)/.exec(result.stdout);
    expect(m).not.toBeNull();
    survivors.push(Number(m![1]));

    // The assertion under test.
    expect(result.stdout).toContain(LATE_MARKER);
    // ...and nothing before it was dropped either.
    expect(result.stdout).toContain('filler line 49');
    expect(result.code).toBe(0);
    // Evidence that the EXIT-DRAIN path settled this dispatch and not `close`:
    // the grandchild still holds the pipe, so `close` cannot have fired, and
    // the result could not appear sooner than the drain window.
    expect(elapsed).toBeGreaterThanOrEqual(TEST_DRAIN_MS);
    expect(repro.isPidAlive(Number(m![1]))).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`[late-output/local] memberOS=${agent.os} platform=${process.platform} elapsed=${elapsed}ms drain=${TEST_DRAIN_MS}ms marker=present`);
  }, 60_000);

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
