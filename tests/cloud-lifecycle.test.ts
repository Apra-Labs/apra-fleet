/**
 * T5 tests: ensureCloudReady wired into execute-command, execute-prompt, send-files.
 * Verifies:
 *  - ensureCloudReady is called for cloud members before strategy is invoked
 *  - Auto-start path: stopped member → updated IP → command runs on new member
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
  mockEnsureCloudReady: vi.fn<(member: any) => Promise<any>>((a) => Promise.resolve(a)),
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
    },
    ...overrides,
  });
}

beforeEach(() => {
  backupAndResetRegistry();
  vi.clearAllMocks();
  // Default: ensureCloudReady passes member through unchanged
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
    const member = makeCloudAgent();
    addAgent(member);

    await executeCommand({ member_id: member.id, command: 'echo hi', timeout_s: 5 });

    expect(mockEnsureCloudReady).toHaveBeenCalledOnce();
    expect(mockEnsureCloudReady).toHaveBeenCalledWith(expect.objectContaining({ id: member.id }));
  });

  it('calls ensureCloudReady even for non-cloud members (returns unchanged)', async () => {
    const member = makeTestAgent(); // no cloud config
    addAgent(member);

    await executeCommand({ member_id: member.id, command: 'echo hi', timeout_s: 5 });

    expect(mockEnsureCloudReady).toHaveBeenCalledOnce();
  });

  it('uses the member returned by ensureCloudReady (updated IP after auto-start)', async () => {
    const member = makeCloudAgent({ host: '10.0.0.1' });
    addAgent(member);

    // Simulate auto-start: ensureCloudReady returns member with new IP
    const startedAgent = { ...member, host: '54.10.20.30' };
    mockEnsureCloudReady.mockResolvedValueOnce(startedAgent);

    await executeCommand({ member_id: member.id, command: 'echo hi', timeout_s: 5 });

    // Strategy is called (meaning the command ran on the updated member)
    expect(mockExecCommand).toHaveBeenCalledOnce();
  });

  it('returns error string if member not found (ensureCloudReady never called)', async () => {
    const result = await executeCommand({ member_id: 'nonexistent', command: 'ls', timeout_s: 5 });
    expect(result).toContain('not found');
    expect(mockEnsureCloudReady).not.toHaveBeenCalled();
  });

  it('propagates ensureCloudReady error (e.g. terminated instance) as failure message', async () => {
    const member = makeCloudAgent();
    addAgent(member);
    mockEnsureCloudReady.mockRejectedValueOnce(new Error('Instance i-0abc is terminated'));

    const result = await executeCommand({ member_id: member.id, command: 'ls', timeout_s: 5 });
    expect(result).toContain('Instance i-0abc is terminated');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// execute-prompt
// ---------------------------------------------------------------------------

describe('execute-prompt: ensureCloudReady wiring', () => {
  it('calls ensureCloudReady before running prompt', async () => {
    const member = makeCloudAgent();
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'hello' }), stderr: '', code: 0,
    });

    await executePrompt({ member_id: member.id, prompt: 'hello', timeout_s: 10 });

    expect(mockEnsureCloudReady).toHaveBeenCalledOnce();
    expect(mockEnsureCloudReady).toHaveBeenCalledWith(expect.objectContaining({ id: member.id }));
  });

  it('uses updated member from ensureCloudReady for command execution', async () => {
    const member = makeCloudAgent({ host: '10.0.0.1' });
    addAgent(member);
    const startedAgent = { ...member, host: '54.10.20.30' };
    mockEnsureCloudReady.mockResolvedValueOnce(startedAgent);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done' }), stderr: '', code: 0,
    });

    await executePrompt({ member_id: member.id, prompt: 'hello', timeout_s: 10 });

    // 3 calls: writePromptFile + main prompt command + deletePromptFile
    expect(mockExecCommand).toHaveBeenCalledTimes(3);
  });

  it('propagates ensureCloudReady error as failure message', async () => {
    const member = makeCloudAgent();
    addAgent(member);
    mockEnsureCloudReady.mockRejectedValueOnce(new Error('Instance terminated'));

    const result = await executePrompt({ member_id: member.id, prompt: 'hello', timeout_s: 10 });
    expect(result).toContain('Instance terminated');
  });
});

// ---------------------------------------------------------------------------
// send-files
// ---------------------------------------------------------------------------

describe('send-files: ensureCloudReady wiring', () => {
  it('calls ensureCloudReady before transferring files', async () => {
    const member = makeCloudAgent();
    addAgent(member);

    await sendFiles({ member_id: member.id, local_paths: ['/tmp/test.txt'] });

    expect(mockEnsureCloudReady).toHaveBeenCalledOnce();
    expect(mockEnsureCloudReady).toHaveBeenCalledWith(expect.objectContaining({ id: member.id }));
  });

  it('uses updated member from ensureCloudReady for file transfer', async () => {
    const member = makeCloudAgent({ host: '10.0.0.1' });
    addAgent(member);
    const startedAgent = { ...member, host: '54.10.20.30' };
    mockEnsureCloudReady.mockResolvedValueOnce(startedAgent);

    const result = await sendFiles({ member_id: member.id, local_paths: ['/tmp/test.txt'] });

    expect(mockTransferFiles).toHaveBeenCalledOnce();
    expect(result).toContain('Successfully uploaded');
  });

  it('propagates ensureCloudReady error as failure message', async () => {
    const member = makeCloudAgent();
    addAgent(member);
    mockEnsureCloudReady.mockRejectedValueOnce(new Error('Instance terminated'));

    const result = await sendFiles({ member_id: member.id, local_paths: ['/tmp/test.txt'] });
    expect(result).toContain('Instance terminated');
  });
});
