/**
 * Task wrapper script generator for long-running background commands.
 *
 * Features:
 *   F1: restart_command used on retry runs (e.g. checkpoint resume)
 *   F3: background activity loop touches ~/.fleet-tasks/<taskId>/activity every
 *       activityIntervalSec while the main PID is alive — keeps idle manager from
 *       stopping the instance during active work.
 */

export interface TaskConfig {
  taskId: string;
  command: string;
  restartCommand?: string;  // F1: different cmd on retry (checkpoint resume)
  maxRetries: number;
  activityIntervalSec: number;  // F3: background marker touch interval
}

/**
 * Generate a self-contained bash wrapper script for a long-running task.
 * Commands are base64-encoded to avoid shell escaping issues.
 *
 * The script:
 *   1. Creates ~/.fleet-tasks/<taskId>/ directory
 *   2. Writes PID to task.pid
 *   3. Writes JSON status to status.json
 *   4. Background loop: touches activity file every activityIntervalSec while PID alive (F3)
 *   5. Runs command; on non-zero exit retries up to maxRetries using restartCommand (F1)
 *   6. On success or max retries: updates status.json, removes task.pid
 */
export function generateTaskWrapper(config: TaskConfig): string {
  const cmdB64 = Buffer.from(config.command).toString('base64');
  const restartB64 = Buffer.from(config.restartCommand ?? config.command).toString('base64');
  const taskDir = `$HOME/.fleet-tasks/${config.taskId}`;

  // We build the bash script as an array of lines then join, using
  // plain string concatenation for shell $VAR references to avoid
  // TypeScript template-literal interpolation of ${...}.
  const D = '$';   // single $ — used for bash variable references
  const lines: string[] = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    'TASK_ID="' + config.taskId + '"',
    'TASK_DIR="' + taskDir + '"',
    'MAX_RETRIES=' + config.maxRetries,
    'ACTIVITY_INTERVAL=' + config.activityIntervalSec,
    '',
    'mkdir -p "' + D + 'TASK_DIR"',
    '',
    '# Decode commands from base64 to avoid shell escaping issues',
    'MAIN_CMD=$(printf \'%s\' \'' + cmdB64 + '\' | base64 -d)',
    'RESTART_CMD=$(printf \'%s\' \'' + restartB64 + '\' | base64 -d)',
    '',
    '# Write / update status.json',
    'write_status() {',
    '  local status="' + D + '1"',
    '  local exit_code="' + D + '{2:-null}"',
    '  local retries="' + D + '{3:-0}"',
    '  printf \'{"taskId":"%s","status":"%s","started":"%s","updated":"%s","exitCode":%s,"retries":%s}\\n\' \\',
    '    "' + D + 'TASK_ID" "' + D + 'status" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "' + D + 'exit_code" "' + D + 'retries" \\',
    '    > "' + D + 'TASK_DIR/status.json"',
    '}',
    '',
    'update_status() {',
    '  local status="' + D + '1"',
    '  local exit_code="' + D + '{2:-null}"',
    '  local retries="' + D + '{3:-0}"',
    '  local started',
    // Pure bash: grep/cut to extract started timestamp from our own single-line JSON format.
    // Safe because write_status uses printf + date -u which never produces escaped quotes.
    // Fallback to current date if status.json is missing or the field is absent.
    '  started=$(grep -o \'"started":"[^"]*"\' "' + D + 'TASK_DIR/status.json" 2>/dev/null | head -1 | cut -d\'"\' -f4)',
    '  [ -z "' + D + 'started" ] && started=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    '  printf \'{"taskId":"%s","status":"%s","started":"%s","updated":"%s","exitCode":%s,"retries":%s}\\n\' \\',
    '    "' + D + 'TASK_ID" "' + D + 'status" "' + D + 'started" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "' + D + 'exit_code" "' + D + 'retries" \\',
    '    > "' + D + 'TASK_DIR/status.json"',
    '}',
    '',
    'write_status "running" null 0',
    '',
    '# Write our PID',
    'echo ' + D + D + ' > "' + D + 'TASK_DIR/task.pid"',
    '',
    '# F3: Background activity marker loop',
    '(',
    '  while kill -0 ' + D + D + ' 2>/dev/null; do',
    '    touch "' + D + 'TASK_DIR/activity"',
    '    sleep ' + D + 'ACTIVITY_INTERVAL',
    '  done',
    ') &',
    'ACTIVITY_PID=' + D + '!',
    '',
    '# Run with retries (F1: use RESTART_CMD after first attempt)',
    'RETRIES=0',
    'EXIT_CODE=0',
    '',
    '# First run: use MAIN_CMD',
    'bash -c "' + D + 'MAIN_CMD" >> "' + D + 'TASK_DIR/task.log" 2>&1 || EXIT_CODE=' + D + '?',
    '',
    'while [ ' + D + 'EXIT_CODE -ne 0 ] && [ ' + D + 'RETRIES -lt ' + D + 'MAX_RETRIES ]; do',
    '  RETRIES=$((' + D + 'RETRIES + 1))',
    '  update_status "retrying" ' + D + 'EXIT_CODE ' + D + 'RETRIES',
    '  echo "[fleet-task] retry ' + D + 'RETRIES/' + D + 'MAX_RETRIES at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "' + D + 'TASK_DIR/task.log"',
    '  EXIT_CODE=0',
    '  # F1: use restart command on retries',
    '  bash -c "' + D + 'RESTART_CMD" >> "' + D + 'TASK_DIR/task.log" 2>&1 || EXIT_CODE=' + D + '?',
    'done',
    '',
    '# Kill activity loop',
    'kill ' + D + 'ACTIVITY_PID 2>/dev/null || true',
    '',
    '# Remove PID file',
    'rm -f "' + D + 'TASK_DIR/task.pid"',
    '',
    'if [ ' + D + 'EXIT_CODE -eq 0 ]; then',
    '  update_status "completed" 0 ' + D + 'RETRIES',
    'else',
    '  update_status "failed" ' + D + 'EXIT_CODE ' + D + 'RETRIES',
    'fi',
    '',
    'exit ' + D + 'EXIT_CODE',
  ];

  return lines.join('\n') + '\n';
}

/**
 * Generate a self-contained PowerShell wrapper script for a long-running
 * task on a Windows member. Mirrors generateTaskWrapper()'s bash script
 * feature-for-feature (status.json shape, task.pid, task.log, F3 activity
 * marker, F1 retry-with-restart-command) so monitor_task's Windows branch
 * (src/tools/monitor-task.ts, already built to read
 * $env:USERPROFILE\.fleet-tasks\<taskId>\{status.json,task.pid,task.log})
 * needs no changes.
 *
 * The launcher (execute-command.ts) writes this script to
 * $env:USERPROFILE\.fleet-tasks\<taskId>\run.ps1 and starts it detached via
 * `Invoke-CimMethod -ClassName Win32_Process -MethodName Create` -- spawning
 * through the WMI provider host (session 0) rather than as a child of the
 * current process, so the task survives the SSH session's job object being
 * torn down when the channel closes (verified live: a plain background
 * launch dies with the SSH channel; Win32_Process.Create does not).
 */
export function generateTaskWrapperWindows(config: TaskConfig): string {
  const cmdB64 = Buffer.from(config.command, 'utf-8').toString('base64');
  const restartB64 = Buffer.from(config.restartCommand ?? config.command, 'utf-8').toString('base64');
  const taskId = config.taskId.replace(/'/g, "''");

  const lines: string[] = [
    "$ErrorActionPreference = 'Continue'",
    `$TaskId = '${taskId}'`,
    '$TaskDir = "$env:USERPROFILE\\.fleet-tasks\\$TaskId"',
    `$MaxRetries = ${config.maxRetries}`,
    `$ActivityInterval = ${config.activityIntervalSec}`,
    'New-Item -Path $TaskDir -ItemType Directory -Force | Out-Null',
    '',
    '# Decode commands from base64 to avoid script-embedding escaping issues',
    `$MainCmd = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${cmdB64}'))`,
    `$RestartCmd = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${restartB64}'))`,
    '',
    'function Write-TaskStatus($status, $exitCode, $retries, $started) {',
    '  $obj = [ordered]@{',
    '    taskId = $TaskId',
    '    status = $status',
    '    started = $started',
    "    updated = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')",
    '    exitCode = $exitCode',
    '    retries = $retries',
    '  }',
    '  ($obj | ConvertTo-Json -Compress) | Set-Content -Path "$TaskDir\\status.json" -NoNewline',
    '}',
    '',
    "$StartedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')",
    'Write-TaskStatus "running" $null 0 $StartedAt',
    '',
    '# Write our own PID (this script process, not the CIM launcher call)',
    'Set-Content -Path "$TaskDir\\task.pid" -Value $PID -NoNewline',
    '',
    '# F3: background activity marker loop, mirrors the bash wrapper\'s `kill -0` poll',
    '$ActivityJob = Start-Job -ScriptBlock {',
    '  param($Dir, $ParentPid, $Interval)',
    '  while (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {',
    '    Get-Date | Out-File -FilePath "$Dir\\activity" -Force',
    '    Start-Sleep -Seconds $Interval',
    '  }',
    '} -ArgumentList $TaskDir, $PID, $ActivityInterval',
    '',
    '$Retries = 0',
    '$ExitCode = 0',
    '$LASTEXITCODE = $null',
    'try {',
    // Comparing $Error.Count before/after Invoke-Expression (the previous
    // approach) correctly catches failing cmdlets, but $Error accumulates
    // ANY handled/suppressed error during the command's run, not just fatal
    // ones -- a native command that writes to stderr while exiting 0, a
    // cmdlet call using -ErrorAction SilentlyContinue, or a cmdlet error the
    // user's own try/catch already handled all leave a stray $Error entry,
    // so that approach wrongly reported completed work as failed/1 and
    // burned through $MaxRetries re-running commands that already
    // succeeded (verified live). Flipping $ErrorActionPreference to "Stop"
    // for the duration of the user's command instead makes any
    // non-terminating cmdlet error the user did NOT explicitly downgrade
    // (no -ErrorAction override, no enclosing try/catch) throw a real
    // terminating exception, which this try/catch turns into ExitCode 1 --
    // mirroring how the bash wrapper's `bash -c "$MAIN_CMD" || EXIT_CODE=$?`
    // only fails on the child's own real exit status. A command that sets
    // its own -ErrorAction (SilentlyContinue/Continue/Ignore) or that
    // catches its own error keeps running past it, exactly as the user
    // intended, so $ExitCode stays 0 for those cases (verified live).
    // $ErrorActionPreference is reset in `finally` so this scoped
    // strictness never leaks into the wrapper's own bookkeeping
    // (Write-TaskStatus, activity job, etc.) below.
    //
    // The log redirection deliberately merges streams 3/4/5/6 (Warning/
    // Verbose/Debug/Information) into stream 1 (Output) but leaves stream 2
    // (Error) unredirected -- on Windows PowerShell, redirecting a NATIVE
    // command's stderr with *any* stream-2 syntax (*>>, 2>&1, 2>$null, ...)
    // makes PowerShell wrap that stderr text as a non-terminating
    // ErrorRecord, which $ErrorActionPreference = "Stop" above then
    // promotes to a terminating exception -- so a perfectly successful
    // native command that merely logs to stderr (git/npm/curl/etc.) would
    // throw and be reported failed/1 (verified live). Leaving stream 2
    // unredirected sidesteps that reclassification entirely: native stderr
    // just flows to the process's inherited stderr handle as before, and a
    // real cmdlet failure still throws under "Stop" regardless of stream
    // redirection (that promotion is not redirection-triggered). Tradeoff:
    // stderr text from a *successful* native command no longer lands in
    // task.log; a failing NATIVE command's stderr is also lost this way
    // (it throws nothing, so the catch block below never runs) -- only a
    // failing cmdlet's exception detail is captured. Linux's `2>&1` has no
    // such gap. Accepted tradeoff for now (see PR #405 review).
    //
    // In the catch block, $LASTEXITCODE must be checked for TRUTHINESS, not
    // just non-null: after a successful native command sets it to 0, a
    // SUBSEQUENT cmdlet failure in the same $MainCmd (e.g.
    // `git pull; Get-Content missing.json`) throws under "Stop" and lands
    // here with $LASTEXITCODE still the stale 0 from the earlier native
    // call -- `$null -ne 0` is true, so that stale 0 would wrongly report
    // the genuine failure as ExitCode 0 (verified live). `if ($LASTEXITCODE)`
    // treats 0 as falsy and correctly falls through to the exception-implies-
    // failure default of 1, while still preferring a real nonzero native
    // code (e.g. the failure was `cmd /c exit 7`) when one is set.
    '  $ErrorActionPreference = "Stop"',
    '  Invoke-Expression $MainCmd 3>&1 4>&1 5>&1 6>&1 1>> "$TaskDir\\task.log"',
    '  $ExitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }',
    '} catch {',
    '  "$_" | Out-File -FilePath "$TaskDir\\task.log" -Append',
    '  $ExitCode = if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }',
    '} finally {',
    '  $ErrorActionPreference = "Continue"',
    '}',
    '',
    'while ($ExitCode -ne 0 -and $Retries -lt $MaxRetries) {',
    '  $Retries++',
    '  Write-TaskStatus "retrying" $ExitCode $Retries $StartedAt',
    "  \"[fleet-task] retry $Retries/$MaxRetries at $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))\" | Out-File -FilePath \"$TaskDir\\task.log\" -Append",
    '  $ExitCode = 0',
    '  $LASTEXITCODE = $null',
    '  try {',
    '    $ErrorActionPreference = "Stop"',
    '    Invoke-Expression $RestartCmd 3>&1 4>&1 5>&1 6>&1 1>> "$TaskDir\\task.log"',
    '    $ExitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }',
    '  } catch {',
    '    "$_" | Out-File -FilePath "$TaskDir\\task.log" -Append',
    '    $ExitCode = if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 }',
    '  } finally {',
    '    $ErrorActionPreference = "Continue"',
    '  }',
    '}',
    '',
    'Stop-Job $ActivityJob -ErrorAction SilentlyContinue | Out-Null',
    'Remove-Job $ActivityJob -ErrorAction SilentlyContinue | Out-Null',
    'Remove-Item -Path "$TaskDir\\task.pid" -Force -ErrorAction SilentlyContinue',
    '',
    'if ($ExitCode -eq 0) {',
    '  Write-TaskStatus "completed" 0 $Retries $StartedAt',
    '} else {',
    '  Write-TaskStatus "failed" $ExitCode $Retries $StartedAt',
    '}',
    '',
    'exit $ExitCode',
  ];

  return lines.join('\n') + '\n';
}
