import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Agent } from '../src/types.js';

// apra-fleet-9zz.2 (verification for apra-fleet-9zz.1): the SSH connection
// pool's idle-timer reap path (cleanupEntry in src/services/ssh.ts) must
// never client.end() a pool entry while a channel opened by execCommand() is
// still active -- see apra-fleet-9zz's bug report (a provisional
// stall-detector entry only refreshes the idle timer incidentally, so a
// long-running exec could in principle sit through an idle-timer fire).
//
// cleanupEntry/resetIdleTimer/IDLE_TIMEOUT/the pool Map are all module-
// private (not exported), so this drives the guard the only way a caller
// can: through the real execCommand()/closeConnection() exports, using a
// mocked `ssh2` Client (synchronous 'ready'/exec callbacks -- this test is
// about the pool's own bookkeeping, not ssh2's real handshake timing) and
// vitest fake timers to fast-forward past the 5-minute IDLE_TIMEOUT without
// an actual 5-minute wait.

class MockStream extends EventEmitter {
  stderr = new EventEmitter();
  end = vi.fn();
  close = vi.fn();
}

class MockClient extends EventEmitter {
  execCalls: string[] = [];
  end = vi.fn(() => {
    // Real ssh2 clients emit 'close' once end() tears the connection down;
    // src/services/ssh.ts's connectClient() listens for it to drop the pool
    // entry (belt-and-suspenders alongside cleanupEntry's own pool.delete()).
    this.emit('close');
  });
  connect(_config: unknown): void {
    // Synchronous 'ready' -- this test exercises the pool's own bookkeeping
    // (activeChannels/cleanupEntry), not ssh2's real async handshake.
    this.emit('ready');
  }
  exec(command: string, cb: (err: Error | null, stream: MockStream) => void): void {
    this.execCalls.push(command);
    const stream = new MockStream();
    this._pendingStreams.push(stream);
    cb(null, stream);
  }
  _pendingStreams: MockStream[] = [];
}

let lastClient: MockClient | undefined;

vi.mock('ssh2', () => ({
  // A plain function (not an arrow function -- arrow functions are not
  // constructible, and src/services/ssh.ts calls `new Client()`) that
  // returns the mock instance; JS `new` returns an explicitly-returned
  // object in place of `this`.
  Client: vi.fn().mockImplementation(function mockClientCtor() {
    lastClient = new MockClient();
    return lastClient;
  }),
}));

// getSSHConfig() reads agent.keyPath via fs.readFileSync when authType is
// 'key', and decrypts a password when authType is 'password' -- neither
// applies to this test agent (undefined authType), so the connection config
// never touches the filesystem or crypto module.
function makeTestAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: `agent-${Math.random().toString(36).slice(2)}`,
    friendlyName: 'ssh-pool-test-agent',
    host: `test-host-${Math.random().toString(36).slice(2)}`,
    port: 22,
    username: 'testuser',
    workFolder: '/tmp',
    llmProvider: 'claude',
    ...overrides,
  } as Agent;
}

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // matches src/services/ssh.ts's private IDLE_TIMEOUT

describe('SSH connection pool: cleanupEntry never reaps an entry with an active channel (apra-fleet-9zz.2)', () => {
  let sshModule: typeof import('../src/services/ssh.js');

  beforeEach(async () => {
    vi.resetModules();
    lastClient = undefined;
    sshModule = await import('../src/services/ssh.js');
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Best-effort: end whatever connection this test opened before the next
    // test's fake timers/module instance take over.
    if (lastClient) { try { lastClient.end(); } catch { /* ignore */ } }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does NOT end the client when the idle timer fires while a channel is still active (in-flight exec, no reply yet)', async () => {
    const agent = makeTestAgent();

    // Kick off a long-running command whose exec() callback fires (so the
    // channel is "opened"), but the stream never emits 'close'/'error' --
    // exactly what a still-in-flight remote command looks like. A large
    // timeout_s means the pool's own IDLE_TIMEOUT fires well before this
    // call's own inactivity timer would, isolating the guard under test.
    const execPromise = sshModule.execCommand(agent, 'sleep 600', 30 * 60 * 1000);

    // Let the mocked connect()/exec() synchronous chain (and the
    // microtask-driven awaits inside execCommand/getConnection/
    // connectWithTOFU) settle before inspecting pool state.
    await vi.advanceTimersByTimeAsync(0);

    expect(lastClient).toBeDefined();
    expect(lastClient!.execCalls).toEqual(['sleep 600']);
    expect(lastClient!.end).not.toHaveBeenCalled();

    // Fire the pool's idle timer (IDLE_TIMEOUT) while the channel above is
    // still active -- this must re-arm the timer, not reap the connection.
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);

    expect(lastClient!.end).not.toHaveBeenCalled();

    // And once more, for good measure -- a second idle-timeout period with
    // the channel still active must still not reap it.
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect(lastClient!.end).not.toHaveBeenCalled();

    // Clean up: finish the still-pending stream so execCommand's promise
    // settles and doesn't leak into the next test.
    const stream = lastClient!._pendingStreams[0];
    stream.emit('close', 0);
    await execPromise;
  });

  it('DOES end the client once the idle timer fires with no active channel (a completed command left the connection genuinely idle)', async () => {
    const agent = makeTestAgent();

    // A command that completes immediately (stream closes right after
    // exec()'s callback fires) -- by the time execCommand's promise
    // resolves, activeChannels is back to 0 and the entry is genuinely idle.
    const execPromise = sshModule.execCommand(agent, 'echo hi', 30 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(lastClient).toBeDefined();
    const stream = lastClient!._pendingStreams[0];
    stream.emit('close', 0);
    await execPromise;

    expect(lastClient!.end).not.toHaveBeenCalled();

    // Now the idle timer fires with activeChannels === 0 -- normal reap.
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);

    expect(lastClient!.end).toHaveBeenCalledTimes(1);
  });

  it('reaps normally once an active channel releases and the FULL idle window elapses afterward (guard does not permanently pin the entry)', async () => {
    const agent = makeTestAgent();

    const execPromise = sshModule.execCommand(agent, 'sleep 600', 30 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(0);

    // Idle timer fires while still active -- re-armed, not reaped (guard).
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect(lastClient!.end).not.toHaveBeenCalled();

    // The channel now finishes...
    const stream = lastClient!._pendingStreams[0];
    stream.emit('close', 0);
    await execPromise;
    expect(lastClient!.end).not.toHaveBeenCalled();

    // ...and a full fresh idle window elapses with nothing else touching the
    // connection: the re-armed timer set by the guard must still fire and
    // reap it exactly like the normal (never-guarded) path would.
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect(lastClient!.end).toHaveBeenCalledTimes(1);
  });
});
