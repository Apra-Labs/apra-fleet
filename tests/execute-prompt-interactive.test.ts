import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry, resultText } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt, inFlightAgents } from '../src/tools/execute-prompt.js';
import { respondToMessage } from '../src/tools/respond-to-message.js';
import { sessionRegistry } from '../src/services/session-registry.js';
import { getTokenIssuer } from '../src/services/token-issuer.js';
import { writeStatusline } from '../src/services/statusline.js';

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

// execute_prompt's interactive routing (apra-fleet-2xs.8) never touches
// strategy/execCommand at all for an interactively-connected member --
// asserted via mockExecCommand.mock.calls.length in the tests below rather
// than a throwing mock (a rejected-but-uncaught promise from deep inside
// the retry logic is a real risk with mockRejectedValue and would report
// as an unhandled rejection regardless of whether execute_prompt's own
// try/catch eventually runs).
const mockExecCommand = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ result: 'ok', session_id: 'sess-x' }), stderr: '', code: 0 });

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

describe('executePrompt -- interactive routing (apra-fleet-2xs.8)', () => {
  let memberId: string;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
    if (memberId) {
      inFlightAgents.delete(memberId);
      sessionRegistry.unregister(getTokenIssuer().workspaceId(), memberId);
    }
  });

  it('routes via send_message + wait-for-response when the member has a live interactive session, never spawning a subprocess', async () => {
    const member = makeTestAgent({ friendlyName: 'interactive-member' });
    memberId = member.id;
    addAgent(member);

    const notification = vi.fn().mockResolvedValue(undefined);
    const workspaceId = getTokenIssuer().workspaceId();
    sessionRegistry.register({
      member_id: memberId,
      workspace_id: workspaceId,
      role: 'doer',
      work_folder: member.workFolder,
      server: { server: { notification } } as any,
      status: 'online',
    });

    const promptPromise = executePrompt({ member_id: memberId, prompt: 'do the thing', resume: false, timeout_s: 5 });

    // Let the send_message push land, then the member "responds" via
    // respond_to_message with the msgid it received in the notification.
    await vi.waitFor(() => expect(notification).toHaveBeenCalledTimes(1));
    const msgid = notification.mock.calls[0][0].params.meta.msgid;
    expect(typeof msgid).toBe('string');

    const respondResult = await respondToMessage({ reply_to: msgid, content: 'all done, here is the summary' });
    expect(JSON.parse(respondResult)).toEqual({ ok: true });

    const result = await promptPromise;
    expect(resultText(result)).toContain('interactive-member');
    expect(resultText(result)).toContain('all done, here is the summary');
    expect(inFlightAgents.has(memberId)).toBe(false);
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('the busy status set by the interactive push is cleared once respond_to_message resolves it', async () => {
    const member = makeTestAgent({ friendlyName: 'interactive-status-member' });
    memberId = member.id;
    addAgent(member);

    const notification = vi.fn().mockResolvedValue(undefined);
    const workspaceId = getTokenIssuer().workspaceId();
    sessionRegistry.register({
      member_id: memberId,
      workspace_id: workspaceId,
      role: 'doer',
      work_folder: member.workFolder,
      server: { server: { notification } } as any,
      status: 'online',
    });

    const promptPromise = executePrompt({ member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 });
    await vi.waitFor(() => expect(inFlightAgents.has(memberId)).toBe(true));

    const msgid = notification.mock.calls[0][0].params.meta.msgid;
    await respondToMessage({ reply_to: msgid, content: 'done' });
    await promptPromise;

    expect(inFlightAgents.has(memberId)).toBe(false);
  });

  it('rejects a SECOND execute_prompt call while the interactive call is still awaiting a response (same concurrency guard as subprocess mode)', async () => {
    const member = makeTestAgent({ friendlyName: 'interactive-concurrent' });
    memberId = member.id;
    addAgent(member);

    const notification = vi.fn().mockResolvedValue(undefined);
    const workspaceId = getTokenIssuer().workspaceId();
    sessionRegistry.register({
      member_id: memberId,
      workspace_id: workspaceId,
      role: 'doer',
      work_folder: member.workFolder,
      server: { server: { notification } } as any,
      status: 'online',
    });

    const firstPromise = executePrompt({ member_id: memberId, prompt: 'first', resume: false, timeout_s: 5 });
    await vi.waitFor(() => expect(inFlightAgents.has(memberId)).toBe(true));

    const secondResult = await executePrompt({ member_id: memberId, prompt: 'second', resume: false, timeout_s: 5 });
    expect(resultText(secondResult)).toContain('already running');

    const msgid = notification.mock.calls[0][0].params.meta.msgid;
    await respondToMessage({ reply_to: msgid, content: 'first response' });
    await firstPromise;
  });

  it('times out and returns a clear error if the member never responds', async () => {
    const member = makeTestAgent({ friendlyName: 'interactive-timeout' });
    memberId = member.id;
    addAgent(member);

    const notification = vi.fn().mockResolvedValue(undefined);
    const workspaceId = getTokenIssuer().workspaceId();
    sessionRegistry.register({
      member_id: memberId,
      workspace_id: workspaceId,
      role: 'doer',
      work_folder: member.workFolder,
      server: { server: { notification } } as any,
      status: 'online',
    });

    const result = await executePrompt({ member_id: memberId, prompt: 'nobody answers', resume: false, timeout_s: 0.2 });

    expect(resultText(result)).toContain('Timed out');
    expect(resultText(result)).toContain('interactive-timeout');
    expect(inFlightAgents.has(memberId)).toBe(false);
  }, 10000);

  it('falls through to the subprocess path (unaffected) for a member with NO live interactive session', async () => {
    const member = makeTestAgent({ friendlyName: 'subprocess-only-member' });
    memberId = member.id;
    addAgent(member);
    // No sessionRegistry entry at all -- this member has never connected interactively.

    const result = await executePrompt({ member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 });

    // The subprocess path was taken (execCommand called, normal success
    // result), not interactive routing (which never touches execCommand).
    expect(mockExecCommand).toHaveBeenCalled();
    expect(resultText(result)).toContain('subprocess-only-member');
    expect(resultText(result)).toContain('ok');
  });

  it('falls through to the subprocess path even WITH a live session, for a non-Claude provider (apra-fleet-us9.9: mode b is Claude-only)', async () => {
    const member = makeTestAgent({ friendlyName: 'gemini-with-live-session', llmProvider: 'gemini' });
    memberId = member.id;
    addAgent(member);

    // This member DOES have a live sessionRegistry entry -- registerMcpEndpoint
    // gives Gemini/Codex/OpenCode basic MCP tool access (apra-fleet-fnz.1-3),
    // but docs/interactive-injection-provider-survey.md confirms none of them
    // can receive/act on a server-push mid-session prompt injection the way
    // Claude can. Routing to it anyway would silently burn the whole timeout.
    const notification = vi.fn().mockResolvedValue(undefined);
    const workspaceId = getTokenIssuer().workspaceId();
    sessionRegistry.register({
      member_id: memberId,
      workspace_id: workspaceId,
      role: 'doer',
      work_folder: member.workFolder,
      server: { server: { notification } } as any,
      status: 'online',
    });

    const result = await executePrompt({ member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 });

    expect(mockExecCommand).toHaveBeenCalled();
    expect(notification).not.toHaveBeenCalled();
    expect(resultText(result)).toContain('gemini-with-live-session');
  });
});

// apra-fleet-eft.28.1: a persistent interactive session whose underlying
// member claude process has already died must never be silently reused --
// this is the fix for the bug in apra-fleet-eft.28, where a dead launch-time
// process left a reusable-looking sessionRegistry entry and the dispatch
// hung silently for the full timeout_s (observed up to 3600s) with no
// watchdog coverage.
describe('dead interactive session detection (apra-fleet-eft.28.1)', () => {
  let memberId: string;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    restoreRegistry();
    if (memberId) {
      inFlightAgents.delete(memberId);
      sessionRegistry.unregister(getTokenIssuer().workspaceId(), memberId);
    }
  });

  it('pre-dispatch check: a session whose pid is already dead is discarded, never reused, and returns a dispatch_failed structured error', async () => {
    const member = makeTestAgent({ friendlyName: 'dead-pid-member' });
    memberId = member.id;
    addAgent(member);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: any = new Error('kill ESRCH');
      err.code = 'ESRCH';
      throw err;
    });

    const notification = vi.fn().mockResolvedValue(undefined);
    const workspaceId = getTokenIssuer().workspaceId();
    sessionRegistry.register({
      member_id: memberId,
      workspace_id: workspaceId,
      role: 'doer',
      work_folder: member.workFolder,
      server: { server: { notification } } as any,
      pid: 424242,
      status: 'online',
    });

    const result = await executePrompt({ member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 });

    expect(killSpy).toHaveBeenCalledWith(424242, 0);
    // Fails fast with a surfaced, structured dispatch_failed error -- never
    // silently hangs waiting for a reply that can never arrive.
    expect(result).not.toBe(undefined);
    expect((result as any).structuredContent).toEqual({ isError: true, reason: 'dispatch_failed' });
    expect(resultText(result)).toContain('dead-pid-member');
    expect(resultText(result)).toContain('424242');
    // send_message/notification (and therefore the subprocess path) must
    // never fire -- the dead session is rejected before any dispatch attempt.
    expect(notification).not.toHaveBeenCalled();
    expect(mockExecCommand).not.toHaveBeenCalled();
    // The stale session entry is discarded, not left behind for a future
    // dispatch to trip over again.
    expect(sessionRegistry.get(workspaceId, memberId)).toBeUndefined();
    expect(inFlightAgents.has(memberId)).toBe(false);
  });

  it('a session with no captured pid is left to the pre-existing (unchanged) behavior', async () => {
    const member = makeTestAgent({ friendlyName: 'no-pid-member' });
    memberId = member.id;
    addAgent(member);

    const notification = vi.fn().mockResolvedValue(undefined);
    const workspaceId = getTokenIssuer().workspaceId();
    sessionRegistry.register({
      member_id: memberId,
      workspace_id: workspaceId,
      role: 'doer',
      work_folder: member.workFolder,
      server: { server: { notification } } as any,
      // no pid captured
      status: 'online',
    });

    const promptPromise = executePrompt({ member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 });
    await vi.waitFor(() => expect(notification).toHaveBeenCalledTimes(1));
    const msgid = notification.mock.calls[0][0].params.meta.msgid;
    await respondToMessage({ reply_to: msgid, content: 'still works' });

    const result = await promptPromise;
    expect(resultText(result)).toContain('still works');
  });

  it('mid-wait liveness poll: rejects with a terminal error (not a full-timeout hang) when the member process dies AFTER dispatch has started waiting', async () => {
    const member = makeTestAgent({ friendlyName: 'dies-mid-wait-member' });
    memberId = member.id;
    addAgent(member);

    // Alive for the pre-dispatch check (call #1), then dead from the first
    // mid-wait liveness poll onward (apra-fleet-eft.28.1's
    // INTERACTIVE_LIVENESS_POLL_MS = 5000ms poll interval) -- simulating the
    // process dying right after send_message lands, mid-turn, with no
    // further signal ever arriving.
    let killCalls = 0;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      killCalls += 1;
      if (killCalls === 1) return true as any;
      const err: any = new Error('kill ESRCH');
      err.code = 'ESRCH';
      throw err;
    });

    const notification = vi.fn().mockResolvedValue(undefined);
    const workspaceId = getTokenIssuer().workspaceId();
    sessionRegistry.register({
      member_id: memberId,
      workspace_id: workspaceId,
      role: 'doer',
      work_folder: member.workFolder,
      server: { server: { notification } } as any,
      pid: 777,
      status: 'online',
    });

    vi.useFakeTimers();
    // timeout_s is deliberately large (matching the playbook's real-world
    // 3600s interactive timeout) -- the liveness poll must short-circuit the
    // wait well before this, not fall back on it as the only backstop.
    const promptPromise = executePrompt({ member_id: memberId, prompt: 'hi', resume: false, timeout_s: 3600 });

    // Let send_message's (awaited, microtask-resolving) notification land
    // before advancing the fake-timer poll interval.
    await vi.advanceTimersByTimeAsync(0);
    expect(notification).toHaveBeenCalledTimes(1);

    // First liveness poll tick: the process is now dead.
    await vi.advanceTimersByTimeAsync(5000);

    const result = await promptPromise;

    expect(killSpy).toHaveBeenCalledWith(777, 0);
    expect(resultText(result)).toContain('died while this dispatch was waiting for a response');
    expect(resultText(result)).toContain('dies-mid-wait-member');
    expect(inFlightAgents.has(memberId)).toBe(false);
    // The dead session must be discarded here too, not left registered.
    expect(sessionRegistry.get(workspaceId, memberId)).toBeUndefined();
  });
});
