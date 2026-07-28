import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { StallDetector, type StallEntry } from '../src/services/stall/stall-detector.js';
import { executePrompt, inFlightAgents, provisionedRemoteAgents } from '../src/tools/execute-prompt.js';
import { getStallDetector } from '../src/services/stall/index.js';
import { setStoredPid } from '../src/utils/agent-helpers.js';
import { getOsCommands } from '../src/os/index.js';
import type { SSHExecResult } from '../src/types.js';

/**
 * apra-fleet-6z8.2 -- the stall detector could neither see progress nor see a
 * real stall on a bd/git-tool-heavy turn, because stall-poller only recognized
 * type==='assistant' entries in a 500-byte tail and stall-detector.ts never
 * counts a null read as a stall cycle. These tests drive the REAL poller
 * through the REAL detector so the whole chain is covered, not just a mock of
 * one half of it.
 */

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

const mockExecCommand = vi.fn();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/agent-provisioner.js', () => ({
  provisionAgents: vi.fn().mockResolvedValue({ pushed: [] }),
  remoteAgentsDir: vi.fn().mockReturnValue('.claude/agents/pm'),
}));

function jsonLines(...objs: Record<string, unknown>[]): string {
  return objs.map(o => JSON.stringify(o)).join('\n');
}

function makeEntry(memberId: string, overrides: Partial<StallEntry> = {}): StallEntry {
  return {
    sessionId: 'session-abc',
    logFilePath: '/home/testuser/.claude/projects/p/session-abc.jsonl',
    lastActivityAt: Date.now(),
    consecutiveIdleCycles: 0,
    consecutiveReadFailures: 0,
    memberId,
    memberName: 'alice',
    provisional: false,
    stallReported: false,
    ...overrides,
  };
}

describe('stall detection on a tool-heavy turn (apra-fleet-6z8.2)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    process.env['STALL_THRESHOLD_MS'] = '120000';
  });

  afterEach(() => {
    restoreRegistry();
    delete process.env['STALL_THRESHOLD_MS'];
  });

  it('counts newly appended tool_result/user entries as activity -- no stall, and lastActivityAt advances', async () => {
    const member = makeTestAgent({ friendlyName: 'tool-heavy', os: 'macos' });
    addAgent(member);

    // A tail that never lands on an assistant-type line -- the common shape for
    // a Planner/doer turn dominated by bd/git tool calls -- but whose newest
    // entry is only seconds old, i.e. the turn is demonstrably progressing.
    const fresh = new Date().toISOString();
    mockExecCommand.mockResolvedValue({
      stdout: jsonLines(
        { type: 'user', timestamp: new Date(Date.now() - 60_000).toISOString(), message: { content: [{ type: 'tool_result', content: 'bd ready output' }] } },
        { type: 'user', timestamp: fresh, message: { content: [{ type: 'tool_result', content: 'git log output' }] } },
      ),
      stderr: '',
      code: 0,
    } satisfies SSHExecResult);

    const detector = new StallDetector();
    const onStall = vi.fn();
    // Pinned well past the 120s threshold, exactly as observed live: the entry
    // was stuck at its stall_add timestamp because every poll returned null.
    detector.add(member.id, makeEntry(member.id, { lastActivityAt: Date.now() - 240_000, onStall }));

    await detector._poll();

    expect(onStall).not.toHaveBeenCalled();
    const after = detector.getEntry(member.id)!;
    // The decisive assertion: activity ADVANCED to the tool_result's timestamp.
    // Under the old assistant-only extractor this stayed pinned at the original
    // value, and the threshold check below was never even reached.
    expect(after.lastActivityAt).toBe(new Date(fresh).getTime());
    expect(after.stallReported).toBe(false);
  });

  it('detects a genuine stall (no new entry of ANY type past the threshold) and fires onStall', async () => {
    const member = makeTestAgent({ friendlyName: 'wedged', os: 'macos' });
    addAgent(member);

    const stale = new Date(Date.now() - 300_000).toISOString();
    mockExecCommand.mockResolvedValue({
      stdout: jsonLines(
        { type: 'user', timestamp: stale, message: { content: [{ type: 'tool_result', content: 'last thing that ever happened' }] } },
      ),
      stderr: '',
      code: 0,
    } satisfies SSHExecResult);

    const detector = new StallDetector();
    const onStall = vi.fn();
    detector.add(member.id, makeEntry(member.id, { lastActivityAt: new Date(stale).getTime(), onStall }));

    await detector._poll();

    expect(onStall).toHaveBeenCalledTimes(1);
    expect(detector.getEntry(member.id)!.stallReported).toBe(true);
  });
});

describe('confirmed stall kills the wedged remote process (apra-fleet-6z8.2)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    provisionedRemoteAgents.clear();
  });

  afterEach(() => {
    restoreRegistry();
    inFlightAgents.clear();
  });

  it("execute_prompt's onStall calls tryKillPid on the tracked pid, not just clearing bookkeeping", async () => {
    const member = makeTestAgent({ friendlyName: 'stall-kill', os: 'macos' });
    addAgent(member);

    const issued: string[] = [];
    let releaseDispatch: (r: SSHExecResult) => void = () => {};
    mockExecCommand.mockImplementation(async (cmd: string): Promise<SSHExecResult> => {
      issued.push(cmd);
      if (cmd.includes('FLEET_PID')) {
        // Hold the dispatch open so the stall callback fires mid-flight, the
        // way the real poll loop sees it.
        return new Promise<SSHExecResult>(res => { releaseDispatch = res; });
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    const promise = executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 5 });
    // Let the dispatch register with the stall detector and start the exec.
    await new Promise(r => setTimeout(r, 20));

    const entry = getStallDetector().getEntry(member.id);
    expect(entry).toBeDefined();

    // The pid the FLEET_PID marker records (ssh.ts/strategy.ts setStoredPid).
    setStoredPid(member.id, 4242);
    entry!.onStall!();
    await new Promise(r => setTimeout(r, 20));

    expect(inFlightAgents.has(member.id)).toBe(false);
    expect(issued).toContain(getOsCommands('macos').killPid(4242));

    releaseDispatch({ stdout: JSON.stringify({ result: 'late', session_id: 's1' }), stderr: '', code: 0 });
    await promise;
  });
});
