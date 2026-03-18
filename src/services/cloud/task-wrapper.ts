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
  const taskDir = `~/.fleet-tasks/${config.taskId}`;

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
    '  started=$(python3 -c "import json; d=json.load(open(\'' + D + 'TASK_DIR/status.json\')); print(d.get(\'started\',\'\'))" 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)',
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
