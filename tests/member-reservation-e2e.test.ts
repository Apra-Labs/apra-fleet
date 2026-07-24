/**
 * End-to-end integration test for feature apra-fleet-eft.10 (server-side
 * member reservation): chains the real memberReservation, executePrompt,
 * and listMembers tools together -- not just each tool's unit tests in
 * isolation -- to prove the whole reservation lifecycle works end-to-end
 * against the existing server/dispatch test harness (mocked SSH strategy,
 * same as tests/execute-prompt.test.ts).
 *
 * Covers the five apra-fleet-eft.10.4 assertions in one flow:
 *   1. a member reserved by sprint A rejects a dispatch from sprint B,
 *      naming sprint A as owner
 *   2. a dispatch from sprint A (the owner) against the same member succeeds
 *   3. list_members shows the reservation owner
 *   4. force_release clears a wedged reservation and a subsequent dispatch
 *      from a brand-new sprint then succeeds
 *   5. with no reservations set, dispatch behavior is unchanged (baseline)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry, resultText } from './test-helpers.js';
import { addAgent, getAgent } from '../src/services/registry.js';
import { executePrompt, inFlightAgents } from '../src/tools/execute-prompt.js';
import { memberReservation } from '../src/tools/member-reservation.js';
import { listMembers } from '../src/tools/list-members.js';
import type { SSHExecResult } from '../src/types.js';

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: vi.fn(),
  readMemberStatus: vi.fn(() => 'idle'),
}));

const mockExecCommand = vi.fn<(cmd: string, timeout?: number, maxTotalMs?: number) => Promise<SSHExecResult>>();

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: mockExecCommand,
    testConnection: vi.fn(async () => ({ ok: false })),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../src/services/cloud-sync.js', () => ({
  syncCloudCache: vi.fn(async () => ({ status: 'not-connected' })),
}));

describe('member reservation end-to-end (apra-fleet-eft.10.4)', () => {
  let memberId: string;
  const savedSprintEnv = process.env.APRA_FLEET_SPRINT_ID;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    vi.useFakeTimers();
    delete process.env.APRA_FLEET_SPRINT_ID;
  });

  afterEach(() => {
    restoreRegistry();
    vi.useRealTimers();
    if (memberId) inFlightAgents.delete(memberId);
    if (savedSprintEnv === undefined) delete process.env.APRA_FLEET_SPRINT_ID;
    else process.env.APRA_FLEET_SPRINT_ID = savedSprintEnv;
  });

  it('reserve -> cross-sprint rejected -> owner allowed -> list_members shows owner -> force_release recovers -> new sprint dispatch succeeds', async () => {
    const member = makeTestAgent({ friendlyName: 'e2e-reserved' });
    memberId = member.id;
    addAgent(member);

    // Reserve for sprint-a via the real tool (not a direct registry write).
    const reserveResult = await memberReservation({ member_id: memberId, action: 'reserve', sprint_id: 'sprint-a' });
    expect(reserveResult).toContain('reserved for "sprint-a"');

    // (1) Cross-sprint dispatch from sprint-b is rejected, naming sprint-a as owner.
    process.env.APRA_FLEET_SPRINT_ID = 'sprint-b';
    const rejected = await executePrompt({ member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 });
    expect(resultText(rejected)).toContain('reserved by sprint "sprint-a"');
    expect(mockExecCommand).not.toHaveBeenCalled();

    // (2) Dispatch from the owning sprint succeeds.
    process.env.APRA_FLEET_SPRINT_ID = 'sprint-a';
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'owner-ok', session_id: 'sess-owner' }),
      stderr: '',
      code: 0,
    });
    const allowed = await executePrompt({ member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 });
    expect(resultText(allowed)).toContain('owner-ok');
    expect(mockExecCommand).toHaveBeenCalled();

    // (3) list_members surfaces the reservation owner in both formats.
    const compact = await listMembers({ format: 'compact' });
    expect(compact).toContain('reserved-by=sprint-a');
    const json = JSON.parse(await listMembers({ format: 'json' }));
    const listed = json.members.find((m: { id: string }) => m.id === memberId);
    expect(listed.reservedBy).toBe('sprint-a');

    // (4) force_release clears a wedged reservation regardless of owner...
    const forceReleaseResult = await memberReservation({ member_id: memberId, action: 'force_release' });
    expect(forceReleaseResult).toContain('forcibly cleared');
    expect(getAgent(memberId)?.reservedBy ?? null).toBeNull();

    // ...and a subsequent dispatch from a brand-new sprint now succeeds.
    vi.clearAllMocks();
    process.env.APRA_FLEET_SPRINT_ID = 'sprint-c';
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'recovered-ok', session_id: 'sess-recovered' }),
      stderr: '',
      code: 0,
    });
    const recovered = await executePrompt({ member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 });
    expect(resultText(recovered)).toContain('recovered-ok');
    expect(mockExecCommand).toHaveBeenCalled();
  });

  it('(5) no-reservation baseline: dispatch and list_members are unchanged regardless of sprint env', async () => {
    const member = makeTestAgent({ friendlyName: 'e2e-free' });
    memberId = member.id;
    addAgent(member);
    process.env.APRA_FLEET_SPRINT_ID = 'sprint-anything';
    mockExecCommand.mockResolvedValue({
      stdout: JSON.stringify({ result: 'free-ok', session_id: 'sess-free' }),
      stderr: '',
      code: 0,
    });

    const result = await executePrompt({ member_id: memberId, prompt: 'hi', resume: false, timeout_s: 5 });
    expect(resultText(result)).toContain('free-ok');
    expect(mockExecCommand).toHaveBeenCalled();

    const compact = await listMembers({ format: 'compact' });
    expect(compact).not.toContain('reserved-by=');
    const json = JSON.parse(await listMembers({ format: 'json' }));
    const listed = json.members.find((m: { id: string }) => m.id === memberId);
    expect(listed.reservedBy).toBeNull();
  });
});
