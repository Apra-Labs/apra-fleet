import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import { executePrompt } from '../src/tools/execute-prompt.js';
import { setStoredPid, clearStoredPid, getStoredPid } from '../src/utils/agent-helpers.js';
import type { SSHExecResult } from '../src/types.js';

const mockExecCommand = vi.fn<(cmd: string, timeout?: number, maxTotalMs?: number) => Promise<SSHExecResult>>();

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

  it('rejects prompt containing {{secure.NAME}} token without executing', async () => {
    const agent = makeTestAgent({ friendlyName: 'secure-guard' });
    addAgent(agent);

    const result = await executePrompt({ member_id: agent.id, prompt: 'use {{secure.github_pat}} to auth', resume: false, timeout_ms: 5000 });
    expect(result).toContain('{{secure.NAME}} token');
    expect(result).toContain('execute_command');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('rejects prompt with {{secure.NAME}} token regardless of surrounding text', async () => {
    const agent = makeTestAgent({ friendlyName: 'secure-guard-2' });
    addAgent(agent);

    const result = await executePrompt({ member_id: agent.id, prompt: 'auth with {{secure.my_token_123}} please', resume: false, timeout_ms: 5000 });
    expect(result).toContain('{{secure.NAME}} token');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('allows prompt without {{secure.NAME}} token', async () => {
    const agent = makeTestAgent({ friendlyName: 'secure-allow' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok', session_id: 'sess-ok' }),
      stderr: '',
      code: 0,
    });

    const result = await executePrompt({ member_id: agent.id, prompt: 'authenticate using credential github_pat', resume: false, timeout_ms: 5000 });
    expect(result).toContain('ok');
    expect(mockExecCommand).toHaveBeenCalled();
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
    // 3 calls: writePromptFile + main command + deletePromptFile
    expect(mockExecCommand).toHaveBeenCalledTimes(3);
  });

  it('returns auth advice on auth error without retry', async () => {
    const agent = makeTestAgent({ friendlyName: 'auth-fail' });
    addAgent(agent);
    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })          // writePromptFile
      .mockResolvedValueOnce({ stdout: '', stderr: 'Not logged in', code: 1 }) // main
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });         // deletePromptFile

    const promise = executePrompt({ member_id: agent.id, prompt: 'hi', resume: false, timeout_ms: 5000 });
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(result).toContain('/login');
    expect(result).toContain('provision_llm_auth');
    // 3 calls: writePromptFile + main command + deletePromptFile
    expect(mockExecCommand).toHaveBeenCalledTimes(3);
  });

  it('retries on server error after 5s delay and returns recovered result', async () => {
    const agent = makeTestAgent({ friendlyName: 'retry-ok' });
    addAgent(agent);
    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // writePromptFile
      .mockResolvedValueOnce({ stdout: '', stderr: 'HTTP 500 Internal Server Error', code: 1 })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ result: 'recovered', session_id: 'sess-r' }),
        stderr: '',
        code: 0,
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });  // deletePromptFile

    const promise = executePrompt({ member_id: agent.id, prompt: 'hi', resume: false, timeout_ms: 5000 });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result).toContain('recovered');
    // 4 calls: writePromptFile + main (500) + retry (recovered) + deletePromptFile
    expect(mockExecCommand).toHaveBeenCalledTimes(4);
  });

  it('returns error after server error retry also fails', async () => {
    const agent = makeTestAgent({ friendlyName: 'retry-fail' });
    addAgent(agent);
    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // writePromptFile
      .mockResolvedValueOnce({ stdout: '', stderr: 'HTTP 500 Internal Server Error', code: 1 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'HTTP 500 Internal Server Error', code: 1 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });  // deletePromptFile

    const promise = executePrompt({ member_id: agent.id, prompt: 'hi', resume: false, timeout_ms: 5000 });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result).toContain('500');
    expect(result).toContain('failed');
    // 4 calls: writePromptFile + main (500) + retry (500) + deletePromptFile
    expect(mockExecCommand).toHaveBeenCalledTimes(4);
  });

  it('compounds stale-session retry with server-error retry (3 calls)', async () => {
    const agent = makeTestAgent({ friendlyName: 'compound', sessionId: 'old-sess' });
    addAgent(agent);
    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })                    // writePromptFile
      .mockResolvedValueOnce({ stdout: '', stderr: 'session not found', code: 1 })   // stale session
      .mockResolvedValueOnce({ stdout: '', stderr: 'HTTP 500 error', code: 1 })       // stale retry → 500
      .mockResolvedValueOnce({                                                          // server retry → ok
        stdout: JSON.stringify({ result: 'finally', session_id: 'sess-new' }),
        stderr: '',
        code: 0,
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });                   // deletePromptFile

    const promise = executePrompt({ member_id: agent.id, prompt: 'hi', resume: true, timeout_ms: 5000 });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result).toContain('finally');
    // 5 calls: writePromptFile + main (stale) + stale-retry (500) + server-retry (ok) + deletePromptFile
    expect(mockExecCommand).toHaveBeenCalledTimes(5);
  });

  it('retries stale session without session ID', async () => {
    const agent = makeTestAgent({ friendlyName: 'stale', sessionId: 'old-sess' });
    addAgent(agent);
    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })           // writePromptFile
      .mockResolvedValueOnce({ stdout: '', stderr: 'session error', code: 1 })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ result: 'fresh', session_id: 'sess-new' }),
        stderr: '',
        code: 0,
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });          // deletePromptFile

    const promise = executePrompt({ member_id: agent.id, prompt: 'hi', resume: true, timeout_ms: 5000 });
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(result).toContain('fresh');
    // 4 calls: writePromptFile + main (stale) + stale-retry (fresh) + deletePromptFile
    expect(mockExecCommand).toHaveBeenCalledTimes(4);
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
    // calls[0] = writePromptFile, calls[1] = main prompt command
    expect(mockExecCommand.mock.calls[1][0]).toContain('--model');
    expect(mockExecCommand.mock.calls[1][0]).toContain('opus');
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
    // calls[0] = writePromptFile, calls[1] = main prompt command
    expect(mockExecCommand.mock.calls[1][0]).toContain('--model');
    expect(mockExecCommand.mock.calls[1][0]).toContain('claude-sonnet-4-6');
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
    // calls[0] = writePromptFile, calls[1] = main prompt command
    expect(mockExecCommand.mock.calls[1][0]).toContain('--model');
    expect(mockExecCommand.mock.calls[1][0]).toContain('claude-opus-4-6');
    expect(mockExecCommand.mock.calls[1][0]).not.toContain('claude-sonnet-4-6');
  });

  it('resolves tier name "standard" to claude-sonnet-4-6', async () => {
    const agent = makeTestAgent({ friendlyName: 'tier-standard-agent' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-ts' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: agent.id, prompt: 'hi', resume: false, timeout_ms: 5000, model: 'standard' });
    // calls[0] = writePromptFile, calls[1] = main prompt command
    expect(mockExecCommand.mock.calls[1][0]).toContain('--model');
    expect(mockExecCommand.mock.calls[1][0]).toContain('claude-sonnet-4-6');
    expect(mockExecCommand.mock.calls[1][0]).not.toContain('standard');
  });

  it('resolves tier name "cheap" to claude-haiku-4-5', async () => {
    const agent = makeTestAgent({ friendlyName: 'tier-cheap-agent' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-tc' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: agent.id, prompt: 'hi', resume: false, timeout_ms: 5000, model: 'cheap' });
    // calls[0] = writePromptFile, calls[1] = main prompt command
    expect(mockExecCommand.mock.calls[1][0]).toContain('--model');
    expect(mockExecCommand.mock.calls[1][0]).toContain('claude-haiku-4-5');
    expect(mockExecCommand.mock.calls[1][0]).not.toContain('cheap');
  });

  it('resolves tier name "premium" to claude-opus-4-6', async () => {
    const agent = makeTestAgent({ friendlyName: 'tier-premium-agent' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-tp' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: agent.id, prompt: 'hi', resume: false, timeout_ms: 5000, model: 'premium' });
    // calls[0] = writePromptFile, calls[1] = main prompt command
    expect(mockExecCommand.mock.calls[1][0]).toContain('--model');
    expect(mockExecCommand.mock.calls[1][0]).toContain('claude-opus-4-6');
    expect(mockExecCommand.mock.calls[1][0]).not.toContain('premium');
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
    expect(getAgent(agent.id)?.tokenUsage).toBeUndefined();
  });

  it('accumulates tokenUsage on agent when usage is present in response', async () => {
    const agent = makeTestAgent({ friendlyName: 'accumulate-token-agent' });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-acc', usage: { input_tokens: 50, output_tokens: 75 } }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: agent.id, prompt: 'hi', resume: false, timeout_ms: 5000 });
    expect(getAgent(agent.id)?.tokenUsage).toEqual({ input: 50, output: 75 });
  });

  it('accumulates tokenUsage on top of existing values when agent already has tokenUsage', async () => {
    const agent = makeTestAgent({ friendlyName: 'accumulate-existing-agent', tokenUsage: { input: 30, output: 20 } });
    addAgent(agent);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-acc2', usage: { input_tokens: 10, output_tokens: 5 } }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: agent.id, prompt: 'hi', resume: false, timeout_ms: 5000 });
    expect(getAgent(agent.id)?.tokenUsage).toEqual({ input: 40, output: 25 });
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
    // 3 calls: writePromptFile + main command + deletePromptFile
    expect(mockExecCommand).toHaveBeenCalledTimes(3);
  });
});

describe('kill-before-retry (T5)', () => {
  let agentId: string;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    restoreRegistry();
    vi.useRealTimers();
    if (agentId) clearStoredPid(agentId);
  });

  it('issues kill command as first call when a PID is stored', async () => {
    const agent = makeTestAgent({ friendlyName: 'kill-first' });
    agentId = agent.id;
    addAgent(agent);
    setStoredPid(agentId, 5555);

    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // tryKillPid → kill -9 5555
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // writePromptFile
      .mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'ok', session_id: 's1' }), stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });  // deletePromptFile

    const result = await executePrompt({ member_id: agentId, prompt: 'hi', resume: false, timeout_ms: 5000 });

    expect(result).toContain('ok');
    // 4 calls: kill + writePromptFile + main + deletePromptFile
    expect(mockExecCommand).toHaveBeenCalledTimes(4);
    expect(mockExecCommand.mock.calls[0][0]).toContain('kill');
    expect(mockExecCommand.mock.calls[0][0]).toContain('5555');
  });

  it('clears stored PID on successful completion', async () => {
    const agent = makeTestAgent({ friendlyName: 'clear-on-success' });
    agentId = agent.id;
    addAgent(agent);
    setStoredPid(agentId, 7777);

    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // tryKillPid
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // writePromptFile
      .mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'done', session_id: 's2' }), stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });  // deletePromptFile

    await executePrompt({ member_id: agentId, prompt: 'hi', resume: false, timeout_ms: 5000 });

    expect(getStoredPid(agentId)).toBeUndefined();
  });

  it('does not issue a kill command when no PID is stored', async () => {
    const agent = makeTestAgent({ friendlyName: 'no-kill' });
    agentId = agent.id;
    addAgent(agent);
    // no PID stored

    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // writePromptFile
      .mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'ok', session_id: 's3' }), stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });  // deletePromptFile

    await executePrompt({ member_id: agentId, prompt: 'hi', resume: false, timeout_ms: 5000 });

    // 3 calls (no kill): writePromptFile + main + deletePromptFile
    expect(mockExecCommand).toHaveBeenCalledTimes(3);
  });

  it('kill command has short timeout (5000ms)', async () => {
    const agent = makeTestAgent({ friendlyName: 'kill-timeout' });
    agentId = agent.id;
    addAgent(agent);
    setStoredPid(agentId, 4444);

    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // kill
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // writePromptFile
      .mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'ok', session_id: 's4' }), stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });  // deletePromptFile

    await executePrompt({ member_id: agentId, prompt: 'hi', resume: false, timeout_ms: 300000 });

    // Kill call must use 5000ms timeout, not the full 300000ms prompt timeout
    expect(mockExecCommand.mock.calls[0][1]).toBe(5000);
  });
});
