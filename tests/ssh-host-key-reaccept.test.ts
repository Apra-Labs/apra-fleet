/**
 * Host-key re-accept on reconnect (TOFU heal) is never silent: when a
 * member's host key changed, connectWithTOFU re-trusts the new key, logs a
 * warning naming host, port and both fingerprints, and still hands the
 * "Host key updated" warning back (execCommand prepends it to stderr). The
 * log line is what makes it visible on paths that drop the returned warning,
 * such as SFTP transfers. ssh2 and the known_hosts store are mocked: no
 * network, and the real known_hosts file is never written.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Agent } from '../src/types.js';

const { logWarn, replaceKnownHost, state } = vi.hoisted(() => ({
  logWarn: vi.fn(),
  replaceKnownHost: vi.fn(),
  state: { mismatchConnects: 0 },
}));

vi.mock('../src/utils/log-helpers.js', async (orig) => ({
  ...(await orig<typeof import('../src/utils/log-helpers.js')>()),
  logWarn,
}));
vi.mock('../src/services/known-hosts.js', async (orig) => ({
  ...(await orig<typeof import('../src/services/known-hosts.js')>()),
  replaceKnownHost,
}));

class MockStream extends EventEmitter {
  stderr = new EventEmitter();
  end = vi.fn();
  close = vi.fn();
}

vi.mock('ssh2', async () => {
  const { HostKeyMismatchError } = await import('../src/services/known-hosts.js');
  class MockClient extends EventEmitter {
    end = vi.fn(() => { this.emit('close'); });
    connect(cfg: { host: string; port: number }): void {
      if (state.mismatchConnects > 0) {
        state.mismatchConnects -= 1;
        // What ssh2 does when hostVerifier throws: the error surfaces as 'error'.
        this.emit('error', new HostKeyMismatchError(cfg.host, cfg.port, 'SHA256:old', 'SHA256:new'));
        return;
      }
      this.emit('ready');
    }
    exec(_cmd: string, cb: (err: Error | null, s?: MockStream) => void): void {
      const s = new MockStream();
      cb(null, s);
      setImmediate(() => { s.emit('data', Buffer.from('ok\n')); s.emit('close', 0); });
    }
    sftp(cb: (err: Error | null, s?: unknown) => void): void {
      cb(null, { end: vi.fn(), mkdir: (_p: string, c: (e: null) => void) => c(null), fastPut: (_l: string, _r: string, _o: unknown, c: (e: null) => void) => c(null) });
    }
  }
  return { Client: vi.fn().mockImplementation(function mockCtor() { return new MockClient(); }) };
});

function agent(): Agent {
  return {
    id: `a-${Math.random().toString(36).slice(2)}`,
    friendlyName: 'rekeyed-member',
    host: `rekey-${Math.random().toString(36).slice(2)}`,
    port: 2222,
    username: 'u',
    workFolder: '/home/u/work',
    llmProvider: 'claude',
    os: 'linux',
  } as Agent;
}

describe('host-key re-accept on reconnect', () => {
  let ssh: typeof import('../src/services/ssh.js');
  let sftp: typeof import('../src/services/sftp.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    state.mismatchConnects = 0;
    ssh = await import('../src/services/ssh.js');
    sftp = await import('../src/services/sftp.js');
  });
  afterEach(() => ssh.closeAllConnections());

  it('execCommand: re-trusts the new key, logs the warning, and prepends it to stderr', async () => {
    const a = agent();
    state.mismatchConnects = 1;
    const res = await ssh.execCommand(a, 'echo ok', 5000);
    expect(res.code).toBe(0);
    expect(res.stderr).toMatch(new RegExp(`^Warning: Host key updated for ${a.host}:2222`));
    expect(replaceKnownHost).toHaveBeenCalledWith(a.host, 2222, 'SHA256:new');
    expect(logWarn).toHaveBeenCalledTimes(1);
    const [tag, msg, who] = logWarn.mock.calls[0];
    expect(tag).toBe('ssh');
    expect(msg).toContain(`Host key for ${a.host}:2222 changed (was SHA256:old, now SHA256:new)`);
    expect(msg).toMatch(/auto-accepted \(TOFU\)/);
    expect(who).toMatchObject({ id: a.id, friendlyName: 'rekeyed-member' });
  });

  it('an SFTP transfer, which drops the returned warning, still logs the re-accept', async () => {
    const a = agent();
    state.mismatchConnects = 1;
    await expect(sftp.uploadViaSFTP(a, ['/l/f.txt'], 'dest')).resolves.toEqual({ success: ['f.txt'], failed: [] });
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0][1]).toContain(`Host key for ${a.host}:2222 changed`);
  });

  it('an unchanged host key logs nothing', async () => {
    const res = await ssh.execCommand(agent(), 'echo ok', 5000);
    expect(res.stderr).toBe('');
    expect(logWarn).not.toHaveBeenCalled();
    expect(replaceKnownHost).not.toHaveBeenCalled();
  });
});
