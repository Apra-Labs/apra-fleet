import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry, resultText } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt, inFlightAgents } from '../src/tools/execute-prompt.js';
import { sessionRegistry } from '../src/services/session-registry.js';
import { getTokenIssuer } from '../src/services/token-issuer.js';

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

// Mutable coordinates the mockExecCommand implementation below reads, set by
// each test before dispatching -- this is what lets the mock simulate a
// connect-back arriving mid-flight on the SAME member/workspace under test.
let connectBackMemberId: string | undefined;
let connectBackWorkspaceId: string | undefined;
let connectBackWorkFolder: string | undefined;
let connectBackNotification: ReturnType<typeof vi.fn> | undefined;
// A remote agent's dispatch involves several strategy.execCommand round trips
// (tryKillPid, writePromptFile, the actual claude invocation, deletePromptFile)
// -- all routed through this same mocked execCommand. Guard so the simulated
// connect-back registers exactly once (on the first call), not once per
// helper round trip.
let connectBackFired = false;

// apra-fleet-eft.74 real-world sequence: ~1s after the dispatched claude
// process spawns, it connects back over HTTP MCP with a member JWT (the work
// folder's .mcp.json points at this fleet server). That connect-back is not
// register_member's local-spawn path, so it carries no pid anchor, and (pre
// eft.74.1) no channel-capability opt-in either. Simulated here as a
// side-effect of the mocked execCommand call, mirroring the timing of the
// real bug (the connect-back lands while the subprocess is still running).
const mockExecCommand = vi.fn().mockImplementation(async () => {
  if (connectBackMemberId && connectBackWorkspaceId && !connectBackFired) {
    connectBackFired = true;
    connectBackNotification = vi.fn().mockResolvedValue(undefined);
    sessionRegistry.register({
      member_id: connectBackMemberId,
      workspace_id: connectBackWorkspaceId,
      role: 'doer',
      work_folder: connectBackWorkFolder ?? '',
      server: { server: { notification: connectBackNotification } } as any,
      status: 'online',
      // no pid: HTTP MCP connect-back never captures a launch-time pid.
      // channelCapable deliberately omitted: plain JWT registration, no
      // `claude/channel` opt-in handshake.
    });
  }
  return { stdout: JSON.stringify({ result: 'ok', session_id: 'sess-x' }), stderr: '', code: 0 };
});

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

// apra-fleet-eft.74.3: end-to-end reproduction of the exact bug sequence --
// subprocess dispatch, pid-less JWT connect-back mid-flight, subprocess
// exits leaving the lingering registry entry, then a SECOND execute_prompt to
// the SAME member. Verifies the eft.74.1/eft.74.2 fixes actually close the
// wedge in combination, not just in isolation.
describe('phantom JWT connect-back does not permanently wedge a member (apra-fleet-eft.74.3)', () => {
  let memberId: string;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    connectBackMemberId = undefined;
    connectBackWorkspaceId = undefined;
    connectBackWorkFolder = undefined;
    connectBackNotification = undefined;
    connectBackFired = false;
  });

  afterEach(() => {
    restoreRegistry();
    if (memberId) {
      inFlightAgents.delete(memberId);
      sessionRegistry.unregister(getTokenIssuer().workspaceId(), memberId);
    }
  });

  it('reproduces the exact eft.74 sequence: subprocess dispatch + pid-less JWT connect-back, then a SECOND execute_prompt to the same member both executes and does not time out', async () => {
    const member = makeTestAgent({ friendlyName: 'phantom-connectback-member' });
    memberId = member.id;
    addAgent(member);

    const workspaceId = getTokenIssuer().workspaceId();
    connectBackMemberId = memberId;
    connectBackWorkspaceId = workspaceId;
    connectBackWorkFolder = member.workFolder;

    // Dispatch 1 (e.g. planner): no live session exists yet, so this takes
    // the subprocess path -- and, mid-execCommand, the connect-back mock
    // registers the phantom pid-less server session as a side effect,
    // mirroring the real ~1s-after-spawn HTTP MCP handshake.
    const callsBeforeFirst = mockExecCommand.mock.calls.length;
    const first = await executePrompt({ member_id: memberId, prompt: 'plan the sprint', resume: false, timeout_s: 5 });
    const callsAfterFirst = mockExecCommand.mock.calls.length;
    // The subprocess path was actually exercised (not a no-op / early return).
    expect(callsAfterFirst).toBeGreaterThan(callsBeforeFirst);
    expect(resultText(first)).toContain('phantom-connectback-member');
    expect(inFlightAgents.has(memberId)).toBe(false);

    // The subprocess has exited. HTTP MCP sessions have no teardown signal,
    // so the phantom registry entry lingers exactly as in the bug report: a
    // live `server`, no pid, no channel capability.
    const lingering = sessionRegistry.get(workspaceId, memberId);
    expect(lingering).toBeDefined();
    expect(lingering?.pid).toBeUndefined();
    expect(lingering?.channelCapable).not.toBe(true);

    // Dispatch 2: the SAME member. Pre-fix (eft.74), the interactive routing
    // block treated any live `server` entry as interactive-routable
    // regardless of pid/channel state, pushed a send_message to a session
    // nothing reads, and burned the full timeout_s -- observed 5x 900s
    // (permanent wedge) in the wild. Post-fix, the missing channel-capability
    // opt-in (eft.74.1) means this never becomes an interactive candidate, so
    // it falls straight through to a fresh subprocess dispatch and completes
    // well within timeout_s -- no wedge, no timeout.
    const callsBeforeSecond = callsAfterFirst;
    const second = await executePrompt({ member_id: memberId, prompt: 'second dispatch', resume: false, timeout_s: 5 });
    const callsAfterSecond = mockExecCommand.mock.calls.length;

    // Dispatch 2 ALSO actually executed via the subprocess path -- it did not
    // hang waiting on the phantom interactive channel (that would show up as
    // zero additional execCommand calls plus a "Timed out" result below).
    expect(callsAfterSecond).toBeGreaterThan(callsBeforeSecond);
    expect(resultText(second)).toContain('phantom-connectback-member');
    expect(resultText(second)).not.toContain('Timed out');
    expect(inFlightAgents.has(memberId)).toBe(false);
    // No interactive push was ever sent to the phantom session -- the eft.74
    // wedge (send_message to a channel nothing reads) never occurs.
    expect(connectBackNotification).not.toHaveBeenCalled();
  }, 10000);

  it('regression: existing eft.28/eft.50 dead-session guard (channel-capable session with a genuinely dead pid) is unaffected -- still evicted and re-dispatched fresh, not merely subprocess-routed via the eft.74.1 opt-in gate', async () => {
    const member = makeTestAgent({ friendlyName: 'regression-dead-pid-member' });
    memberId = member.id;
    addAgent(member);

    const workspaceId = getTokenIssuer().workspaceId();
    // No connect-back side effect in this test -- exercise the pre-existing
    // eft.28.1/eft.50.1 pid-liveness path directly, registered up front as a
    // channel-capable (genuinely interactive-eligible) session with a dead pid.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: any = new Error('kill ESRCH');
      err.code = 'ESRCH';
      throw err;
    });
    const notification = vi.fn().mockResolvedValue(undefined);
    sessionRegistry.register({
      member_id: memberId,
      workspace_id: workspaceId,
      role: 'doer',
      work_folder: member.workFolder,
      server: { server: { notification } } as any,
      pid: 999999,
      status: 'online',
      channelCapable: true,
    });

    const result = await executePrompt({ member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 });

    expect(killSpy).toHaveBeenCalledWith(999999, 0);
    expect(mockExecCommand).toHaveBeenCalled();
    expect(notification).not.toHaveBeenCalled();
    expect(sessionRegistry.get(workspaceId, memberId)).toBeUndefined();
    expect(resultText(result)).toContain('regression-dead-pid-member');
    killSpy.mockRestore();
  });
});
