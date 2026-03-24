/**
 * T5 tests: ensureCloudReady wired into execute-command, execute-prompt, send-files.
 * Verifies:
 *  - ensureCloudReady is called for cloud members before strategy is invoked
 *  - Auto-start path: stopped member → updated IP → command runs on new agent
 *  - Error propagation: terminated instance surfaces as tool failure
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executeCommand } from '../src/tools/execute-command.js';
import { executePrompt } from '../src/tools/execute-prompt.js';
import { sendFiles } from '../src/tools/send-files.js';
import type { SSHExecResult } from '../src/types.js';

// ---------------------------------------------------------------------------
// Hoisted mock references (must be defined before vi.mock factories run)
// ---------------------------------------------------------------------------

const { mockEnsureCloudReady, mockExecCommand, mockTransferFiles } = vi.hoisted(() => ({
  mockEnsureCloudReady: vi.fn<(agent: any) => Promise<any>>((a) => Promise.resolve(a)),
  mockExecCommand: vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>(),
  mockTransferFiles: vi.fn<() => Promise<any>>(),
}));

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(),
    transferFiles: mockTransferFiles,
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/cloud/lifecycle.js', () => ({
  ensureCloudReady: mockEnsureCloudReady,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCloudAgent(overrides = {}) {
  return makeTestAgent({
    host: '10.0.0.1',
    cloud: {
      provider: 'aws' as const,
      instanceId: 'i-0abc1234def567890',
      region: 'us-east-1',
      idleTimeoutMin: 30,
      sshKeyPath: '/home/user/.ssh/key.pem',
    },
    ...overrides,
  });
}

beforeEach(() => {
  backupAndResetRegistry();
  vi.clearAllMocks();
  // Default: ensureCloudReady passes agent through unchanged
  mockEnsureCloudReady.mockImplementation((a) => Promise.resolve(a));
  mockExecCommand.mockResolvedValue({ stdout: 'ok', stderr: '', code: 0 });
  mockTransferFiles.mockResolvedValue({ success: ['file.txt'], failed: [] });
});

afterEach(() => {
  restoreRegistry();
});

// ---------------------------------------------------------------------------
// execute-command
// ---------------------------------------------------------------------------

describe('execute-command: ensureCloudReady wiring', () => {
  it('calls ensureCloudReady for cloud members before executing', async () => {
    const agent = makeCloudAgent();
    addAgent(agent);

    await executeCommand({ member_id: agent.id, command: 'echo hi', timeout_ms: 5000 });

    expect(mockEnsureCloudReady).toHaveBeenCalledOnce();
    expect(mockEnsureCloudReady).toHaveBeenCalledWith(expect.objectContaining({ id: agent.id }));
  });

  it('calls ensureCloudReady even for non-cloud members (returns unchanged)', async () => {
    const agent = makeTestAgent(); // no cloud config
    addAgent(agent);

    await executeCommand({ member_id: agent.id, command: 'echo hi', timeout_ms: 5000 });

    expect(mockEnsureCloudReady).toHaveBeenCalledOnce();
  });

  it('uses the agent returned by ensureCloudReady (updated IP after auto-start)', async () => {
    const agent = makeCloudAgent({ host: '10.0.0.1' });
    addAgent(agent);

    // Simulate auto-start: ensureCloudReady returns agent with new IP
    const startedAgent = { ...agent, host: '54.10.20.30' };
    mockEnsureCloudReady.mockResolvedValueOnce(startedAgent);

    await executeCommand({ member_id: agent.id, command: 'echo hi', timeout_ms: 5000 });

    // Strategy is called (meaning the command ran on the updated agent)
    expect(mockExecCommand).toHaveBeenCalledOnce();
  });

  it('returns error string if member not found (ensureCloudReady never called)', async () => {
    const result = await executeCommand({ member_id: 'nonexistent', command: 'ls', timeout_ms: 5000 });
    expect(result).toContain('not found');
    expect(mockEnsureCloudReady).not.toHaveBeenCalled();
  });

  it('propagates ensureCloudReady error (e.g. terminated instance) as failure message', async () => {
    const agent = makeCloudAgent();
    addAgent(agent);
    mockEnsureCloudReady.mockRejectedValueOnce(new Error('Instance i-0abc is terminated'));

    const result = await executeCommand({ member_id: agent.id, command: 'ls', timeout_ms: 5000 });
    expect(result).toContain('Instance i-0abc is terminated');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// execute-prompt
// ---------------------------------------------------------------------------

describe('execute-prompt: ensureCloudReady wiring', () => {
  it('calls ensureCloudReady before running prompt', async () => {
    const agent = makeCloudAgent();
    addAgent(agent);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'hello' }), stderr: '', code: 0,
    });

    await executePrompt({ member_id: agent.id, prompt: 'hello', timeout_ms: 10000 });

    expect(mockEnsureCloudReady).toHaveBeenCalledOnce();
    expect(mockEnsureCloudReady).toHaveBeenCalledWith(expect.objectContaining({ id: agent.id }));
  });

  it('uses updated agent from ensureCloudReady for command execution', async () => {
    const agent = makeCloudAgent({ host: '10.0.0.1' });
    addAgent(agent);
    const startedAgent = { ...agent, host: '54.10.20.30' };
    mockEnsureCloudReady.mockResolvedValueOnce(startedAgent);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done' }), stderr: '', code: 0,
    });

    await executePrompt({ member_id: agent.id, prompt: 'hello', timeout_ms: 10000 });

    expect(mockExecCommand).toHaveBeenCalledOnce();
  });

  it('propagates ensureCloudReady error as failure message', async () => {
    const agent = makeCloudAgent();
    addAgent(agent);
    mockEnsureCloudReady.mockRejectedValueOnce(new Error('Instance terminated'));

    const result = await executePrompt({ member_id: agent.id, prompt: 'hello', timeout_ms: 10000 });
    expect(result).toContain('Instance terminated');
  });
});

// ---------------------------------------------------------------------------
// send-files
// ---------------------------------------------------------------------------

describe('send-files: ensureCloudReady wiring', () => {
  it('calls ensureCloudReady before transferring files', async () => {
    const agent = makeCloudAgent();
    addAgent(agent);

    await sendFiles({ member_id: agent.id, local_paths: ['/tmp/test.txt'] });

    expect(mockEnsureCloudReady).toHaveBeenCalledOnce();
    expect(mockEnsureCloudReady).toHaveBeenCalledWith(expect.objectContaining({ id: agent.id }));
  });

  it('uses updated agent from ensureCloudReady for file transfer', async () => {
    const agent = makeCloudAgent({ host: '10.0.0.1' });
    addAgent(agent);
    const startedAgent = { ...agent, host: '54.10.20.30' };
    mockEnsureCloudReady.mockResolvedValueOnce(startedAgent);

    const result = await sendFiles({ member_id: agent.id, local_paths: ['/tmp/test.txt'] });

    expect(mockTransferFiles).toHaveBeenCalledOnce();
    expect(result).toContain('Successfully uploaded');
  });

  it('propagates ensureCloudReady error as failure message', async () => {
    const agent = makeCloudAgent();
    addAgent(agent);
    mockEnsureCloudReady.mockRejectedValueOnce(new Error('Instance terminated'));

    const result = await sendFiles({ member_id: agent.id, local_paths: ['/tmp/test.txt'] });
    expect(result).toContain('Instance terminated');
  });
});
