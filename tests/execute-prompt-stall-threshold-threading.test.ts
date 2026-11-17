import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { getStallDetector, type StallEntry } from '../src/services/stall/index.js';
import { _resetKnownSessions } from '../src/services/known-sessions.js';
import type { SSHExecResult } from '../src/types.js';

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

const mockExecCommand = vi.fn<
  (
    cmd: string,
    timeout?: number,
    maxTotalMs?: number,
    onPidCaptured?: (pid: number) => void,
    signal?: AbortSignal,
  ) => Promise<SSHExecResult>
>();

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

import { executePrompt, provisionedRemoteAgents, type ExecutePromptInput } from '../src/tools/execute-prompt.js';

// apra-fleet-25yl.1.4: end-to-end (tool-level) proof that execute_prompt feeds
// input.timeout_s into the stall detector at EVERY entry transition, not just
// the first one.
//
// WHY THE SENTINEL: StallDetector.update() merges (`{...existing, ...partial}`),
// so once add() has written thresholdMs a later update() that OMITS thresholdMs
// is indistinguishable from one that re-asserts it -- a plain getEntry() read
// would still show the right number and the test would not discriminate per
// call site. So after observing each transition we poison the live entry's
// thresholdMs with POISON_MS. The NEXT transition can only read back the real
// value if that call site actually passes thresholdMs itself. Each recorded
// snapshot therefore tests exactly one call site.
const POISON_MS = -1;

interface Transition {
  kind: 'add' | 'update';
  thresholdMs: number | undefined;
}

function instrumentStallDetector(memberId: string, transitions: Transition[]): () => void {
  const detector = getStallDetector();
  const realAdd = detector.add.bind(detector);
  const realUpdate = detector.update.bind(detector);

  const observeAndPoison = (kind: 'add' | 'update') => {
    const entry = detector.getEntry(memberId);
    transitions.push({ kind, thresholdMs: entry?.thresholdMs });
    if (entry) entry.thresholdMs = POISON_MS;
  };

  const addSpy = vi.spyOn(detector, 'add').mockImplementation((id: string, entry: StallEntry) => {
    realAdd(id, entry);
    if (id === memberId) observeAndPoison('add');
  });
  const updateSpy = vi.spyOn(detector, 'update').mockImplementation((id: string, partial: Partial<StallEntry>) => {
    realUpdate(id, partial);
    if (id === memberId) observeAndPoison('update');
  });

  return () => {
    addSpy.mockRestore();
    updateSpy.mockRestore();
  };
}

/**
 * Drive one full successful dispatch. The main prompt command is the only
 * exec call that reports a pid, which is what fires the mid-dispatch
 * (onPidCaptured) stall-detector transition.
 */
function setupSuccessfulDispatch(sessionId: string): void {
  mockExecCommand.mockImplementation(async (cmd, _timeout, _maxTotalMs, onPidCaptured) => {
    if (cmd.includes('--print') || cmd.includes('-p ') || cmd.includes('claude')) {
      onPidCaptured?.(4242);
    }
    return {
      stdout: JSON.stringify({ result: 'ok', session_id: sessionId }),
      stderr: '',
      code: 0,
    };
  });
}

describe('execute_prompt threads timeout_s into every stall detector entry transition (apra-fleet-25yl.1.4)', () => {
  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    provisionedRemoteAgents.clear();
    _resetKnownSessions();
  });

  afterEach(() => {
    restoreRegistry();
    _resetKnownSessions();
    // The dispatch's own finally block removes the entry; this is belt-and-braces
    // so a failed assertion cannot leak an entry into a sibling test.
    getStallDetector().stallCheckList.clear();
    vi.restoreAllMocks();
  });

  it('timeout_s=1800 yields thresholdMs === 1_800_000 at add() AND at all three update() transitions', async () => {
    const member = makeTestAgent({ friendlyName: 'threading-1800' });
    addAgent(member);
    const transitions: Transition[] = [];
    const restore = instrumentStallDetector(member.id, transitions);
    setupSuccessfulDispatch('sess-1800');

    try {
      await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 1800 } as ExecutePromptInput);
    } finally {
      restore();
    }

    // One provisional add() plus the three update() transitions:
    // session-id resolution (pre-spawn), mid-dispatch session mint
    // (onPidCaptured), post-dispatch final session id.
    expect(transitions.map((t) => t.kind)).toEqual(['add', 'update', 'update', 'update']);
    // Because every observation poisons the entry, each of these four values can
    // only be 1_800_000 if its own call site passed thresholdMs.
    expect(transitions.map((t) => t.thresholdMs)).toEqual([1_800_000, 1_800_000, 1_800_000, 1_800_000]);
  });

  it('omitting timeout_s yields thresholdMs === 300_000 (the documented default), not 150_000', async () => {
    const member = makeTestAgent({ friendlyName: 'threading-default' });
    addAgent(member);
    const transitions: Transition[] = [];
    const restore = instrumentStallDetector(member.id, transitions);
    setupSuccessfulDispatch('sess-default');

    try {
      // Cast: the zod-inferred input type makes timeout_s required (it has a
      // schema default), but the tool re-applies its own `?? 300` fallback for
      // callers that never went through the schema. This exercises that
      // fallback, which is the one that must NOT be 150_000.
      await executePrompt({ member_id: member.id, prompt: 'hi', resume: false } as unknown as ExecutePromptInput);
    } finally {
      restore();
    }

    expect(transitions.length).toBeGreaterThan(0);
    for (const t of transitions) {
      expect(t.thresholdMs).toBe(300_000);
      expect(t.thresholdMs).not.toBe(150_000);
    }
  });

  it('leaves no stall detector entry behind and contacts no real member', async () => {
    const member = makeTestAgent({ friendlyName: 'threading-cleanup' });
    addAgent(member);
    setupSuccessfulDispatch('sess-cleanup');

    expect(getStallDetector().stallCheckList.size).toBe(0);
    await executePrompt({ member_id: member.id, prompt: 'hi', resume: false, timeout_s: 1800 } as ExecutePromptInput);
    expect(getStallDetector().stallCheckList.size).toBe(0);
    // Every command went through the mocked strategy layer.
    expect(mockExecCommand).toHaveBeenCalled();
  });
});
