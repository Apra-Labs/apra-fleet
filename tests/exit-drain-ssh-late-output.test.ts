/**
 * apra-fleet-qe83.8 (ssh half), criterion 2: output written by the remote
 * command immediately before the remote process exits still reaches
 * result.stdout on the src/services/ssh.ts path.
 *
 * The ssh twin of the local assertion in
 * tests/execute-command-long-running-windows.test.ts. Same invariant, same
 * exit-drain module -- but reached through a completely different completion
 * signal: sshd's `exit-status` (the channel's 'exit' event) instead of
 * child_process's 'exit'.
 *
 * WHY THIS IS NOT VACUOUS. `close` is the only other path to finalize() in
 * execCommand(), and the fake ssh2 channel below NEVER emits it -- exactly
 * what a wedged channel looks like when a surviving remote grandchild still
 * holds the far-side handles (the bug the exit-drain work exists for). So the
 * only code that can settle the returned promise is the exit-drain timer, and
 * the test asserts explicitly that the promise is still pending until that
 * timer's window elapses. The companion linux case below is the falsification
 * arm: with the real predicate returning false, the identical event sequence
 * leaves the promise pending forever.
 *
 * WHY IT IS STRONGER THAN THE LOCAL ONE. No predicate stub is used here: the
 * member is a genuine Windows member, so the REAL completesOnProcessExit()
 * gate decides, on every host OS. Nothing in this file is OS-gated, so
 * neither assertion can skip on any member (criterion 4), and there is no
 * wall-clock sleep anywhere -- the drain window is driven by
 * FLEET_EXIT_DRAIN_MS plus vitest fake timers (criterion 5).
 *
 * The ssh2 Client/stream doubles follow the pattern established by
 * tests/ssh-pool-active-channel-guard.test.ts, including its local
 * makeTestAgent: leaving authType undefined keeps getSSHConfig()/TOFU off the
 * filesystem and out of the crypto module.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Agent } from '../src/types.js';

const LATE_MARKER = 'LATE_OUTPUT_MARKER';
const DRAIN_MS = 300;

class MockStream extends EventEmitter {
  stderr = new EventEmitter();
  end = vi.fn();
  close = vi.fn();
}

class MockClient extends EventEmitter {
  execCalls: string[] = [];
  _pendingStreams: MockStream[] = [];
  end = vi.fn(() => { this.emit('close'); });
  connect(_config: unknown): void {
    // Synchronous 'ready' -- this test is about execCommand's completion
    // bookkeeping, not ssh2's real async handshake.
    this.emit('ready');
  }
  exec(command: string, cb: (err: Error | null, stream: MockStream) => void): void {
    this.execCalls.push(command);
    const stream = new MockStream();
    this._pendingStreams.push(stream);
    cb(null, stream);
  }
}

let lastClient: MockClient | undefined;

vi.mock('ssh2', () => ({
  // A plain function (not an arrow function -- arrow functions are not
  // constructible, and src/services/ssh.ts calls `new Client()`).
  Client: vi.fn().mockImplementation(function mockClientCtor() {
    lastClient = new MockClient();
    return lastClient;
  }),
}));

function makeTestAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: `agent-${Math.random().toString(36).slice(2)}`,
    friendlyName: 'exit-drain-ssh-test-agent',
    host: `test-host-${Math.random().toString(36).slice(2)}`,
    port: 22,
    username: 'testuser',
    workFolder: '/tmp',
    llmProvider: 'claude',
    ...overrides,
  } as Agent;
}

describe('exit-drain (ssh path): late output survives the drain window (apra-fleet-qe83.8)', () => {
  let sshModule: typeof import('../src/services/ssh.js');
  const savedDrain = process.env.FLEET_EXIT_DRAIN_MS;

  beforeEach(async () => {
    vi.resetModules();
    lastClient = undefined;
    process.env.FLEET_EXIT_DRAIN_MS = String(DRAIN_MS);
    sshModule = await import('../src/services/ssh.js');
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (lastClient) { try { lastClient.end(); } catch { /* ignore */ } }
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (savedDrain === undefined) delete process.env.FLEET_EXIT_DRAIN_MS;
    else process.env.FLEET_EXIT_DRAIN_MS = savedDrain;
  });

  it('windows member: data emitted immediately before `exit` is in result.stdout, settled by the drain timer and not by `close`', async () => {
    const agent = makeTestAgent({ os: 'windows' });

    const execPromise = sshModule.execCommand(agent, 'run-the-deploy', 30 * 60 * 1000);
    let settled = false;
    execPromise.then(() => { settled = true; }, () => { settled = true; });

    // Let connect()/exec() and execCommand's own awaits run.
    await vi.advanceTimersByTimeAsync(0);
    const stream = lastClient!._pendingStreams[0];
    expect(stream).toBeDefined();

    // Remote output, with the marker written last -- i.e. immediately before
    // the remote process exits.
    stream.emit('data', Buffer.from('filler line 0\nfiller line 1\n'));
    stream.stderr.emit('data', Buffer.from('stderr tail\n'));
    stream.emit('data', Buffer.from(`${LATE_MARKER}\n`));
    // sshd reports the remote process's exit status. The channel is NEVER
    // closed: a surviving remote grandchild still holds the far-side handles.
    stream.emit('exit', 0);

    // Nothing may have settled yet -- the drain window is still open, which is
    // what makes the assertion below evidence about the drain path itself.
    await vi.advanceTimersByTimeAsync(DRAIN_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await execPromise;

    expect(result.stdout).toContain(LATE_MARKER);
    expect(result.stdout).toContain('filler line 1');
    expect(result.stderr).toContain('stderr tail');
    expect(result.code).toBe(0);
    // The exit-drain branch releases our end of the wedged channel after
    // finalizing -- never before (the ordering invariant this lane guards).
    expect(stream.close).toHaveBeenCalled();
  });

  it('windows member: a non-zero remote exit status is carried through the drain path', async () => {
    const agent = makeTestAgent({ os: 'windows' });

    const execPromise = sshModule.execCommand(agent, 'run-the-deploy', 30 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(0);
    const stream = lastClient!._pendingStreams[0];

    stream.emit('data', Buffer.from(`${LATE_MARKER}\n`));
    stream.emit('exit', 7);
    await vi.advanceTimersByTimeAsync(DRAIN_MS);

    const result = await execPromise;
    expect(result.stdout).toContain(LATE_MARKER);
    expect(result.code).toBe(7);
  });

  it('FALSIFICATION ARM -- linux member: the same exit-without-close sequence does NOT settle, proving the drain branch (not `close`) delivers the marker above', async () => {
    const agent = makeTestAgent({ os: 'linux' });

    const execPromise = sshModule.execCommand(agent, 'run-the-deploy', 30 * 60 * 1000);
    let settled = false;
    execPromise.then(() => { settled = true; }, () => { settled = true; });

    await vi.advanceTimersByTimeAsync(0);
    const stream = lastClient!._pendingStreams[0];
    stream.emit('data', Buffer.from(`${LATE_MARKER}\n`));
    stream.emit('exit', 0);

    // Far longer than any drain window: on POSIX, completion still waits for
    // `close` (the strictly-more-complete signal), unchanged by this lane.
    await vi.advanceTimersByTimeAsync(DRAIN_MS * 100);
    expect(settled).toBe(false);
    expect(stream.close).not.toHaveBeenCalled();

    // Settle it so the test leaves no pending promise behind.
    stream.emit('close', 0);
    await vi.advanceTimersByTimeAsync(0);
    const result = await execPromise;
    expect(result.stdout).toContain(LATE_MARKER);
  });
});
