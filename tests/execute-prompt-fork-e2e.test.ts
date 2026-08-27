/**
 * End-to-end integration coverage for execute_prompt's fork feature
 * (apra-fleet-lmtg.8), spanning schema -> fork mode resolution
 * (apra-fleet-lmtg.5) -> provider/OS command construction (apra-fleet-lmtg.2/3).
 *
 * Only the transport (strategy.execCommand) is stubbed -- the real Claude
 * provider adapter and the real OS command builders run unmocked, so the
 * assertions below are against the ACTUAL invoked command string, not a
 * fake/recorded one.
 *
 * Covers all three `fork` value modes plus the mutual-exclusivity guard:
 *  - fork="<sourceId>" (explicit): mints a NEW, distinct session id and the
 *    built command reflects the provider's fork invocation.
 *  - fork=true with a valid stored/known session: forks it the same way.
 *  - fork=true with a stale/unknown stored session: degrades to a plain
 *    fresh dispatch (no fork flags, no error).
 *  - fork + resume/session_id together: rejected end-to-end, no exec call.
 *
 * Also covers isolation: a subsequent turn dispatched after a fork lands on
 * the newly forked session id, never silently back on the source's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry, resultText } from './test-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
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

// Agent-file provisioning is a separate concern -- mock it away so it never
// consumes the mockExecCommand queue and shifts call-index assertions.
vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: vi.fn().mockReturnValue('.claude/agents/pm'),
}));

function respond(sessionId: string, result = 'done'): SSHExecResult {
  return { stdout: JSON.stringify({ result, session_id: sessionId }), stderr: '', code: 0 };
}

describe('execute_prompt fork end-to-end (apra-fleet-lmtg.8)', () => {
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

  it('fork="<sourceId>" mints a NEW session id distinct from the source, and the command reflects the provider fork invocation', async () => {
    const member = makeTestAgent({ friendlyName: 'fork-explicit' });
    addAgent(member);
    recordKnownSession(member.id, 'source-sess');
    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }); // writePromptFile
    mockExecCommand.mockResolvedValueOnce(respond('forked-new-id'));            // main dispatch
    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }); // deletePromptFile

    const result = await executePrompt({ member_id: member.id, prompt: 'branch me', fork: 'source-sess', resume: true, timeout_s: 5 });

    // calls[0] = writePromptFile, calls[1] = the actual fork dispatch command.
    const cmd = mockExecCommand.mock.calls[1][0];
    expect(cmd).toContain('--resume "source-sess"');
    expect(cmd).toContain('--fork-session');
    // The CLI mints the forked output id itself -- the caller never emits a
    // --session-id for it.
    expect(cmd).not.toMatch(/--session-id "forked-new-id"/);

    expect(resultText(result)).toContain('done');
    expect(typeof result).not.toBe('string');
    if (typeof result !== 'string') {
      expect(result.structuredContent?.sessionId).toBe('forked-new-id');
      expect(result.structuredContent?.sessionId).not.toBe('source-sess');
    }

    // The member's stored session is now the NEW forked id, not the source.
    const stored = getAgent(member.id);
    expect(stored?.sessionId).toBe('forked-new-id');
    expect(stored?.sessionId).not.toBe('source-sess');
  });

  it('isolation: a subsequent turn resumes the forked session, never silently the source session', async () => {
    const member = makeTestAgent({ friendlyName: 'fork-isolation' });
    addAgent(member);
    recordKnownSession(member.id, 'source-sess');
    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });
    mockExecCommand.mockResolvedValueOnce(respond('forked-new-id'));
    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    await executePrompt({ member_id: member.id, prompt: 'branch me', fork: 'source-sess', resume: true, timeout_s: 5 });
    mockExecCommand.mockClear();

    // Next turn: plain best-effort resume (the default) of this SAME member.
    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });
    mockExecCommand.mockResolvedValueOnce(respond('forked-new-id', 'continued'));
    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    const followUp = await executePrompt({ member_id: member.id, prompt: 'continue', resume: true, timeout_s: 5 });

    const followUpCmd = mockExecCommand.mock.calls[1][0];
    expect(followUpCmd).toContain('--resume "forked-new-id"');
    expect(followUpCmd).not.toContain('source-sess');
    expect(resultText(followUp)).toContain('continued');
  });

  it('fork=true with a valid stored/known session forks it the same way as an explicit fork', async () => {
    const member = makeTestAgent({ friendlyName: 'fork-best-effort-valid', sessionId: 'stored-sess' });
    addAgent(member);
    recordKnownSession(member.id, 'stored-sess');
    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });
    mockExecCommand.mockResolvedValueOnce(respond('forked-id-2'));
    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    const result = await executePrompt({ member_id: member.id, prompt: 'branch stored', fork: true, resume: true, timeout_s: 5 });

    const cmd = mockExecCommand.mock.calls[1][0];
    expect(cmd).toContain('--resume "stored-sess"');
    expect(cmd).toContain('--fork-session');
    if (typeof result !== 'string') {
      expect(result.structuredContent?.sessionId).toBe('forked-id-2');
      expect(result.structuredContent?.sessionId).not.toBe('stored-sess');
    }
  });

  it('fork=true with a stale/unknown stored session degrades to a plain fresh dispatch (no error, no fork flags)', async () => {
    const member = makeTestAgent({ friendlyName: 'fork-best-effort-stale', sessionId: 'stale-sess' });
    addAgent(member);
    // Deliberately NOT recorded via recordKnownSession -- unknown/stale.
    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });
    mockExecCommand.mockResolvedValueOnce(respond('fresh-sess-id'));
    mockExecCommand.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    const result = await executePrompt({ member_id: member.id, prompt: 'branch stale', fork: true, resume: true, timeout_s: 5 });

    const cmd = mockExecCommand.mock.calls[1][0];
    expect(cmd).not.toContain('--fork-session');
    expect(cmd).not.toContain('stale-sess');
    expect(cmd).toMatch(/--session-id "[0-9a-f-]+"/);
    expect(resultText(result)).toContain('done');
    if (typeof result !== 'string') {
      expect(result.structuredContent?.isError).toBeUndefined();
    }
  });

  it('resume + fork together is rejected end-to-end -- no exec call, no LLM dispatch', async () => {
    const member = makeTestAgent({ friendlyName: 'fork-resume-conflict' });
    addAgent(member);

    const result = await executePrompt({
      member_id: member.id,
      prompt: 'hello',
      fork: 'source-sess',
      resume: 'some-other-session',
      timeout_s: 5,
    } as any);

    expect(mockExecCommand).not.toHaveBeenCalled();
    expect(resultText(result)).toContain('fork');
    expect(resultText(result)).toContain('resume');
    expect(inFlightAgents.has(member.id)).toBe(false);
  });

  it('session_id + fork together is rejected end-to-end -- no exec call, no LLM dispatch', async () => {
    const member = makeTestAgent({ friendlyName: 'fork-session-id-conflict' });
    addAgent(member);

    const result = await executePrompt({
      member_id: member.id,
      prompt: 'hello',
      fork: true,
      session_id: 'explicit-session',
      timeout_s: 5,
    } as any);

    expect(mockExecCommand).not.toHaveBeenCalled();
    expect(resultText(result)).toContain('fork');
    expect(resultText(result)).toContain('session_id');
  });
});
