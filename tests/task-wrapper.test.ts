import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateTaskWrapper, generateTaskWrapperWindows } from '../src/services/cloud/task-wrapper.js';

const baseConfig = {
  taskId: 'task-abc123',
  command: 'python train.py',
  maxRetries: 3,
  activityIntervalSec: 300,
};

describe('generateTaskWrapper - python3 removal', () => {
  it('output contains no python3 reference', () => {
    const script = generateTaskWrapper(baseConfig);
    expect(script).not.toContain('python3');
  });

  it('uses grep + cut to extract started timestamp', () => {
    const script = generateTaskWrapper(baseConfig);
    expect(script).toContain('grep -o');
    expect(script).toContain('cut -d');
    expect(script).toContain('"started"');
  });

  it('has fallback to date if started is empty', () => {
    const script = generateTaskWrapper(baseConfig);
    // The fallback: [ -z "$started" ] && started=$(date ...)
    expect(script).toContain('[ -z');
    expect(script).toContain('started=$(date -u +%Y-%m-%dT%H:%M:%SZ)');
  });
});

describe('generateTaskWrapper - TASK_DIR uses $HOME (not tilde)', () => {
  it('TASK_DIR contains $HOME/.fleet-tasks/', () => {
    const script = generateTaskWrapper(baseConfig);
    expect(script).toContain('TASK_DIR="$HOME/.fleet-tasks/');
  });

  it('does not contain a quoted literal tilde path', () => {
    const script = generateTaskWrapper(baseConfig);
    expect(script).not.toContain('"~/.fleet-tasks');
  });
});

describe('generateTaskWrapper - restart_command (F1)', () => {
  it('MAIN_CMD and RESTART_CMD are same base64 when restartCommand is omitted', () => {
    const script = generateTaskWrapper(baseConfig);
    const mainMatch = script.match(/MAIN_CMD=\$\(printf '%s' '([^']+)'/);
    const restartMatch = script.match(/RESTART_CMD=\$\(printf '%s' '([^']+)'/);
    expect(mainMatch).not.toBeNull();
    expect(restartMatch).not.toBeNull();
    expect(mainMatch![1]).toBe(restartMatch![1]);
  });

  it('MAIN_CMD and RESTART_CMD are different when restartCommand is provided', () => {
    const script = generateTaskWrapper({
      ...baseConfig,
      restartCommand: 'python train.py --resume ckpt.pt',
    });
    const mainMatch = script.match(/MAIN_CMD=\$\(printf '%s' '([^']+)'/);
    const restartMatch = script.match(/RESTART_CMD=\$\(printf '%s' '([^']+)'/);
    expect(mainMatch).not.toBeNull();
    expect(restartMatch).not.toBeNull();
    expect(mainMatch![1]).not.toBe(restartMatch![1]);
  });

  it('first run uses MAIN_CMD', () => {
    const script = generateTaskWrapper(baseConfig);
    // First bash -c invocation should use MAIN_CMD
    expect(script).toContain('bash -c "$MAIN_CMD"');
  });

  it('retry loop uses RESTART_CMD', () => {
    const script = generateTaskWrapper(baseConfig);
    // Inside the while loop: bash -c "$RESTART_CMD"
    expect(script).toContain('bash -c "$RESTART_CMD"');
  });
});

describe('generateTaskWrapperWindows - structure', () => {
  it('writes task.pid, status.json and task.log under $TaskDir', () => {
    const script = generateTaskWrapperWindows(baseConfig);
    expect(script).toContain('$TaskDir\\task.pid');
    expect(script).toContain('$TaskDir\\status.json');
    expect(script).toContain('$TaskDir\\task.log');
  });

  it('MainCmd and RestartCmd are same base64 when restartCommand is omitted', () => {
    const script = generateTaskWrapperWindows(baseConfig);
    const mainMatch = script.match(/\$MainCmd = \[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('([^']+)'\)\)/);
    const restartMatch = script.match(/\$RestartCmd = \[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('([^']+)'\)\)/);
    expect(mainMatch).not.toBeNull();
    expect(restartMatch).not.toBeNull();
    expect(mainMatch![1]).toBe(restartMatch![1]);
  });

  it('MainCmd and RestartCmd differ when restartCommand is provided', () => {
    const script = generateTaskWrapperWindows({
      ...baseConfig,
      restartCommand: 'python train.py --resume ckpt.pt',
    });
    const mainMatch = script.match(/\$MainCmd = \[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('([^']+)'\)\)/);
    const restartMatch = script.match(/\$RestartCmd = \[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('([^']+)'\)\)/);
    expect(mainMatch).not.toBeNull();
    expect(restartMatch).not.toBeNull();
    expect(mainMatch![1]).not.toBe(restartMatch![1]);
  });

  it('first run uses Invoke-Expression $MainCmd, retry loop uses $RestartCmd', () => {
    const script = generateTaskWrapperWindows(baseConfig);
    expect(script).toContain('Invoke-Expression $MainCmd');
    expect(script).toContain('Invoke-Expression $RestartCmd');
    // $RestartCmd invocation must live after the retry loop's `while` header.
    expect(script.indexOf('while ($ExitCode -ne 0')).toBeLessThan(script.indexOf('Invoke-Expression $RestartCmd'));
  });

  it('retries stop at MaxRetries', () => {
    const script = generateTaskWrapperWindows(baseConfig);
    expect(script).toContain('$MaxRetries = 3');
    expect(script).toContain('$Retries -lt $MaxRetries');
  });

  it('F3 activity marker loop polls the wrapper\'s own $PID, not a child of the wrapped command', () => {
    const script = generateTaskWrapperWindows(baseConfig);
    expect(script).toContain('Get-Process -Id $ParentPid');
    expect(script).toContain('-ArgumentList $TaskDir, $PID, $ActivityInterval');
  });

  // Regression test for the "cmdlet failure reported as success" defect:
  // $LASTEXITCODE is only ever set by native (non-cmdlet) commands, so a
  // wrapper that trusted $LASTEXITCODE alone would compute $ExitCode = 0
  // for a failing PowerShell cmdlet and silently make $MaxRetries inert for
  // that whole class of failure (see the live-verified table in the
  // describe.runIf block below). These assertions pin the generated
  // script's structure so that regression can't reappear silently.
  //
  // The implementation went through two prior shapes, both live-verified
  // and both replaced:
  //   1. $LASTEXITCODE alone -- missed cmdlet-only failures entirely.
  //   2. $Error.Count before/after each Invoke-Expression call -- caught
  //      cmdlet failures, but $Error also accumulates any handled/
  //      suppressed error (native stderr-while-exit-0, a command's own
  //      -ErrorAction SilentlyContinue, an error the user's own try/catch
  //      already handled), so it wrongly failed those three cases too and
  //      burned through $MaxRetries re-running commands that had already
  //      succeeded.
  // The current shape instead scopes $ErrorActionPreference = "Stop" around
  // each Invoke-Expression call: a non-terminating cmdlet error the user did
  // not explicitly downgrade becomes a real terminating exception (caught
  // below, ExitCode 1+), while a command's own -ErrorAction override or its
  // own try/catch keeps running past its error exactly as intended, so
  // ExitCode stays 0 for those. Native command stderr is deliberately left
  // unredirected (only streams 1/3/4/5/6 go to task.log) because on Windows
  // PowerShell, redirecting a native command's stderr at all reclassifies
  // it as a non-terminating ErrorRecord, which "Stop" would then wrongly
  // promote to a terminating exception for a perfectly successful command.
  it('does not compute $ExitCode from $LASTEXITCODE alone -- also accounts for a non-native (cmdlet) failure', () => {
    const script = generateTaskWrapperWindows(baseConfig);
    // The naive/buggy form that only ever reports native exit codes:
    expect(script).not.toMatch(/\$ExitCode = if \(\$LASTEXITCODE\) \{ \$LASTEXITCODE \} else \{ 0 \}/);
    // The replaced $Error.Count-based shape must be gone -- it false-failed
    // suppressed/handled errors and successful-but-noisy native commands.
    expect(script).not.toContain('$Error.Clear()');
    expect(script).not.toMatch(/\$HadCmdletError/);
    // Current shape: scope $ErrorActionPreference to "Stop" around the
    // command, compute ExitCode from $LASTEXITCODE when a native command
    // set it, and reset the preference in `finally` so it never leaks into
    // the wrapper's own bookkeeping below.
    expect(script).toContain('$ErrorActionPreference = "Stop"');
    expect(script).toContain('$ErrorActionPreference = "Continue"');
    expect(script).toMatch(/\$ExitCode = if \(\$null -ne \$LASTEXITCODE\) \{ \$LASTEXITCODE \} else \{ 0 \}/);
    expect(script).toMatch(/\$ExitCode = if \(\$null -ne \$LASTEXITCODE\) \{ \$LASTEXITCODE \} else \{ 1 \}/);
    // Error stream (2) must not be merged into the log redirection -- only
    // 1/3/4/5/6 -- to avoid Windows PowerShell reclassifying a successful
    // native command's stderr as a terminating error under "Stop".
    expect(script).toContain('3>&1 4>&1 5>&1 6>&1 1>>');
  });
});

// Only run the live PowerShell assertions where a real `powershell` binary is
// available (Windows dev machines / windows-latest CI runners). Other
// platforms in the CI OS matrix skip this without failing the suite.
// See tests/windows-powershell-error-handling.test.ts for the established
// hasPowerShell / describe.runIf pattern this follows.
const hasPowerShell = (() => {
  try {
    execSync('powershell -Command "$true"', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(hasPowerShell)('generateTaskWrapperWindows - live PowerShell exit-code/status semantics', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'task-wrapper-win-'));

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runScenario(taskId: string, command: string): { status: string; exitCode: number } {
    const script = generateTaskWrapperWindows({
      taskId,
      command,
      maxRetries: 0,
      activityIntervalSec: 300,
    });
    const scriptPath = join(tmpDir, `${taskId}.ps1`);
    writeFileSync(scriptPath, script);
    try {
      execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, { stdio: 'ignore' });
    } catch {
      // A non-zero wrapper exit code throws under execSync -- expected for
      // the failing scenarios; the real signal is status.json, read below.
    }
    const taskDir = join(process.env.USERPROFILE ?? '', '.fleet-tasks', taskId);
    const status = JSON.parse(readFileSync(join(taskDir, 'status.json'), 'utf-8'));
    rmSync(taskDir, { recursive: true, force: true });
    return { status: status.status, exitCode: status.exitCode };
  }

  it('a failing cmdlet (Get-Item on a missing path) is reported as failed, not completed', () => {
    // This is the exact defect: under $ErrorActionPreference = 'Continue',
    // Get-Item on a missing path never throws and never sets $LASTEXITCODE,
    // so a wrapper relying on $LASTEXITCODE alone would report "completed"/0.
    const result = runScenario('wt-cmdlet-fail-' + Date.now(), 'Get-Item C:\\this\\path\\does\\not\\exist-fleet-test');
    expect(result.status).toBe('failed');
    expect(result.exitCode).not.toBe(0);
  });

  it('an explicit Write-Error is reported as failed, not completed', () => {
    const result = runScenario('wt-write-error-' + Date.now(), "Write-Error 'boom'");
    expect(result.status).toBe('failed');
    expect(result.exitCode).not.toBe(0);
  });

  it('a failing native command preserves its real exit code', () => {
    const result = runScenario('wt-native-fail-' + Date.now(), 'cmd /c exit 5');
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(5);
  });

  it('a successful command is reported as completed with exit code 0', () => {
    const result = runScenario('wt-success-' + Date.now(), 'Write-Output hello');
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
  });

  // These three cover the false-failure regressions introduced by the prior
  // $Error.Count-based approach: all three are legitimately successful runs
  // that must NOT be reported as failed (and must not burn a retry).
  it('a native command that writes to stderr but exits 0 is reported as completed', () => {
    // git/npm/curl/etc. routinely write progress/warnings to stderr on a
    // normal successful run. On Windows PowerShell, redirecting a native
    // command's stderr at all makes PowerShell reclassify that text as a
    // non-terminating ErrorRecord (verified live), so a wrapper that merges
    // the error stream into its log capture while running under
    // $ErrorActionPreference = "Stop" would wrongly throw and report
    // failed/1 here.
    const result = runScenario('wt-stderr-ok-' + Date.now(), 'cmd /c "echo warn 1>&2"');
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
  });

  it('a command using -ErrorAction SilentlyContinue is reported as completed', () => {
    // The user explicitly downgraded this cmdlet's error handling; that
    // per-call -ErrorAction override takes precedence over the wrapper's
    // ambient $ErrorActionPreference = "Stop", so it must not throw.
    const result = runScenario(
      'wt-silently-continue-' + Date.now(),
      'Get-Item C:\\this\\path\\does\\not\\exist-fleet-test -ErrorAction SilentlyContinue'
    );
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
  });

  it('a command that handles its own error in try/catch is reported as completed', () => {
    const result = runScenario(
      'wt-try-catch-' + Date.now(),
      "try { Get-Item C:\\this\\path\\does\\not\\exist-fleet-test -ErrorAction Stop } catch { Write-Host 'handled' }"
    );
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
  });

  it('a false-failure scenario (stderr-only, SilentlyContinue, handled try/catch) does not burn a retry', () => {
    const script = generateTaskWrapperWindows({
      taskId: 'wt-no-retry-burn-' + Date.now(),
      command: 'cmd /c "echo warn 1>&2"',
      maxRetries: 3,
      activityIntervalSec: 300,
    });
    const scriptPath = join(tmpDir, 'wt-no-retry-burn.ps1');
    writeFileSync(scriptPath, script);
    try {
      execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, { stdio: 'ignore' });
    } catch {
      // expected to not throw here, but keep symmetry with runScenario()
    }
    // Read retries straight from status.json written under the real taskId
    // embedded in the generated script.
    const match = script.match(/\$TaskId = '([^']+)'/);
    const taskDirReal = join(process.env.USERPROFILE ?? '', '.fleet-tasks', match![1]);
    const status = JSON.parse(readFileSync(join(taskDirReal, 'status.json'), 'utf-8'));
    rmSync(taskDirReal, { recursive: true, force: true });
    expect(status.status).toBe('completed');
    expect(status.retries).toBe(0);
  });
});
