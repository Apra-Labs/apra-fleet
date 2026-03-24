import { describe, it, expect } from 'vitest';
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
