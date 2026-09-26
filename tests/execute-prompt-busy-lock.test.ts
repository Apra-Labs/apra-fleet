import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry, resultText } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executePrompt, inFlightAgents, provisionedRemoteAgents } from '../src/tools/execute-prompt.js';
import { getStallDetector } from '../src/services/stall/index.js';
import { writeStatusline } from '../src/services/statusline.js';
import { remoteAgentsDir } from '../src/services/agent-provisioner.js';
import type { SSHExecResult } from '../src/types.js';

/**
 * apra-fleet-c98q.2: regression test for the leaked execute_prompt busy lock.
 *
 * apra-fleet-c98q.1 made the whole post-claim lifetime of executePrompt sit
 * inside ONE try/finally, so no await between the busy-lock claim and the
 * end of the function can leave the lock held (see the BUSY-LOCK INVARIANT
 * comment above executePrompt in src/tools/execute-prompt.ts). Before that
 * fix, an SSH channel drop inside writePromptFile (an unguarded await)
 * escaped executePrompt with inFlightAgents still holding the member's lock
 * -- wedged busy until a server restart or a stop_prompt call.
 *
 * These tests make TWO different pre-dispatch awaits throw -- writePromptFile
 * itself, and (further upstream) ensureAgentFilesProvisioned via its
 * remoteAgentsDir() call, which sits OUTSIDE that function's own internal
 * try/catch around provisionAgents() -- and assert the lock/stall-detector
 * state is clean afterward and an immediate next dispatch is not rejected as
 * busy. A control case pins the unchanged happy path.
 */

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

// Agent-file provisioning is mocked away by default (matching
// tests/execute-prompt.test.ts's own style) so it doesn't consume the
// mockExecCommand queue -- remoteAgentsDir is overridden with
// mockImplementationOnce(() => { throw ... }) in the test that needs
// ensureAgentFilesProvisioned itself to reject.
vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: vi.fn().mockReturnValue('.claude/agents/pm'),
}));

describe('executePrompt busy-lock leak regression (apra-fleet-c98q.1/.2)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    provisionedRemoteAgents.clear();
    vi.mocked(remoteAgentsDir).mockReturnValue('.claude/agents/pm');
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('writePromptFile rejecting (ssh2-style transport error) still resolves executePrompt, releases the lock, and does not wedge the next dispatch as busy', async () => {
    const member = makeTestAgent({ friendlyName: 'writeprompt-throws-member' });
    addAgent(member);

    // The SSH drop this bug report is about: writePromptFile's underlying
    // strategy.execCommand call rejects with the raw ssh2 message, exactly
    // as an unguarded await between the lock claim and the guarded try used
    // to escape executePrompt entirely. The base resolved value lets the
    // finally's own best-effort deletePromptFile call (which still runs --
    // a write ATTEMPT was made) succeed like a real remote would, rather
    // than hitting an unrelated "no mock configured" failure.
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    mockExecCommand.mockRejectedValueOnce(new Error('No response from server'));

    const result = await executePrompt({ member_id: member.id, prompt: 'first dispatch', resume: false, timeout_s: 5 });

    // executePrompt never throws once the lock is claimed (apra-fleet-c98q.1) --
    // the failure comes back as the standard structured envelope, never a
    // bare rejected promise.
    expect(result).toBeDefined();
    if (typeof result === 'string') throw new Error('expected a structured result, got a plain string');
    expect(result.structuredContent?.isError).toBe(true);
    expect(['dispatch_failed', 'transport']).toContain(result.structuredContent?.reason);
    // Never surfaced as a JSON/schema-shaped failure -- this is a dispatch-level
    // fault, and the raw exception text is preserved for diagnosis.
    expect(resultText(result)).toContain('No response from server');

    // The lock and the stall-detector entry must both be gone -- this is the
    // actual regression: before apra-fleet-c98q.1 the SSH drop above escaped
    // with inFlightAgents still holding the member's lock.
    expect(inFlightAgents.has(member.id)).toBe(false);
    expect(getStallDetector().stallCheckList.has(member.id)).toBe(false);

    // An immediately following second dispatch to the SAME member must be
    // able to proceed -- NOT rejected with reason 'busy' (the wedge this bug
    // report describes: busy until server restart).
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'second dispatch ok', session_id: 'sess-2' }),
      stderr: '',
      code: 0,
    });
    const second = await executePrompt({ member_id: member.id, prompt: 'second dispatch', resume: false, timeout_s: 5 });
    if (typeof second === 'string') throw new Error('expected a structured result, got a plain string');
    expect(second.structuredContent?.reason).not.toBe('busy');
    expect(resultText(second)).toContain('second dispatch ok');
    expect(inFlightAgents.has(member.id)).toBe(false);
  });

  it('ensureAgentFilesProvisioned rejecting (remoteAgentsDir throwing, outside its own internal try/catch) proves the guard also covers earlier pre-dispatch awaits', async () => {
    const member = makeTestAgent({ friendlyName: 'provision-throws-member' });
    addAgent(member);

    // remoteAgentsDir() is called directly inside ensureAgentFilesProvisioned,
    // OUTSIDE that function's own try/catch around provisionAgents() -- a
    // throw here reaches executePrompt's single guard exactly like the
    // writePromptFile case above, before any exec call has been made at all.
    vi.mocked(remoteAgentsDir).mockImplementationOnce(() => {
      throw new Error('remoteAgentsDir blew up unexpectedly');
    });

    const result = await executePrompt({ member_id: member.id, prompt: 'first dispatch', resume: false, timeout_s: 5 });

    if (typeof result === 'string') throw new Error('expected a structured result, got a plain string');
    expect(result.structuredContent?.isError).toBe(true);
    expect(['dispatch_failed', 'transport']).toContain(result.structuredContent?.reason);
    expect(resultText(result)).toContain('remoteAgentsDir blew up unexpectedly');

    // Failed before writePromptFile was ever attempted -- no exec call at all.
    expect(mockExecCommand).not.toHaveBeenCalled();

    expect(inFlightAgents.has(member.id)).toBe(false);
    expect(getStallDetector().stallCheckList.has(member.id)).toBe(false);

    // Next dispatch to the same member is not wedged busy either.
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'second dispatch ok', session_id: 'sess-2' }),
      stderr: '',
      code: 0,
    });
    const second = await executePrompt({ member_id: member.id, prompt: 'second dispatch', resume: false, timeout_s: 5 });
    if (typeof second === 'string') throw new Error('expected a structured result, got a plain string');
    expect(second.structuredContent?.reason).not.toBe('busy');
    expect(resultText(second)).toContain('second dispatch ok');
    expect(inFlightAgents.has(member.id)).toBe(false);
  });

  it('control: a normal successful dispatch still releases the lock and the stall-detector entry (no regression in the happy path)', async () => {
    const member = makeTestAgent({ friendlyName: 'busy-lock-happy-path-member' });
    addAgent(member);

    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'all good', session_id: 'sess-happy' }),
      stderr: '',
      code: 0,
    });

    const result = await executePrompt({ member_id: member.id, prompt: 'do the thing', resume: false, timeout_s: 5 });
    if (typeof result === 'string') throw new Error('expected a structured result, got a plain string');
    expect(result.structuredContent?.isError).toBeFalsy();
    expect(resultText(result)).toContain('all good');

    expect(inFlightAgents.has(member.id)).toBe(false);
    expect(getStallDetector().stallCheckList.has(member.id)).toBe(false);
    expect(vi.mocked(writeStatusline)).toHaveBeenCalled();
  });
});
