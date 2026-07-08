import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateTaskWrapper } from '../src/services/cloud/task-wrapper.js';

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

describe('generateTaskWrapper - task.log redaction (source-side, watch has no credential store)', () => {
  /** Run a generated wrapper under a throwaway $HOME and return its task dir contents. */
  function runWrapper(config: Parameters<typeof generateTaskWrapper>[0]): { log: string; status: any; exitCode: number } {
    const script = generateTaskWrapper(config);
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-task-test-'));
    const scriptPath = path.join(tmpHome, 'run.sh');
    fs.writeFileSync(scriptPath, script, { mode: 0o700 });
    let exitCode = 0;
    try {
      // stdio: 'ignore' -- the wrapper's F3 activity loop backgrounds a
      // long-lived `sleep`-based subshell; if it inherited a piped stdout it
      // would keep that pipe open (and execFileSync blocked) for minutes after
      // run.sh itself has already exited.
      execFileSync('bash', [scriptPath], { env: { ...process.env, HOME: tmpHome }, stdio: 'ignore' });
    } catch (err: any) {
      exitCode = typeof err.status === 'number' ? err.status : -1;
    }
    const taskDir = path.join(tmpHome, '.fleet-tasks', config.taskId);
    const log = fs.readFileSync(path.join(taskDir, 'task.log'), 'utf-8');
    const status = JSON.parse(fs.readFileSync(path.join(taskDir, 'status.json'), 'utf-8'));
    fs.rmSync(tmpHome, { recursive: true, force: true });
    return { log, status, exitCode };
  }

  it('does not add a redaction filter when no credentials are given', () => {
    const script = generateTaskWrapper(baseConfig);
    expect(script).not.toContain('redact()');
  });

  it('writes [REDACTED:NAME] to task.log instead of the plaintext secret', () => {
    const { log } = runWrapper({
      taskId: 'task-redact1',
      command: 'echo "token is SUPERSECRET1234 in the output"',
      maxRetries: 0,
      activityIntervalSec: 300,
      credentials: [{ name: 'API_KEY', plaintext: 'SUPERSECRET1234' }],
    });
    expect(log).not.toContain('SUPERSECRET1234');
    expect(log).toContain('[REDACTED:API_KEY]');
  });

  it('propagates the real (non-zero) command exit code through the redaction pipe', () => {
    const { status, exitCode } = runWrapper({
      taskId: 'task-redact2',
      command: 'echo "leaking SUPERSECRET1234"; exit 42',
      maxRetries: 0,
      activityIntervalSec: 300,
      credentials: [{ name: 'API_KEY', plaintext: 'SUPERSECRET1234' }],
    });
    expect(exitCode).toBe(42);
    expect(status.status).toBe('failed');
    expect(status.exitCode).toBe(42);
  });

  it('still reports exit code 0 / completed when the command succeeds through the redaction pipe', () => {
    const { status, exitCode, log } = runWrapper({
      taskId: 'task-redact3',
      command: 'echo "clean SUPERSECRET1234 run"',
      maxRetries: 0,
      activityIntervalSec: 300,
      credentials: [{ name: 'API_KEY', plaintext: 'SUPERSECRET1234' }],
    });
    expect(exitCode).toBe(0);
    expect(status.status).toBe('completed');
    expect(status.exitCode).toBe(0);
    expect(log).toContain('[REDACTED:API_KEY]');
  });
});
