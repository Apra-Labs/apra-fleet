/**
 * Unit tests for the fork mode-resolution gates added in the fork-core lane
 * (apra-fleet-lmtg.5), driven directly against executePrompt() with a
 * stubbed provider/strategy -- no real LLM call. Modeled on the existing
 * execute-prompt-resume-semantics.test.ts suite.
 *
 * apra-fleet-lmtg.6 acceptance criteria, one test each:
 *  - resume+fork both set -> validation error, NO LLM call.
 *  - Explicit fork of an unknown/expired source id -> terminal
 *    {isError:true, reason:'session_not_found'}, no LLM call, no
 *    fresh-session fallback.
 *  - fork=true with a stale/unknown stored session -> falls back to a fresh
 *    session (warning logged), call proceeds (no session_not_found).
 *  - A successful fork records a NEW session id distinct from the source,
 *    verified via the known-sessions ledger and the member's persisted
 *    sessionId (touchAgent recording path).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry, resultText } from './test-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import { executePrompt, inFlightAgents, provisionedRemoteAgents } from '../src/tools/execute-prompt.js';
import { recordKnownSession, isKnownSession, _resetKnownSessions } from '../src/services/known-sessions.js';
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

// Agent-file provisioning is a separate concern -- mock it away so it never
// consumes the mockExecCommand queue and shifts call-index assertions.
vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: vi.fn().mockReturnValue('.claude/agents/pm'),
}));

function respond(sessionId: string, result = 'done'): SSHExecResult {
  return { stdout: JSON.stringify({ result, session_id: sessionId }), stderr: '', code: 0 };
}

describe('execute_prompt fork mode-resolution gates (apra-fleet-lmtg.6)', () => {
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
    inFlightAgents.clear();
    _resetKnownSessions();
  });

  it('resume+fork both set (fork=true, non-default resume string) -> validation error, no LLM call', async () => {
    const member = makeTestAgent({ friendlyName: 'gate-resume-fork-string' });
    addAgent(member);

    const result = await executePrompt({
      member_id: member.id,
      prompt: 'hi',
      fork: true,
      resume: 'some-session',
      timeout_s: 5,
    } as any);

    expect(mockExecCommand).not.toHaveBeenCalled();
    expect(resultText(result)).toContain('fork');
    expect(resultText(result)).toContain('resume');
    expect(inFlightAgents.has(member.id)).toBe(false);
  });

  it('resume+fork both set (fork=<id>, resume=false) -> validation error, no LLM call', async () => {
    const member = makeTestAgent({ friendlyName: 'gate-resume-fork-false' });
    addAgent(member);

    const result = await executePrompt({
      member_id: member.id,
      prompt: 'hi',
      fork: 'source-id',
      resume: false,
      timeout_s: 5,
    } as any);

    expect(mockExecCommand).not.toHaveBeenCalled();
    expect(resultText(result)).toContain('fork');
    expect(resultText(result)).toContain('resume');
  });

  it('explicit fork of an unknown/expired source id is a TERMINAL session_not_found -- no LLM call, no fresh-session fallback', async () => {
    const member = makeTestAgent({ friendlyName: 'gate-fork-ghost-source', sessionId: 'stored-real' });
    addAgent(member);
    // 'ghost-source' is neither recorded known nor the member's stored session.

    const result = await executePrompt({
      member_id: member.id,
      prompt: 'hi',
      fork: 'ghost-source',
      resume: true,
      timeout_s: 5,
    });

    // Terminal, structured -- no spawn/exec call of any kind (not even writePromptFile).
    expect(mockExecCommand).not.toHaveBeenCalled();
    expect(inFlightAgents.has(member.id)).toBe(false);
    expect(typeof result).not.toBe('string');
    if (typeof result !== 'string') {
      expect(result.structuredContent).toMatchObject({
        isError: true,
        reason: 'session_not_found',
        sessionId: 'ghost-source',
      });
    }
    // No fresh-session fallback happened either -- the member's stored session
    // is untouched.
    expect(getAgent(member.id)?.sessionId).toBe('stored-real');
  });

  it('fork=true with a stale/unknown stored session falls back to a fresh session -- call proceeds, no session_not_found', async () => {
    const member = makeTestAgent({ friendlyName: 'gate-fork-stale-stored', sessionId: 'stale-stored' });
    addAgent(member);
    // Deliberately NOT recorded via recordKnownSession -- unknown/stale.
    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });    // writePromptFile
    mockExecCommand.mockResolvedValueOnce(respond('fresh-sess-after-stale'));      // main dispatch
    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });    // deletePromptFile

    const result = await executePrompt({ member_id: member.id, prompt: 'hi', fork: true, resume: true, timeout_s: 5 });

    // The call actually reached the spawn layer -- not rejected pre-dispatch.
    expect(mockExecCommand).toHaveBeenCalled();
    expect(resultText(result)).toContain('done');
    expect(typeof result).not.toBe('string');
    if (typeof result !== 'string') {
      expect(result.structuredContent?.isError).toBeUndefined();
      expect(result.structuredContent?.reason).toBeUndefined();
      expect(result.structuredContent?.sessionId).not.toBe('stale-stored');
    }
  });

  it('a successful fork records a NEW session id distinct from the source, and marks it known for the member', async () => {
    const member = makeTestAgent({ friendlyName: 'gate-fork-records-new-id' });
    addAgent(member);
    recordKnownSession(member.id, 'source-known');
    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });
    mockExecCommand.mockResolvedValueOnce(respond('newly-forked-id'));
    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    // Sanity: only the source is known before dispatch.
    expect(isKnownSession(member.id, 'source-known')).toBe(true);
    expect(isKnownSession(member.id, 'newly-forked-id')).toBe(false);

    const result = await executePrompt({ member_id: member.id, prompt: 'hi', fork: 'source-known', resume: true, timeout_s: 5 });

    expect(typeof result).not.toBe('string');
    if (typeof result !== 'string') {
      expect(result.structuredContent?.sessionId).toBe('newly-forked-id');
      expect(result.structuredContent?.sessionId).not.toBe('source-known');
    }
    // The forked id is now the member's active known/resumable session --
    // the source's own known-ness is untouched (fork never mutates it).
    expect(isKnownSession(member.id, 'newly-forked-id')).toBe(true);
    expect(isKnownSession(member.id, 'source-known')).toBe(true);
    // The member's persisted sessionId (touchAgent) now points at the NEW
    // forked session, never the source.
    expect(getAgent(member.id)?.sessionId).toBe('newly-forked-id');
  });
});
