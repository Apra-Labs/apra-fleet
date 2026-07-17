import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry, resultText } from './test-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import { executePrompt, inFlightAgents } from '../src/tools/execute-prompt.js';
import { getStallDetector } from '../src/services/stall/index.js';
import { setStoredPid, clearStoredPid, getStoredPid } from '../src/utils/agent-helpers.js';
import { writeStatusline } from '../src/services/statusline.js';
import type { SSHExecResult } from '../src/types.js';

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

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
    const member = makeTestAgent({ friendlyName: 'secure-guard' });
    addAgent(member);

    const result = await executePrompt({ member_id: member.id, prompt: 'use {{secure.github_pat}} to auth', resume: false, timeout_s: 5 });
    expect(resultText(result)).toContain('{{secure.NAME}} token');
    expect(resultText(result)).toContain('execute_command');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('rejects prompt with {{secure.NAME}} token regardless of surrounding text', async () => {
    const member = makeTestAgent({ friendlyName: 'secure-guard-2' });
    addAgent(member);

    const result = await executePrompt({ member_id: member.id, prompt: 'auth with {{secure.my_token_123}} please', resume: false, timeout_s: 5 });
    expect(resultText(result)).toContain('{{secure.NAME}} token');
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('allows prompt without {{secure.NAME}} token', async () => {
    const member = makeTestAgent({ friendlyName: 'secure-allow' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok', session_id: 'sess-ok' }),
      stderr: '',
      code: 0,
    });

    const result = await executePrompt({ member_id: member.id, prompt: 'authenticate using credential github_pat', resume: false, timeout_s: 5 });
    expect(resultText(result)).toContain('ok');
    expect(mockExecCommand).toHaveBeenCalled();
  });

  it('parses JSON response and returns result + session_id', async () => {
    const member = makeTestAgent({ friendlyName: 'ok-member' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'Hello world', session_id: 'sess-123' }),
      stderr: '',
      code: 0,
    });

    const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    expect(resultText(result)).toContain('Hello world');
    expect(resultText(result)).toContain('sess-123');
    // 3 calls: writePromptFile + main command + deletePromptFile
    expect(mockExecCommand).toHaveBeenCalledTimes(3);
  });

  it('returns auth advice on auth error without retry', async () => {
    const member = makeTestAgent({ friendlyName: 'auth-fail' });
    addAgent(member);
    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })          // writePromptFile
      .mockResolvedValueOnce({ stdout: '', stderr: 'Not logged in', code: 1 }) // main
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });         // deletePromptFile

    const promise = executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(resultText(result)).toContain('/login');
    expect(resultText(result)).toContain('provision_llm_auth');
    // 3 calls: writePromptFile + main command + deletePromptFile
    expect(mockExecCommand).toHaveBeenCalledTimes(3);
  });

  it('retries on server error after 5s delay and returns recovered result', async () => {
    const member = makeTestAgent({ friendlyName: 'retry-ok' });
    addAgent(member);
    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // writePromptFile
      .mockResolvedValueOnce({ stdout: '', stderr: 'HTTP 500 Internal Server Error', code: 1 })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ result: 'recovered', session_id: 'sess-r' }),
        stderr: '',
        code: 0,
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });  // deletePromptFile

    const promise = executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(resultText(result)).toContain('recovered');
    // 4 calls: writePromptFile + main (500) + retry (recovered) + deletePromptFile
    expect(mockExecCommand).toHaveBeenCalledTimes(4);
  });

  it('returns error after server error retry also fails', async () => {
    const member = makeTestAgent({ friendlyName: 'retry-fail' });
    addAgent(member);
    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // writePromptFile
      .mockResolvedValueOnce({ stdout: '', stderr: 'HTTP 500 Internal Server Error', code: 1 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'HTTP 500 Internal Server Error', code: 1 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });  // deletePromptFile

    const promise = executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(resultText(result)).toContain('500');
    expect(resultText(result)).toContain('failed');
    // 4 calls: writePromptFile + main (500) + retry (500) + deletePromptFile
    expect(mockExecCommand).toHaveBeenCalledTimes(4);
  });

  it('compounds stale-session retry with server-error retry (3 calls)', async () => {
    const member = makeTestAgent({ friendlyName: 'compound', sessionId: 'old-sess' });
    addAgent(member);
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

    const promise = executePrompt({ member_id: member.id, prompt: 'hi', resume: true, timeout_s: 5 });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(resultText(result)).toContain('finally');
    // 5 calls: writePromptFile + main (stale) + stale-retry (500) + server-retry (ok) + deletePromptFile
    expect(mockExecCommand).toHaveBeenCalledTimes(5);
  });

  it('retries stale session without session ID', async () => {
    const member = makeTestAgent({ friendlyName: 'stale', sessionId: 'old-sess' });
    addAgent(member);
    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })           // writePromptFile
      .mockResolvedValueOnce({ stdout: '', stderr: 'session error', code: 1 })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ result: 'fresh', session_id: 'sess-new' }),
        stderr: '',
        code: 0,
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });          // deletePromptFile

    const promise = executePrompt({ member_id: member.id, prompt: 'hi', resume: true, timeout_s: 5 });
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(resultText(result)).toContain('fresh');
    // 4 calls: writePromptFile + main (stale) + stale-retry (fresh) + deletePromptFile
    expect(mockExecCommand).toHaveBeenCalledTimes(4);
  });

  it('passes model parameter to the generated command', async () => {
    const member = makeTestAgent({ friendlyName: 'model-member' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-m' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5, model: 'opus' });
    // calls[0] = writePromptFile, calls[1] = main prompt command
    expect(mockExecCommand.mock.calls[1][0]).toContain('--model');
    expect(mockExecCommand.mock.calls[1][0]).toContain('opus');
  });

  it('defaults to standard tier model when model param is omitted', async () => {
    const member = makeTestAgent({ friendlyName: 'default-model-member' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-d' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    // Default provider is Claude; standard tier is the bare alias "sonnet"
    // (auto-resolves to the current generation -- never a pinned dated ID)
    // calls[0] = writePromptFile, calls[1] = main prompt command
    expect(mockExecCommand.mock.calls[1][0]).toContain('--model');
    expect(mockExecCommand.mock.calls[1][0]).toContain('"sonnet"');
  });

  it('uses explicit model param unchanged when provided', async () => {
    const member = makeTestAgent({ friendlyName: 'explicit-model-member' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-e' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5, model: 'claude-opus-4-6' });
    // calls[0] = writePromptFile, calls[1] = main prompt command
    expect(mockExecCommand.mock.calls[1][0]).toContain('--model');
    expect(mockExecCommand.mock.calls[1][0]).toContain('claude-opus-4-6');
    expect(mockExecCommand.mock.calls[1][0]).not.toContain('"sonnet"');
  });

  it('resolves tier name "standard" to the "sonnet" alias', async () => {
    const member = makeTestAgent({ friendlyName: 'tier-standard-member' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-ts' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5, model: 'standard' });
    // calls[0] = writePromptFile, calls[1] = main prompt command
    expect(mockExecCommand.mock.calls[1][0]).toContain('--model');
    expect(mockExecCommand.mock.calls[1][0]).toContain('"sonnet"');
    expect(mockExecCommand.mock.calls[1][0]).not.toContain('"standard"');
  });

  it('resolves tier name "cheap" to the "haiku" alias', async () => {
    const member = makeTestAgent({ friendlyName: 'tier-cheap-member' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-tc' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5, model: 'cheap' });
    // calls[0] = writePromptFile, calls[1] = main prompt command
    expect(mockExecCommand.mock.calls[1][0]).toContain('--model');
    expect(mockExecCommand.mock.calls[1][0]).toContain('"haiku"');
    expect(mockExecCommand.mock.calls[1][0]).not.toContain('"cheap"');
  });

  it('resolves tier name "premium" to the "opus" alias', async () => {
    const member = makeTestAgent({ friendlyName: 'tier-premium-member' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-tp' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5, model: 'premium' });
    // calls[0] = writePromptFile, calls[1] = main prompt command
    expect(mockExecCommand.mock.calls[1][0]).toContain('--model');
    expect(mockExecCommand.mock.calls[1][0]).toContain('"opus"');
    expect(mockExecCommand.mock.calls[1][0]).not.toContain('"premium"');
  });

  it('appends token line when usage is present in response', async () => {
    const member = makeTestAgent({ friendlyName: 'token-member' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-t', usage: { input_tokens: 100, output_tokens: 200 } }),
      stderr: '',
      code: 0,
    });

    const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    expect(resultText(result)).toContain('Tokens: input=100 output=200');
  });

  it('does not append token line when usage is absent', async () => {
    const member = makeTestAgent({ friendlyName: 'no-token-member' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-nt' }),
      stderr: '',
      code: 0,
    });

    const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    expect(resultText(result)).not.toContain('Tokens:');
    expect(getAgent(member.id)?.tokenUsage).toBeUndefined();
  });

  it('accumulates tokenUsage on member when usage is present in response', async () => {
    const member = makeTestAgent({ friendlyName: 'accumulate-token-member' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-acc', usage: { input_tokens: 50, output_tokens: 75 } }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    expect(getAgent(member.id)?.tokenUsage).toEqual({ input: 50, output: 75 });
  });

  it('accumulates tokenUsage on top of existing values when member already has tokenUsage', async () => {
    const member = makeTestAgent({ friendlyName: 'accumulate-existing-member', tokenUsage: { input: 30, output: 20 } });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'done', session_id: 'sess-acc2', usage: { input_tokens: 10, output_tokens: 5 } }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    expect(getAgent(member.id)?.tokenUsage).toEqual({ input: 40, output: 25 });
  });

  it('returns raw error for unknown error without retry', async () => {
    const member = makeTestAgent({ friendlyName: 'unknown-err' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: '',
      stderr: 'something unexpected happened',
      code: 1,
    });

    const promise = executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(resultText(result)).toContain('something unexpected happened');
    expect(resultText(result)).toContain('failed');
    // 3 calls: writePromptFile + main command + deletePromptFile
    expect(mockExecCommand).toHaveBeenCalledTimes(3);
  });
});

describe('session-id collision fix', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    restoreRegistry();
    vi.useRealTimers();
  });

  it('fresh session command contains --session-id <uuid>, never -c', async () => {
    const member = makeTestAgent({ friendlyName: 'fresh-sid' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok', session_id: 'any' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });

    const cmd = mockExecCommand.mock.calls[1][0];
    expect(cmd).toMatch(/--session-id "[0-9a-f-]+"/);
    expect(cmd).not.toContain(' -c');
    expect(cmd).not.toContain('--resume');
  });

  it('resumed session command contains --resume <stored-id>, never -c', async () => {
    const member = makeTestAgent({ friendlyName: 'resume-sid', sessionId: 'stored-sess-42' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok', session_id: 'stored-sess-42' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: true, timeout_s: 5 });

    const cmd = mockExecCommand.mock.calls[1][0];
    expect(cmd).toContain('--resume "stored-sess-42"');
    expect(cmd).not.toContain(' -c');
    expect(cmd).not.toContain('--session-id');
  });

  it('resume=true with no stored ID mints fresh --session-id, not -c', async () => {
    const member = makeTestAgent({ friendlyName: 'resume-no-id' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok', session_id: 'any' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: true, timeout_s: 5 });

    const cmd = mockExecCommand.mock.calls[1][0];
    expect(cmd).toMatch(/--session-id "[0-9a-f-]+"/);
    expect(cmd).not.toContain(' -c');
    expect(cmd).not.toContain('--resume');
  });

  it('session-id mismatch: does not persist wrong id', async () => {
    const member = makeTestAgent({ friendlyName: 'mismatch-sid' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok', session_id: 'wrong-id-from-cli' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });

    const updated = getAgent(member.id);
    expect(updated?.sessionId).not.toBe('wrong-id-from-cli');
  });

  it('session-id match: persists the minted id', async () => {
    const member = makeTestAgent({ friendlyName: 'match-sid', sessionId: 'stored-id' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok', session_id: 'stored-id' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: true, timeout_s: 5 });

    const updated = getAgent(member.id);
    expect(updated?.sessionId).toBe('stored-id');
  });
});

describe('kill-before-retry (T5)', () => {
  let memberId: string;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    restoreRegistry();
    vi.useRealTimers();
    if (memberId) clearStoredPid(memberId);
  });

  it('issues kill command as first call when a PID is stored', async () => {
    const member = makeTestAgent({ friendlyName: 'kill-first' });
    memberId = member.id;
    addAgent(member);
    setStoredPid(memberId, 5555);

    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // tryKillPid → kill -9 5555
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // writePromptFile
      .mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'ok', session_id: 's1' }), stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });  // deletePromptFile

    const result = await executePrompt({ member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 });

    expect(resultText(result)).toContain('ok');
    // 4 calls: kill + writePromptFile + main + deletePromptFile
    expect(mockExecCommand).toHaveBeenCalledTimes(4);
    expect(mockExecCommand.mock.calls[0][0]).toContain('kill');
    expect(mockExecCommand.mock.calls[0][0]).toContain('5555');
  });

  it('clears stored PID on successful completion', async () => {
    const member = makeTestAgent({ friendlyName: 'clear-on-success' });
    memberId = member.id;
    addAgent(member);
    setStoredPid(memberId, 7777);

    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // tryKillPid
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // writePromptFile
      .mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'done', session_id: 's2' }), stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });  // deletePromptFile

    await executePrompt({ member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 });

    expect(getStoredPid(memberId)).toBeUndefined();
  });

  it('does not issue a kill command when no PID is stored', async () => {
    const member = makeTestAgent({ friendlyName: 'no-kill' });
    memberId = member.id;
    addAgent(member);
    // no PID stored

    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // writePromptFile
      .mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'ok', session_id: 's3' }), stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });  // deletePromptFile

    await executePrompt({ member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 });

    // 3 calls (no kill): writePromptFile + main + deletePromptFile
    expect(mockExecCommand).toHaveBeenCalledTimes(3);
  });

  it('kill command has short timeout (5000ms)', async () => {
    const member = makeTestAgent({ friendlyName: 'kill-timeout' });
    memberId = member.id;
    addAgent(member);
    setStoredPid(memberId, 4444);

    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // kill
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // writePromptFile
      .mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'ok', session_id: 's4' }), stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });  // deletePromptFile

    await executePrompt({ member_id: memberId, prompt: 'hi', resume: false, timeout_s: 300 });

    // Kill call must use 5000ms timeout, not the full 300000ms prompt timeout
    expect(mockExecCommand.mock.calls[0][1]).toBe(5000);
  });
});

describe('inv token prepend (T4)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    restoreRegistry();
    vi.useRealTimers();
  });

  it('prepends [inv] token to -p argument in fresh session', async () => {
    const member = makeTestAgent({ friendlyName: 'inv-fresh' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok', session_id: 'sess-inv-1' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });

    // calls[1] = main prompt command (calls[0] = writePromptFile)
    const cmd = mockExecCommand.mock.calls[1][0];
    expect(cmd).toContain('-p "[');
    expect(cmd).toContain('] Your task is described in');
    // Check inv token is a 5-character alphanumeric string
    const invMatch = cmd.match(/-p "\[([a-z0-9]{5})\]/);
    expect(invMatch).not.toBeNull();
  });

  it('prepends [inv] token to -p argument in resumed session', async () => {
    const member = makeTestAgent({ friendlyName: 'inv-resume', sessionId: 'old-sess' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok', session_id: 'sess-inv-2' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: member.id, prompt: 'hi', resume: true, timeout_s: 5 });

    // calls[1] = main prompt command (calls[0] = writePromptFile)
    const cmd = mockExecCommand.mock.calls[1][0];
    expect(cmd).toContain('-p "[');
    expect(cmd).toContain('] Your task is described in');
    // Check inv token is a 5-character alphanumeric string
    const invMatch = cmd.match(/-p "\[([a-z0-9]{5})\]/);
    expect(invMatch).not.toBeNull();
  });

  it('inv token is unique across calls', async () => {
    const member1 = makeTestAgent({ friendlyName: 'inv-unique-1' });
    const member2 = makeTestAgent({ friendlyName: 'inv-unique-2' });
    addAgent(member1);
    addAgent(member2);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok', session_id: 'sess-unique' }),
      stderr: '',
      code: 0,
    });

    await executePrompt({ member_id: member1.id, prompt: 'hi1', resume: false, timeout_s: 5 });
    await executePrompt({ member_id: member2.id, prompt: 'hi2', resume: false, timeout_s: 5 });

    // Extract inv tokens from both commands
    const cmd1 = mockExecCommand.mock.calls[1][0];
    const cmd2 = mockExecCommand.mock.calls[4][0]; // [0]=writePromptFile, [1]=main, [2]=deletePromptFile, [3]=writePromptFile, [4]=main

    const invMatch1 = cmd1.match(/-p "\[([a-z0-9]{5})\]/);
    const invMatch2 = cmd2.match(/-p "\[([a-z0-9]{5})\]/);

    expect(invMatch1).not.toBeNull();
    expect(invMatch2).not.toBeNull();
    // The tokens should be different (statistically very likely with 5 random alphanumeric chars)
    expect(invMatch1![1]).not.toBe(invMatch2![1]);
  });
});

describe('busy-state clear on all exit paths (T5)', () => {
  let memberId: string;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    restoreRegistry();
    vi.useRealTimers();
    if (memberId) inFlightAgents.delete(memberId);
  });

  it('clears inFlightAgents and calls writeStatusline after success (exit=0)', async () => {
    const member = makeTestAgent({ friendlyName: 'ep-exit0' });
    memberId = member.id;
    addAgent(member);
    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'ok', session_id: 's1' }), stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    await executePrompt({ member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 });

    expect(inFlightAgents.has(memberId)).toBe(false);
    expect(vi.mocked(writeStatusline).mock.calls.some(
      c => c[0] instanceof Map && c[0].get(memberId) === 'idle'
    )).toBe(true);
  });

  it('clears inFlightAgents and sets idle after failure (exit=1)', async () => {
    const member = makeTestAgent({ friendlyName: 'ep-exit1' });
    memberId = member.id;
    addAgent(member);
    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'unexpected error', code: 1 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    await executePrompt({ member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 });

    expect(inFlightAgents.has(memberId)).toBe(false);
    expect(vi.mocked(writeStatusline).mock.calls.some(
      c => c[0] instanceof Map && c[0].get(memberId) === 'idle'
    )).toBe(true);
  });

  it('clears inFlightAgents and sets offline after SSH connection failure survives the apra-fleet-02s.1 dispatch-exception retry', async () => {
    const member = makeTestAgent({ friendlyName: 'ep-exception' });
    memberId = member.id;
    addAgent(member);
    // apra-fleet-02s.1 gives the main execCommand call one bounded retry on a
    // thrown exception -- a persistent SSH failure must reject BOTH attempts
    // (not just the first) to still reach the outer catch's offline marking.
    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })
      .mockRejectedValueOnce(new Error('ssh connection lost'))
      .mockRejectedValueOnce(new Error('ssh connection lost'))
      .mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    await executePrompt({ member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 });

    expect(inFlightAgents.has(memberId)).toBe(false);
    expect(vi.mocked(writeStatusline).mock.calls.some(
      c => c[0] instanceof Map && c[0].get(memberId) === 'offline'
    )).toBe(true);
  });

  it('clears inFlightAgents and sets idle after AbortSignal fires', async () => {
    const controller = new AbortController();
    const member = makeTestAgent({ friendlyName: 'ep-abort' });
    memberId = member.id;
    addAgent(member);

    let resolveMain!: (v: SSHExecResult) => void;
    const mainPromise = new Promise<SSHExecResult>(res => { resolveMain = res; });

    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // writePromptFile
      .mockImplementationOnce(() => mainPromise)                    // main — hangs until killed
      .mockResolvedValue({ stdout: '', stderr: '', code: 0 });      // tryKillPid + deletePromptFile

    const promise = executePrompt(
      { member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 },
      { signal: controller.signal },
    );

    controller.abort();
    resolveMain({ stdout: '', stderr: 'killed', code: 1 });

    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(inFlightAgents.has(memberId)).toBe(false);
    expect(vi.mocked(writeStatusline).mock.calls.some(
      c => c[0] instanceof Map && c[0].get(memberId) === 'idle'
    )).toBe(true);
  });
});

describe('concurrency guard: rejects a second dispatch while one is in flight (apra-fleet-kwx)', () => {
  let memberId: string;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    restoreRegistry();
    vi.useRealTimers();
    if (memberId) inFlightAgents.delete(memberId);
  });

  it('rejects a second execute_prompt against a member with an already in-flight session, with a clear error, not a silent hang or double-run', async () => {
    const member = makeTestAgent({ friendlyName: 'ep-concurrent' });
    memberId = member.id;
    addAgent(member);

    // Simulate a first execute_prompt still running against this member.
    inFlightAgents.add(memberId);

    const result = await executePrompt({ member_id: memberId, prompt: 'second dispatch', resume: false, timeout_s: 5 });

    expect(resultText(result)).toContain('already running');
    expect(resultText(result)).toContain(member.friendlyName);
    expect(mockExecCommand).not.toHaveBeenCalled();
    // The guard must not have cleared the ORIGINAL in-flight session's state.
    expect(inFlightAgents.has(memberId)).toBe(true);
  });
});

describe('no-LLM members are rejected, never dispatched (apra-fleet-us9.14)', () => {
  let memberId: string;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    restoreRegistry();
    vi.useRealTimers();
    if (memberId) inFlightAgents.delete(memberId);
  });

  it('rejects execute_prompt for a member with llm_provider "none", with a clear error pointing to execute_command, without ever entering busy state', async () => {
    const member = makeTestAgent({ friendlyName: 'no-llm-member', llmProvider: 'none' });
    memberId = member.id;
    addAgent(member);

    const result = await executePrompt({ member_id: memberId, prompt: 'do something', resume: false, timeout_s: 5 });

    expect(resultText(result)).toContain('no-llm-member');
    expect(resultText(result)).toContain('execute_command');
    expect(mockExecCommand).not.toHaveBeenCalled();
    expect(inFlightAgents.has(memberId)).toBe(false);
  });
});

describe('MCP disconnect cleanup (T10)', () => {
  let memberId: string;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    restoreRegistry();
    vi.useRealTimers();
    if (memberId) {
      inFlightAgents.delete(memberId);
      getStallDetector().stallCheckList.delete(memberId);
    }
  });

  it('abort signal unblocks execCommand and triggers finally cleanup when subprocess never exits', async () => {
    const controller = new AbortController();
    const member = makeTestAgent({ friendlyName: 'abort-hang' });
    memberId = member.id;
    addAgent(member);

    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // writePromptFile
      .mockImplementationOnce((_cmd: string, _t?: number, _m?: number, _p?: (pid: number) => void, signal?: AbortSignal) => {
        return new Promise<SSHExecResult>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('Command aborted by client')), { once: true });
        });
      })
      .mockResolvedValue({ stdout: '', stderr: '', code: 0 });  // tryKillPid + deletePromptFile

    const promise = executePrompt(
      { member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 },
      { signal: controller.signal },
    );

    // Flush microtasks so executePrompt reaches the main execCommand and attaches the abort listener
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(resultText(result)).toContain('aborted');
    expect(inFlightAgents.has(memberId)).toBe(false);
    expect(getStallDetector().stallCheckList.has(memberId)).toBe(false);
    expect(vi.mocked(writeStatusline).mock.calls.some(
      c => c[0] instanceof Map && c[0].get(memberId) === 'idle'
    )).toBe(true);
  });

  it('finally runs and cleans up even when tryKillPid rejects', async () => {
    const controller = new AbortController();
    const member = makeTestAgent({ friendlyName: 'abort-kill-fail' });
    memberId = member.id;
    addAgent(member);
    setStoredPid(memberId, 9999);

    let callCount = 0;
    mockExecCommand.mockImplementation((_cmd: string, _t?: number, _m?: number, _p?: (pid: number) => void, signal?: AbortSignal) => {
      callCount++;
      if (callCount === 1) {
        // tryKillPid for stored PID 9999
        return Promise.resolve({ stdout: '', stderr: '', code: 0 });
      }
      if (callCount === 2) {
        // writePromptFile
        return Promise.resolve({ stdout: '', stderr: '', code: 0 });
      }
      if (callCount === 3) {
        // main execCommand — hangs until abort
        return new Promise<SSHExecResult>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('Command aborted by client')), { once: true });
        });
      }
      if (callCount === 4) {
        // tryKillPid from abortHandler — rejects (kill failed)
        return Promise.reject(new Error('kill failed: no such process'));
      }
      // deletePromptFile
      return Promise.resolve({ stdout: '', stderr: '', code: 0 });
    });

    const promise = executePrompt(
      { member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 },
      { signal: controller.signal },
    );

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(inFlightAgents.has(memberId)).toBe(false);
    expect(getStallDetector().stallCheckList.has(memberId)).toBe(false);
  });

  it('does not mark agent offline for abort errors', async () => {
    const controller = new AbortController();
    const member = makeTestAgent({ friendlyName: 'abort-not-offline' });
    memberId = member.id;
    addAgent(member);

    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // writePromptFile
      .mockImplementationOnce((_cmd: string, _t?: number, _m?: number, _p?: (pid: number) => void, signal?: AbortSignal) => {
        return new Promise<SSHExecResult>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('Command aborted by client')), { once: true });
        });
      })
      .mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    const promise = executePrompt(
      { member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 },
      { signal: controller.signal },
    );

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    const offlineCalls = vi.mocked(writeStatusline).mock.calls.filter(
      c => c[0] instanceof Map && c[0].get(memberId) === 'offline'
    );
    expect(offlineCalls).toHaveLength(0);
    expect(vi.mocked(writeStatusline).mock.calls.some(
      c => c[0] instanceof Map && c[0].get(memberId) === 'idle'
    )).toBe(true);
  });
});

describe('dispatch-exception retry (apra-fleet-02s.1)', () => {
  let memberId: string;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    restoreRegistry();
    vi.useRealTimers();
    if (memberId) clearStoredPid(memberId);
  });

  it('retries once with a fresh session after the main execCommand throws, and succeeds', async () => {
    const member = makeTestAgent({ friendlyName: 'dispatch-retry-ok' });
    memberId = member.id;
    addAgent(member);
    // no PID stored, so the pre-check tryKillPid at the top of executePrompt is a no-op.

    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // writePromptFile
      .mockRejectedValueOnce(new Error('inactivity timeout'))       // main execCommand throws
      // no kill call here: onPidCaptured never fired since the main call rejected
      // before invoking it, so tryKillPid inside the catch is also a no-op
      .mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'ok-on-retry', session_id: 's-retry' }), stderr: '', code: 0 }) // retry execCommand succeeds
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });  // deletePromptFile

    const result = await executePrompt({ member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 });

    expect(resultText(result)).toContain('ok-on-retry');
    expect(result.structuredContent).not.toMatchObject({ isError: true });
    expect(mockExecCommand).toHaveBeenCalledTimes(4);
  });

  it('uses a fresh, non-resumed session on the retry command', async () => {
    const member = makeTestAgent({ friendlyName: 'dispatch-retry-fresh-session', sessionId: 'old-sess' });
    memberId = member.id;
    addAgent(member);

    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // writePromptFile
      .mockRejectedValueOnce(new Error('inactivity timeout'))       // main execCommand throws
      .mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'ok-on-retry', session_id: 's-retry' }), stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });  // deletePromptFile

    await executePrompt({ member_id: memberId, prompt: 'hi', resume: true, timeout_s: 5 });

    // calls[2] is the retry command -- it must not carry the `--resume old-sess`
    // flag a resumed dispatch would otherwise use, since the retry starts a
    // deliberately fresh session rather than continuing the failed one.
    const retryCmd = mockExecCommand.mock.calls[2][0];
    expect(retryCmd).not.toContain('old-sess');
  });

  it('still returns a dispatch_failed structured error if the retry also throws', async () => {
    const member = makeTestAgent({ friendlyName: 'dispatch-retry-fails-too' });
    memberId = member.id;
    addAgent(member);

    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // writePromptFile
      .mockRejectedValueOnce(new Error('inactivity timeout'))       // main execCommand throws
      .mockRejectedValueOnce(new Error('inactivity timeout again')); // retry execCommand also throws

    const result = await executePrompt({ member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 });

    expect(result.structuredContent).toMatchObject({ isError: true, reason: 'dispatch_failed' });
    expect(resultText(result)).toContain('inactivity timeout again');
  });

  it('does not retry when the client already cancelled the request (signal aborted)', async () => {
    const controller = new AbortController();
    controller.abort();
    const member = makeTestAgent({ friendlyName: 'dispatch-retry-skip-on-abort' });
    memberId = member.id;
    addAgent(member);

    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })  // writePromptFile
      .mockRejectedValueOnce(new Error('Command aborted by client')) // main execCommand throws
      .mockResolvedValue({ stdout: '', stderr: '', code: 0 });  // deletePromptFile (finally block)

    const result = await executePrompt(
      { member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 },
      { signal: controller.signal },
    );

    expect(result.structuredContent).toMatchObject({ isError: true, reason: 'dispatch_failed' });
    // 3 calls: writePromptFile + the one failed main call (no retry attempt) +
    // deletePromptFile in the finally block.
    expect(mockExecCommand).toHaveBeenCalledTimes(3);
  });
});

