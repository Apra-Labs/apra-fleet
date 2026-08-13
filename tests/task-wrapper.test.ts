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
  it('does not compute $ExitCode from $LASTEXITCODE alone -- also accounts for a non-native (cmdlet) failure', () => {
    const script = generateTaskWrapperWindows(baseConfig);
    // The naive/buggy form that only ever reports native exit codes:
    expect(script).not.toMatch(/\$ExitCode = if \(\$LASTEXITCODE\) \{ \$LASTEXITCODE \} else \{ 0 \}/);
    // A cmdlet-only failure (no $LASTEXITCODE set) must still be detectable
    // from the script's own bookkeeping around each Invoke-Expression call.
    expect(script).toContain('$Error.Clear()');
    expect(script).toMatch(/\$HadCmdletError = \$Error\.Count -gt 0/);
    expect(script).toMatch(/\$ExitCode = if \(\$LASTEXITCODE\) \{ \$LASTEXITCODE \} elseif \(\$HadCmdletError\) \{ 1 \} else \{ 0 \}/);
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
});
