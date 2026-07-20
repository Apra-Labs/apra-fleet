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
