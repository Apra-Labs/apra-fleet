import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt } from '../src/tools/execute-prompt.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

describe('executePrompt', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    restoreRegistry();
    vi.useRealTimers();
  });

  it('parses JSON response and returns result + session_id', async () => {
    const agent = makeTestAgent({ friendlyName: 'ok-agent' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'Hello world', session_id: 'sess-123' }),
      stderr: '',
      code: 0,
    });

    const result = await executePrompt({ member_id: agent.id, prompt: 'hi', resume: false, timeout_ms: 5000 });
    expect(result).toContain('Hello world');
    expect(result).toContain('sess-123');
    expect(mockExecCommand).toHaveBeenCalledTimes(1);
  });

  it('returns auth advice on auth error without retry', async () => {
    const agent = makeTestAgent({ friendlyName: 'auth-fail' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({
      stdout: '',
      stderr: 'Not logged in',
      code: 1,
    });

    const promise = executePrompt({ member_id: agent.id, prompt: 'hi', resume: false, timeout_ms: 5000 });
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(result).toContain('/login');
    expect(result).toContain('provision_auth');
    expect(mockExecCommand).toHaveBeenCalledTimes(1);
  });

  it('retries on server error after 5s delay and returns recovered result', async () => {
    const agent = makeTestAgent({ friendlyName: 'retry-ok' });
    addAgent(agent);
    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: 'HTTP 500 Internal Server Error', code: 1 })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ result: 'recovered', session_id: 'sess-r' }),
        stderr: '',
        code: 0,
      });

    const promise = executePrompt({ member_id: agent.id, prompt: 'hi', resume: false, timeout_ms: 5000 });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result).toContain('recovered');
    expect(mockExecCommand).toHaveBeenCalledTimes(2);
  });

  it('returns error after server error retry also fails', async () => {
    const agent = makeTestAgent({ friendlyName: 'retry-fail' });
    addAgent(agent);
    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: 'HTTP 500 Internal Server Error', code: 1 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'HTTP 500 Internal Server Error', code: 1 });

    const promise = executePrompt({ member_id: agent.id, prompt: 'hi', resume: false, timeout_ms: 5000 });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result).toContain('500');
    expect(result).toContain('failed');
    expect(mockExecCommand).toHaveBeenCalledTimes(2);
  });

  it('compounds stale-session retry with server-error retry (3 calls)', async () => {
    const agent = makeTestAgent({ friendlyName: 'compound', sessionId: 'old-sess' });
    addAgent(agent);
    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: 'session not found', code: 1 })   // stale session
      .mockResolvedValueOnce({ stdout: '', stderr: 'HTTP 500 error', code: 1 })       // retry → 500
      .mockResolvedValueOnce({                                                          // server retry → ok
        stdout: JSON.stringify({ result: 'finally', session_id: 'sess-new' }),
        stderr: '',
        code: 0,
      });

    const promise = executePrompt({ member_id: agent.id, prompt: 'hi', resume: true, timeout_ms: 5000 });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result).toContain('finally');
    expect(mockExecCommand).toHaveBeenCalledTimes(3);
  });

  it('retries stale session without session ID', async () => {
    const agent = makeTestAgent({ friendlyName: 'stale', sessionId: 'old-sess' });
    addAgent(agent);
    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: 'session error', code: 1 })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ result: 'fresh', session_id: 'sess-new' }),
        stderr: '',
        code: 0,
      });

    const promise = executePrompt({ member_id: agent.id, prompt: 'hi', resume: true, timeout_ms: 5000 });
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(result).toContain('fresh');
    expect(mockExecCommand).toHaveBeenCalledTimes(2);
  });

  it('passes model parameter to the generated command', async () => {
    const agent = makeTestAgent({ friendlyName: 'model-agent' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-m' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: agent.id, prompt: 'hi', resume: false, timeout_ms: 5000, model: 'opus' });
    expect(mockExecCommand.mock.calls[0][0]).toContain('--model');
    expect(mockExecCommand.mock.calls[0][0]).toContain('opus');
  });

  it('defaults to standard tier model when model param is omitted', async () => {
    const agent = makeTestAgent({ friendlyName: 'default-model-agent' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-d' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: agent.id, prompt: 'hi', resume: false, timeout_ms: 5000 });
    // Default provider is Claude; standard tier is claude-sonnet-4-6
    expect(mockExecCommand.mock.calls[0][0]).toContain('--model');
    expect(mockExecCommand.mock.calls[0][0]).toContain('claude-sonnet-4-6');
  });

  it('uses explicit model param unchanged when provided', async () => {
    const agent = makeTestAgent({ friendlyName: 'explicit-model-agent' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-e' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: agent.id, prompt: 'hi', resume: false, timeout_ms: 5000, model: 'claude-opus-4-6' });
    expect(mockExecCommand.mock.calls[0][0]).toContain('--model');
    expect(mockExecCommand.mock.calls[0][0]).toContain('claude-opus-4-6');
    expect(mockExecCommand.mock.calls[0][0]).not.toContain('claude-sonnet-4-6');
  });

  it('appends token line when usage is present in response', async () => {
    const agent = makeTestAgent({ friendlyName: 'token-agent' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-t', usage: { input_tokens: 100, output_tokens: 200 } }),
      stderr: '',
      code: 0,
    });

    const result = await executePrompt({ member_id: agent.id, prompt: 'hi', resume: false, timeout_ms: 5000 });
    expect(result).toContain('Tokens: input=100 output=200');
  });

  it('does not append token line when usage is absent', async () => {
    const agent = makeTestAgent({ friendlyName: 'no-token-agent' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-nt' }),
      stderr: '',
      code: 0,
    });

    const result = await executePrompt({ member_id: agent.id, prompt: 'hi', resume: false, timeout_ms: 5000 });
    expect(result).not.toContain('Tokens:');
  });

  it('returns raw error for unknown error without retry', async () => {
    const agent = makeTestAgent({ friendlyName: 'unknown-err' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({
      stdout: '',
      stderr: 'something unexpected happened',
      code: 1,
    });

    const promise = executePrompt({ member_id: agent.id, prompt: 'hi', resume: false, timeout_ms: 5000 });
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(result).toContain('something unexpected happened');
    expect(result).toContain('failed');
    expect(mockExecCommand).toHaveBeenCalledTimes(1);
  });
});
