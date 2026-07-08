/**
 * Task wrapper script generator for long-running background commands.
 *
 * Features:
 *   F1: restart_command used on retry runs (e.g. checkpoint resume)
 *   F3: background activity loop touches ~/.fleet-tasks/<taskId>/activity every
 *       activityIntervalSec while the main PID is alive — keeps idle manager from
 *       stopping the instance during active work.
 *
 * Secrets are redacted at the SOURCE: task.log must never contain a resolved
 * credential's plaintext, since both monitor_task and `apra-fleet watch` read
 * it directly (watch runs as a separate CLI process with no access to the MCP
 * server's in-memory credential store). Each credential's name+plaintext is
 * base64-embedded in the wrapper (same treatment as MAIN_CMD/RESTART_CMD, so
 * no new plaintext form and no separate secret file on disk) and decoded into
 * bash arrays at runtime; command output is piped through a literal
 * find-and-replace filter before it ever touches task.log.
 */

export interface TaskCredential {
  name: string;
  plaintext: string;
}

export interface TaskConfig {
  taskId: string;
  command: string;
  restartCommand?: string;  // F1: different cmd on retry (checkpoint resume)
  maxRetries: number;
  activityIntervalSec: number;  // F3: background marker touch interval
  credentials?: TaskCredential[]; // redact these values out of task.log at write time
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
 *      — output is redacted in-flight (a `redact` filter) when credentials were supplied
 *   6. On success or max retries: updates status.json, removes task.pid
 */
export function generateTaskWrapper(config: TaskConfig): string {
  const cmdB64 = Buffer.from(config.command).toString('base64');
  const restartB64 = Buffer.from(config.restartCommand ?? config.command).toString('base64');
  const taskDir = `$HOME/.fleet-tasks/${config.taskId}`;
  const credentials = config.credentials ?? [];
  const hasCredentials = credentials.length > 0;
  // Each name/secret is individually base64-encoded (no embedded newlines), then
  // joined with '\n' -- a single-quoted multi-line bash literal is fine since the
  // alphabet is [A-Za-z0-9+/=\n], nothing that needs escaping.
  const namesB64Blob = credentials.map((c) => Buffer.from(c.name).toString('base64')).join('\n');
  const secretsB64Blob = credentials.map((c) => Buffer.from(c.plaintext).toString('base64')).join('\n');

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
  ];

  if (hasCredentials) {
    lines.push(
      '# Decode task credentials for output redaction -- task.log must never see plaintext secrets',
      'SECRET_NAMES=()',
      'SECRETS=()',
      "NAMES_B64='" + namesB64Blob + "'",
      "SECRETS_B64='" + secretsB64Blob + "'",
      'while IFS= read -r _enc || [ -n "' + D + '_enc" ]; do',
      '  SECRET_NAMES+=("' + D + '(printf \'%s\' "' + D + '_enc" | base64 -d)")',
      'done <<< "' + D + 'NAMES_B64"',
      'while IFS= read -r _enc || [ -n "' + D + '_enc" ]; do',
      '  SECRETS+=("' + D + '(printf \'%s\' "' + D + '_enc" | base64 -d)")',
      'done <<< "' + D + 'SECRETS_B64"',
      '',
      '# Line-based literal redaction filter -- a secret spanning a newline is an',
      '# accepted edge case (task.log lines are redacted independently as they arrive).',
      'redact() {',
      '  local line',
      '  while IFS= read -r line || [ -n "' + D + 'line" ]; do',
      '    local i secret name',
      '    for i in "' + D + '{!SECRET_NAMES[@]}"; do',
      '      secret="' + D + '{SECRETS[' + D + 'i]}"',
      '      name="' + D + '{SECRET_NAMES[' + D + 'i]}"',
      '      [ -n "' + D + 'secret" ] && line="' + D + '{line//' + D + 'secret/[REDACTED:' + D + 'name]}"',
      '    done',
      '    printf \'%s\\n\' "' + D + 'line"',
      '  done',
      '}',
      '',
    );
  }

  lines.push(
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
  );

  if (hasCredentials) {
    lines.push(
      // `set +e` around the pipeline stops `set -e` from aborting on a non-zero
      // exit before PIPESTATUS is read. `|| true` would NOT work here: bash
      // resets PIPESTATUS after every command it runs, including a `true` that
      // only executes because the pipeline failed -- clobbering the real exit
      // code we are trying to capture.
      'set +e',
      'bash -c "' + D + 'MAIN_CMD" 2>&1 | redact >> "' + D + 'TASK_DIR/task.log"',
      'EXIT_CODE=' + D + '{PIPESTATUS[0]}',
      'set -e',
    );
  } else {
    lines.push('bash -c "' + D + 'MAIN_CMD" >> "' + D + 'TASK_DIR/task.log" 2>&1 || EXIT_CODE=' + D + '?');
  }

  lines.push(
    '',
    'while [ ' + D + 'EXIT_CODE -ne 0 ] && [ ' + D + 'RETRIES -lt ' + D + 'MAX_RETRIES ]; do',
    '  RETRIES=$((' + D + 'RETRIES + 1))',
    '  update_status "retrying" ' + D + 'EXIT_CODE ' + D + 'RETRIES',
    '  echo "[fleet-task] retry ' + D + 'RETRIES/' + D + 'MAX_RETRIES at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "' + D + 'TASK_DIR/task.log"',
    '  EXIT_CODE=0',
    '  # F1: use restart command on retries',
  );

  if (hasCredentials) {
    lines.push(
      '  set +e',
      '  bash -c "' + D + 'RESTART_CMD" 2>&1 | redact >> "' + D + 'TASK_DIR/task.log"',
      '  EXIT_CODE=' + D + '{PIPESTATUS[0]}',
      '  set -e',
    );
  } else {
    lines.push('  bash -c "' + D + 'RESTART_CMD" >> "' + D + 'TASK_DIR/task.log" 2>&1 || EXIT_CODE=' + D + '?');
  }

  lines.push(
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
  );

  return lines.join('\n') + '\n';
}
