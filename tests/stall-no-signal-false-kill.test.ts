/**
 * apra-fleet issue #390 / apra-fleet-igoe -- end-to-end (real StallDetector +
 * real stall-poller + real provider adapters + real registry) proof that the
 * false-kill paths are closed and the genuine-kill path still works.
 *
 * Everything below is asserted on OBSERVABLE BEHAVIOR: whether `onStall()` is
 * actually invoked, and what command string is actually sent to the member --
 * not on flag text or on a mocked resolver's return value.
 *
 * The two false-kill mechanisms this pins shut:
 *   A) codex/copilot/none: resolveSessionLogDir returns null unconditionally, so
 *      the directory poll can never produce a signal. lastActivityAt froze at
 *      dispatch start and EVERY dispatch longer than the 120s threshold was
 *      killed mid-progress.
 *   B) remote AGY/OpenCode: the log dir was resolved under the HUB's home dir
 *      ('alice'), which cannot exist on the member ('bella'), producing the same
 *      permanent no-signal state -- and the same false kill.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SSHExecResult } from '../src/types.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

const { mockExecCommand, mockWriteStatusline, mockLogWarn } = vi.hoisted(() => ({
  mockExecCommand: vi.fn<(cmd: string, timeout?: number) => Promise<SSHExecResult>>(),
  mockWriteStatusline: vi.fn(),
  mockLogWarn: vi.fn(),
}));

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({ execCommand: mockExecCommand }),
}));

vi.mock('../src/services/statusline.js', () => ({
  writeStatusline: mockWriteStatusline,
}));

vi.mock('../src/utils/log-helpers.js', () => ({
  logLine: vi.fn(),
  logWarn: mockLogWarn,
  LogScope: class {
    constructor(_tag: string, _msg: string) {}
    getInv() { return 'test'; }
    info(_msg: string) {}
    warn(_msg: string) {}
    error(_msg: string) {}
    ok(_msg?: string) {}
    fail(_msg: string) {}
    abort(_msg: string) {}
  },
}));

import { addAgent } from '../src/services/registry.js';
import { StallDetector, type StallEntry } from '../src/services/stall/stall-detector.js';
import { clearMemberHomeDirCache } from '../src/services/member-home.js';

const HUB_HOME_MARKER = 'alice';

function entryFor(memberId: string, onStall: () => void, idleMs: number): StallEntry {
  return {
    sessionId: null,
    logFilePath: null,       // provider-minted session -> provisional dispatch
    lastActivityAt: Date.now() - idleMs,
    consecutiveIdleCycles: 0,
    consecutiveReadFailures: 0,
    memberId,
    memberName: 'bella-member',
    provisional: true,
    stallReported: false,
    onStall,
  };
}

describe('no-signal dispatches are not killed by the stall detector (#390 / igoe)', () => {
  let detector: StallDetector;

  beforeEach(() => {
    backupAndResetRegistry();
    vi.clearAllMocks();
    clearMemberHomeDirCache();
    detector = new StallDetector();
    process.env['STALL_THRESHOLD_MS'] = '5000';
  });

  afterEach(() => {
    restoreRegistry();
    clearMemberHomeDirCache();
    delete process.env['STALL_THRESHOLD_MS'];
  });

  it.each(['codex', 'copilot', 'none'] as const)(
    '%s: a dispatch 10x past the stall threshold is NOT killed (no log dir exists to poll)',
    async provider => {
      const agent = makeTestAgent({
        friendlyName: 'bella-member',
        username: 'bella',
        os: 'linux',
        llmProvider: provider,
        workFolder: '/home/bella/work/repo',
      });
      addAgent(agent);

      const onStall = vi.fn();
      detector.add(agent.id, entryFor(agent.id, onStall, 50_000));

      await detector._poll();
      await detector._poll();

      expect(onStall).not.toHaveBeenCalled();
      // Short-circuited before any member-side command -- not even a home probe.
      expect(mockExecCommand).not.toHaveBeenCalled();
      expect(mockLogWarn.mock.calls.filter(c => c[0] === 'stall_no_signal')).toHaveLength(1);
    }
  );

  it('remote AGY: an UNVERIFIED (username-fallback) directory that yields nothing does NOT license a kill', async () => {
    const agent = makeTestAgent({
      friendlyName: 'bella-member',
      username: 'bella',
      os: 'linux',
      llmProvider: 'agy',
      workFolder: '/home/bella/work/repo',
    });
    addAgent(agent);

    // Home probe fails (member briefly unreachable), so the home dir falls back
    // to the username convention -- a GUESS. Pre-#390 the fallback was the HUB's
    // home dir, the directory poll found nothing, and the dispatch was killed.
    // Now the guessed dir is still polled (a right guess preserves protection),
    // but an empty result from an unverified path is not stall evidence.
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd.includes('$HOME')) return { stdout: '', stderr: 'ssh: connect failed', code: 255 };
      return { stdout: '', stderr: '', code: 0 };
    });

    const onStall = vi.fn();
    detector.add(agent.id, entryFor(agent.id, onStall, 50_000));

    await detector._poll();

    expect(onStall).not.toHaveBeenCalled();
    const dirPollCmd = mockExecCommand.mock.calls.map(c => c[0]).find(c => c.includes('find '));
    expect(dirPollCmd).toContain('/home/bella/.gemini/antigravity-cli/brain');
    expect(dirPollCmd).not.toContain(HUB_HOME_MARKER);
  });

  it('remote AGY: an unverified directory that DOES yield files becomes a real signal', async () => {
    const agent = makeTestAgent({
      friendlyName: 'bella-member',
      username: 'bella',
      os: 'linux',
      llmProvider: 'agy',
      workFolder: '/home/bella/work/repo',
    });
    addAgent(agent);

    // Guess is correct: files are found there. That verifies the path, so a
    // later freeze on it IS legitimate stall evidence -- here the mtime is old,
    // so the kill fires.
    const staleSecs = Math.floor((Date.now() - 60_000) / 1000);
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd.includes('$HOME')) return { stdout: '', stderr: 'ssh: connect failed', code: 255 };
      return { stdout: `${staleSecs}\n`, stderr: '', code: 0 };
    });

    const onStall = vi.fn();
    detector.add(agent.id, entryFor(agent.id, onStall, 300_000));

    await detector._poll();

    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('remote AGY: polls the MEMBER\'s brain dir (bella), never the hub\'s (alice)', async () => {
    const agent = makeTestAgent({
      friendlyName: 'bella-member',
      username: 'bella',
      os: 'linux',
      llmProvider: 'agy',
      workFolder: '/home/bella/work/repo',
    });
    addAgent(agent);

    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd.includes('$HOME')) return { stdout: '/home/bella\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 }; // directory poll: no files yet
    });

    const onStall = vi.fn();
    detector.add(agent.id, entryFor(agent.id, onStall, 50_000));

    await detector._poll();

    const dirPollCmd = mockExecCommand.mock.calls.map(c => c[0]).find(c => c.includes('find '));
    expect(dirPollCmd).toBeDefined();
    expect(dirPollCmd).toContain('/home/bella/.gemini/antigravity-cli/brain');
    expect(dirPollCmd).not.toContain(HUB_HOME_MARKER);
    // Forward slashes: the member is Linux even if this hub is Windows.
    expect(dirPollCmd).not.toContain('\\.gemini');

    // A REAL signal mechanism exists and reports no activity -> this IS a
    // genuine stall, so the kill must still fire.
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('remote AGY on a Windows member: polls C:\\Users\\bella\\... with backslashes', async () => {
    const agent = makeTestAgent({
      friendlyName: 'bella-member',
      username: 'bella',
      os: 'windows',
      llmProvider: 'agy',
      workFolder: 'C:\\Users\\bella\\work\\repo',
    });
    addAgent(agent);

    mockExecCommand.mockImplementation(async (cmd: string) => {
      // Windows probe is delivered via wrapPowerShellEncoded (base64
      // -EncodedCommand), not a raw inline string -- decode to inspect it.
      const encodedMatch = cmd.match(/-EncodedCommand (\S+)/);
      const decodedCmd = encodedMatch ? Buffer.from(encodedMatch[1], 'base64').toString('utf16le') : cmd;
      if (decodedCmd.includes('USERPROFILE')) return { stdout: 'C:\\Users\\bella', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    const onStall = vi.fn();
    detector.add(agent.id, entryFor(agent.id, onStall, 50_000));

    await detector._poll();

    const dirPollCmd = mockExecCommand.mock.calls.map(c => c[0]).find(c => c.includes('Get-ChildItem'));
    expect(dirPollCmd).toBeDefined();
    expect(dirPollCmd).toContain('C:\\Users\\bella\\.gemini\\antigravity-cli\\brain');
    expect(dirPollCmd).not.toContain(HUB_HOME_MARKER);
  });

  // SF-19: the no-signal warning used to latch on `stallReported`, the same flag
  // that gates the genuine-kill check. One transient no-signal tick therefore
  // disarmed real stall protection for the rest of the dispatch. Separate flags
  // (`noSignalReported` vs `stallReported`) keep the two independent.
  it('a transient no-signal tick does NOT disarm the genuine kill on a later tick', async () => {
    const agent = makeTestAgent({
      friendlyName: 'bella-member',
      username: undefined,      // no username -> no fallback home dir either
      os: 'linux',
      llmProvider: 'agy',
      workFolder: '/home/bella/work/repo',
    });
    addAgent(agent);

    const onStall = vi.fn();
    detector.add(agent.id, entryFor(agent.id, onStall, 50_000));

    // Tick 1: member briefly unreachable, and with no username there is no
    // fallback home dir -- no pollable directory at all, so NO signal.
    mockExecCommand.mockImplementation(async () => ({ stdout: '', stderr: 'ssh: connect failed', code: 255 }));
    await detector._poll();
    expect(onStall).not.toHaveBeenCalled();
    expect(mockLogWarn.mock.calls.filter(c => c[0] === 'stall_no_signal')).toHaveLength(1);

    // Tick 2: member reachable again, so a REAL signal exists -- and the brain
    // dir's newest file is frozen well past the stall threshold. This is a
    // genuine stall and the kill must fire despite tick 1.
    const staleSecs = Math.floor((Date.now() - 300_000) / 1000);
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd.includes('$HOME')) return { stdout: '/home/bella\n', stderr: '', code: 0 };
      return { stdout: `${staleSecs}\n`, stderr: '', code: 0 };
    });
    await detector._poll();

    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('remote AGY: fresh directory activity keeps a live dispatch alive', async () => {
    const agent = makeTestAgent({
      friendlyName: 'bella-member',
      username: 'bella',
      os: 'linux',
      llmProvider: 'agy',
      workFolder: '/home/bella/work/repo',
    });
    addAgent(agent);

    const nowSecs = Math.floor(Date.now() / 1000);
    mockExecCommand.mockImplementation(async (cmd: string) => {
      if (cmd.includes('$HOME')) return { stdout: '/home/bella\n', stderr: '', code: 0 };
      return { stdout: `${nowSecs}\n`, stderr: '', code: 0 };
    });

    const onStall = vi.fn();
    detector.add(agent.id, entryFor(agent.id, onStall, 50_000));

    await detector._poll();

    expect(onStall).not.toHaveBeenCalled();
    expect(detector.getEntry(agent.id)?.lastActivityAt).toBe(nowSecs * 1000);
  });
});
