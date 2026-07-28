import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry, resultText } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt, inFlightAgents, provisionedRemoteAgents } from '../src/tools/execute-prompt.js';
import { recordKnownSession, _resetKnownSessions } from '../src/services/known-sessions.js';
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

// Agent-file provisioning is covered by its own suite -- mock it away here so it
// does not consume the mockExecCommand queue and shift call-index assertions.
vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: vi.fn().mockReturnValue('.claude/agents/pm'),
}));

// execute_prompt resume-by-session-id semantics (apra-fleet-eft.78.1).
// resume is boolean | string:
//  - true   -> best-effort resume of the member's stored last session; a
//              stale/unknown stored session transparently retries fresh.
//  - false  -> always a fresh session.
//  - string -> EXPLICIT resume of exactly that id (preferred over the stored
//              session); an unknown/expired id is a TERMINAL session_not_found
//              with NO LLM call and NO fresh-session fallback.
describe('execute_prompt resume-by-session-id semantics (apra-fleet-eft.78.1)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
    provisionedRemoteAgents.clear();
    _resetKnownSessions();
  });

  afterEach(() => {
    restoreRegistry();
    vi.useRealTimers();
    _resetKnownSessions();
  });

  it('a string id resumes THAT session even when the member stored last session differs', async () => {
    const member = makeTestAgent({ friendlyName: 'resume-explicit', sessionId: 'stored-different' });
    addAgent(member);
    // The server has previously issued this id for this member, so it is a known/
    // resumable session -- but it is NOT the member's stored last session.
    recordKnownSession(member.id, 'explicit-target');
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'resumed', session_id: 'explicit-target' }),
      stderr: '',
      code: 0,
    });

    const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: 'explicit-target', timeout_s: 5 });

    expect(resultText(result)).toContain('resumed');
    // calls[0] = writePromptFile, calls[1] = main prompt command
    const cmd = mockExecCommand.mock.calls[1][0];
    // The explicit caller id wins over the member's stored session.
    expect(cmd).toContain('--resume "explicit-target"');
    expect(cmd).not.toContain('stored-different');
    expect(cmd).not.toContain('--session-id');
  });

  it('a successful dispatch promotes sessionId into structuredContent while keeping the footer', async () => {
    const member = makeTestAgent({ friendlyName: 'resume-structured' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok body', session_id: 'sess-structured' }),
      stderr: '',
      code: 0,
    });

    const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });

    // Footer unchanged: the plaintext still carries the `session: <id>` line.
    expect(resultText(result)).toContain('session: sess-structured');
    // Promoted: structuredContent.sessionId is present for MCP clients.
    expect(typeof result).not.toBe('string');
    if (typeof result !== 'string') {
      expect(result.structuredContent).toMatchObject({ response: 'ok body', sessionId: 'sess-structured' });
    }
  });

  it('an explicit unknown/expired id is a TERMINAL session_not_found with the spawn layer never called', async () => {
    const member = makeTestAgent({ friendlyName: 'resume-ghost', sessionId: 'stored-real' });
    addAgent(member);
    // No recordKnownSession for 'ghost-id', and it is not the stored session.

    const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: 'ghost-id', timeout_s: 5 });

    // Structured terminal error, no LLM/spawn call at all.
    expect(mockExecCommand).not.toHaveBeenCalled();
    expect(inFlightAgents.has(member.id)).toBe(false);
    expect(typeof result).not.toBe('string');
    if (typeof result !== 'string') {
      expect(result.structuredContent).toMatchObject({ isError: true, reason: 'session_not_found', sessionId: 'ghost-id' });
    }
  });

  it('an explicit-id resume of the member stored session is honored (id == stored session is resumable)', async () => {
    const member = makeTestAgent({ friendlyName: 'resume-stored-id', sessionId: 'stored-real' });
    addAgent(member);
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok', session_id: 'stored-real' }),
      stderr: '',
      code: 0,
    });

    const result = await executePrompt({ member_id: member.id, prompt: 'hi', resume: 'stored-real', timeout_s: 5 });

    expect(resultText(result)).toContain('ok');
    const cmd = mockExecCommand.mock.calls[1][0];
    expect(cmd).toContain('--resume "stored-real"');
  });

  it('an explicit-id resume that fails does NOT transparently retry in a fresh session (terminal, no fallback)', async () => {
    const member = makeTestAgent({ friendlyName: 'resume-no-fallback', sessionId: 'stored-different' });
    addAgent(member);
    recordKnownSession(member.id, 'explicit-target');
    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })                      // writePromptFile
      .mockResolvedValueOnce({ stdout: '', stderr: 'session not found', code: 1 })     // main -> fails
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });                     // deletePromptFile

    const promise = executePrompt({ member_id: member.id, prompt: 'hi', resume: 'explicit-target', timeout_s: 5 });
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    // No stale-session retry-fresh: exactly writePromptFile + main + deletePromptFile.
    expect(mockExecCommand).toHaveBeenCalledTimes(3);
    expect(resultText(result)).toContain('failed');
  });

  it('resume=true with a stale stored session still does transparent retry-fresh', async () => {
    const member = makeTestAgent({ friendlyName: 'resume-true-stale', sessionId: 'old-sess' });
    addAgent(member);
    mockExecCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })                      // writePromptFile
      .mockResolvedValueOnce({ stdout: '', stderr: 'session not found', code: 1 })     // main -> stale
      .mockResolvedValueOnce({                                                          // retry fresh -> ok
        stdout: JSON.stringify({ result: 'recovered-fresh', session_id: 'sess-fresh' }),
        stderr: '',
        code: 0,
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });                     // deletePromptFile

    const promise = executePrompt({ member_id: member.id, prompt: 'hi', resume: true, timeout_s: 5 });
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(resultText(result)).toContain('recovered-fresh');
    // writePromptFile + main (stale) + stale-retry (fresh) + deletePromptFile
    expect(mockExecCommand).toHaveBeenCalledTimes(4);
    // The retry command starts a fresh minted session, not a --resume of the stale id.
    const retryCmd = mockExecCommand.mock.calls[2][0];
    expect(retryCmd).toMatch(/--session-id "[0-9a-f-]+"/);
    expect(retryCmd).not.toContain('--resume');
  });
});
