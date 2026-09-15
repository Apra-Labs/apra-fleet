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

// The CLI now honors a caller-supplied --session-id even in fork mode, so a
// realistic fork-dispatch mock echoes back the SAME id we asked it to use
// (extracted from the built command) rather than a fixed, independently
// chosen string -- mirrors production, where the returned id always equals
// the pre-minted one on success.
function echoSessionId(result = 'done') {
  return (cmd: string) => {
    const m = cmd.match(/--session-id "([^"]+)"/);
    return Promise.resolve(respond(m ? m[1] : 'NO-SESSION-ID-FOUND', result));
  };
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

  it('fork: "" and fork: "   " (whitespace only) are both a TERMINAL session_not_found -- no LLM call, no fresh-session fallback, and the SAME outcome for both spellings', async () => {
    // apra-fleet-3swo.42: forkArg trims '' and '   ' to the same '' before any
    // predicate is derived from it, so both must take the explicit-id branch
    // (an EXPLICIT id that happens to be invalid) rather than being silently
    // misrouted into the fork===true best-effort fresh-session path.
    const emptyMember = makeTestAgent({ friendlyName: 'gate-fork-empty-string', sessionId: 'stored-real-empty' });
    addAgent(emptyMember);
    const emptyResult = await executePrompt({
      member_id: emptyMember.id,
      prompt: 'hi',
      fork: '',
      resume: true,
      timeout_s: 5,
    } as any);

    const whitespaceMember = makeTestAgent({ friendlyName: 'gate-fork-whitespace-string', sessionId: 'stored-real-ws' });
    addAgent(whitespaceMember);
    const whitespaceResult = await executePrompt({
      member_id: whitespaceMember.id,
      prompt: 'hi',
      fork: '   ',
      resume: true,
      timeout_s: 5,
    } as any);

    // Positively assert no LLM call was made for EITHER case -- not inferred
    // from the absence of an error.
    expect(mockExecCommand).not.toHaveBeenCalled();
    expect(inFlightAgents.has(emptyMember.id)).toBe(false);
    expect(inFlightAgents.has(whitespaceMember.id)).toBe(false);

    expect(typeof emptyResult).not.toBe('string');
    expect(typeof whitespaceResult).not.toBe('string');
    if (typeof emptyResult !== 'string' && typeof whitespaceResult !== 'string') {
      expect(emptyResult.structuredContent).toMatchObject({ isError: true, reason: 'session_not_found', sessionId: '' });
      // The SAME outcome for both spellings, compared directly rather than
      // just independently matching the same shape.
      expect(whitespaceResult.structuredContent).toEqual(emptyResult.structuredContent);
    }
    // No fresh-session fallback happened either -- each member's stored
    // session is untouched.
    expect(getAgent(emptyMember.id)?.sessionId).toBe('stored-real-empty');
    expect(getAgent(whitespaceMember.id)?.sessionId).toBe('stored-real-ws');
  });

  it('a real session id padded with leading/trailing spaces still forks successfully -- trimmed for lookup, not rejected as invalid', async () => {
    const member = makeTestAgent({ friendlyName: 'gate-fork-padded-real-id' });
    addAgent(member);
    recordKnownSession(member.id, 'source-known-padded');
    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });   // writePromptFile
    mockExecCommand.mockImplementationOnce(echoSessionId());                     // main dispatch
    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });   // deletePromptFile

    const result = await executePrompt({
      member_id: member.id,
      prompt: 'hi',
      fork: '  source-known-padded  ',
      resume: true,
      timeout_s: 5,
    } as any);

    // The call actually reached the spawn layer -- the padded id resolved via
    // the same trim, not rejected as an unknown explicit id.
    expect(mockExecCommand).toHaveBeenCalled();
    expect(typeof result).not.toBe('string');
    if (typeof result !== 'string') {
      expect(result.structuredContent?.isError).toBeUndefined();
      expect(result.structuredContent?.reason).toBeUndefined();
      expect(result.structuredContent?.sessionId).not.toBe('source-known-padded');
    }
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
    mockExecCommand.mockImplementationOnce(echoSessionId());
    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    // Sanity: only the source is known before dispatch.
    expect(isKnownSession(member.id, 'source-known')).toBe(true);

    const result = await executePrompt({ member_id: member.id, prompt: 'hi', fork: 'source-known', resume: true, timeout_s: 5 });

    const cmd = mockExecCommand.mock.calls[1][0];
    const sidMatch = cmd.match(/--session-id "([^"]+)"/);
    expect(sidMatch).not.toBeNull();
    const mintedForkId = sidMatch![1];

    expect(typeof result).not.toBe('string');
    if (typeof result !== 'string') {
      expect(result.structuredContent?.sessionId).toBe(mintedForkId);
      expect(result.structuredContent?.sessionId).not.toBe('source-known');
    }
    // The forked id is now the member's active known/resumable session --
    // the source's own known-ness is untouched (fork never mutates it).
    expect(isKnownSession(member.id, mintedForkId)).toBe(true);
    expect(isKnownSession(member.id, 'source-known')).toBe(true);
    // The member's persisted sessionId (touchAgent) now points at the NEW
    // forked session, never the source.
    expect(getAgent(member.id)?.sessionId).toBe(mintedForkId);
  });
});
