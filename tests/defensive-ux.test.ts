/**
 * T7: Defensive UX tests — OS warnings, GPU detection edge cases,
 * unsupported provider messages, long_running on non-linux.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executeCommand } from '../src/tools/execute-command.js';
import type { SSHExecResult } from '../src/types.js';

// ---------------------------------------------------------------------------
// Mocks for execute-command tests
// ---------------------------------------------------------------------------

const { mockExecCommand } = vi.hoisted(() => ({
  mockExecCommand: vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>(),
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
  ensureCloudReady: vi.fn((agent: any) => Promise.resolve(agent)),
}));

// ---------------------------------------------------------------------------
// T7 point 4: long_running on non-linux OS warning
// ---------------------------------------------------------------------------

describe('execute-command: long_running OS warning', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('includes OS warning when long_running on Windows agent', async () => {
    const agent = makeTestAgent({ os: 'windows' });
    addAgent(agent);

    const result = await executeCommand({
      member_id: agent.id,
      command: 'python train.py',
      long_running: true,
      timeout_ms: 5000,
    });

    expect(result).toContain('Note:');
    expect(result).toContain('windows');
    expect(result).toContain('bash wrapper');
  });

  it('includes OS warning when long_running on macOS agent', async () => {
    const agent = makeTestAgent({ os: 'macos' });
    addAgent(agent);

    const result = await executeCommand({
      member_id: agent.id,
      command: 'python train.py',
      long_running: true,
      timeout_ms: 5000,
    });

    expect(result).toContain('macos');
  });

  it('still launches task despite OS warning (does not block)', async () => {
    const agent = makeTestAgent({ os: 'windows' });
    addAgent(agent);

    const result = await executeCommand({
      member_id: agent.id,
      command: 'python train.py',
      long_running: true,
      timeout_ms: 5000,
    });

    // Both warning and successful launch
    expect(result).toContain('Task launched');
    expect(result).toContain('task_id=');
  });

  it('no OS warning when long_running on Linux agent', async () => {
    const agent = makeTestAgent({ os: 'linux' });
    addAgent(agent);

    const result = await executeCommand({
      member_id: agent.id,
      command: 'python train.py',
      long_running: true,
      timeout_ms: 5000,
    });

    expect(result).not.toContain('Note:');
    expect(result).toContain('Task launched');
  });
});

// ---------------------------------------------------------------------------
// T7 point 1: OS warning in register_member
// ---------------------------------------------------------------------------

import { registerMemberSchema } from '../src/tools/register-member.js';

describe('registerMemberSchema - cloud provider validation', () => {
  it('rejects gcp with helpful error message (T1 validation)', () => {
    const result = registerMemberSchema.shape.cloud_provider.safeParse('gcp');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('aws');
      expect(result.error.issues[0].message).toContain('GCP');
    }
  });
});

// ---------------------------------------------------------------------------
// T7 point 2: GPU detection edge cases in cloud_control status
// (The GPU check in cloud_control is tested via mock in cloud-provider.test.ts
// for the AWS call path. Here we test the parseGpuUtilization edge cases
// that cover the three states: empty (not found), numeric (%), and error.)
// ---------------------------------------------------------------------------

import { parseGpuUtilization } from '../src/utils/gpu-parser.js';

describe('GPU detection status labels', () => {
  it('empty nvidia-smi stdout → not-found case (returns undefined)', () => {
    expect(parseGpuUtilization('')).toBeUndefined();
  });

  it('0% utilization → valid 0 (distinct from not-found)', () => {
    expect(parseGpuUtilization('0')).toBe(0);
  });

  it('valid utilization % → returns number', () => {
    expect(parseGpuUtilization('45')).toBe(45);
  });

  it('driver crashed output → undefined (not-found label)', () => {
    // nvidia-smi installed but driver crashed returns non-numeric
    expect(parseGpuUtilization('NVIDIA-SMI has failed...')).toBeUndefined();
  });
});
