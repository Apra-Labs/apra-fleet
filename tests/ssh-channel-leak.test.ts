/**
 * SSH channel lifecycle: every channel the SSH layer opens on a member's
 * pooled connection (exec or sftp subsystem) is closed again on every path --
 * success, error, timeout, abort. A leaked channel holds one sshd session
 * (one sftp-server process for SFTP) until the connection dies; once sshd's
 * per-connection MaxSessions (default 10) is used up, every command on that
 * member fails with "(SSH) Channel open failure: open failed".
 *
 * The ssh2 doubles follow tests/ssh-pool-active-channel-guard.test.ts, plus a
 * per-connection live-channel counter and a MaxSessions-style refusal: a
 * channel open beyond `maxSessions` live channels on one connection fails
 * exactly like OpenSSH's refusal does through ssh2.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Agent } from '../src/types.js';

const OPEN_FAILED = '(SSH) Channel open failure: open failed';

class MockChannel extends EventEmitter {
  closed = false;
  constructor(private owner: MockClient) { super(); }
  markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.owner.live -= 1;
  }
}

class MockStream extends MockChannel {
  stderr = new EventEmitter();
  end = vi.fn();
  close = vi.fn(() => { this.markClosed(); });
  /** The remote command exits and sshd closes the channel. */
  finish(code = 0): void { this.markClosed(); this.emit('close', code); }
}

type Cb = (err: Error | null) => void;

class MockSFTP extends MockChannel {
  private pending: Cb[] = [];
  end = vi.fn(() => {
    this.markClosed();
    // ssh2 fails outstanding requests when the channel goes away.
    const p = this.pending; this.pending = [];
    for (const cb of p) cb(new Error('No response from server'));
  });
  private op(remote: string, cb: Cb): void {
    if (this.closed) { cb(new Error('channel closed')); return; }
    if (remote.includes('hang')) { this.pending.push(cb); return; }
    if (remote.includes('bad')) { cb(new Error('Permission denied')); return; }
    cb(null);
  }
  mkdir = (p: string, cb: Cb) => this.op(p.includes('baddir') ? 'bad' : 'ok', cb);
  fastPut = (_l: string, r: string, cb: Cb) => this.op(r, cb);
  fastGet = (r: string, _l: string, cb: Cb) => this.op(r, cb);
  writeFile = (r: string, _d: Buffer, cb: Cb) => this.op(r, cb);
}

let clients: MockClient[] = [];
let maxSessionsForNewClients = 10;
let deferExec = false;
const deferred: Array<() => void> = [];

class MockClient extends EventEmitter {
  live = 0;
  maxSessions = maxSessionsForNewClients;
  streams: MockStream[] = [];
  sftps: MockSFTP[] = [];
  execCalls: string[] = [];
  end = vi.fn(() => { this.emit('close'); });
  connect(_config: unknown): void { this.emit('ready'); }
  private admit(): Error | null {
    if (this.live >= this.maxSessions) return new Error(OPEN_FAILED);
    this.live += 1;
    return null;
  }
  exec(command: string, cb: (err: Error | null, stream?: MockStream) => void): void {
    const run = () => {
      this.execCalls.push(command);
      const err = this.admit();
      if (err) { cb(err); return; }
      const s = new MockStream(this);
      this.streams.push(s);
      cb(null, s);
    };
    if (deferExec) deferred.push(run); else run();
  }
  sftp(cb: (err: Error | null, sftp?: MockSFTP) => void): void {
    const err = this.admit();
    if (err) { cb(err); return; }
    const s = new MockSFTP(this);
    this.sftps.push(s);
    cb(null, s);
  }
}

vi.mock('ssh2', () => ({
  Client: vi.fn().mockImplementation(function mockClientCtor() {
    const c = new MockClient();
    clients.push(c);
    return c;
  }),
}));

function makeTestAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: `agent-${Math.random().toString(36).slice(2)}`,
    friendlyName: 'leak-test-member',
    host: `test-host-${Math.random().toString(36).slice(2)}`,
    port: 22,
    username: 'testuser',
    workFolder: '/home/testuser/work',
    llmProvider: 'claude',
    os: 'linux',
    ...overrides,
  } as Agent;
}

const totalLive = () => clients.reduce((n, c) => n + c.live, 0);
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('SSH layer closes every channel it opens', () => {
  let ssh: typeof import('../src/services/ssh.js');
  let sftp: typeof import('../src/services/sftp.js');

  beforeEach(async () => {
    vi.resetModules();
    clients = [];
    maxSessionsForNewClients = 10;
    deferExec = false;
    deferred.length = 0;
    ssh = await import('../src/services/ssh.js');
    sftp = await import('../src/services/sftp.js');
    vi.useFakeTimers();
  });

  afterEach(() => {
    ssh.closeAllConnections();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('exec: success, stream error, inactivity timeout, max-total timeout and abort all leave 0 open channels', async () => {
    const agent = makeTestAgent();

    // success
    const ok = ssh.execCommand(agent, 'echo ok', 1000);
    await flush();
    clients[0].streams[0].finish(0);
    await expect(ok).resolves.toMatchObject({ code: 0 });

    // stream error
    const bad = ssh.execCommand(agent, 'boom', 1000);
    await flush();
    clients[0].streams[1].emit('error', new Error('stream broke'));
    await expect(bad).rejects.toThrow('stream broke');

    // inactivity timeout
    const idle = ssh.execCommand(agent, 'sleep 600', 1000);
    idle.catch(() => {});
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(idle).rejects.toThrow(/timed out/);

    // max-total timeout (activity keeps the inactivity timer away)
    const long = ssh.execCommand(agent, 'yes', 1000, 1500);
    long.catch(() => {});
    await flush();
    await vi.advanceTimersByTimeAsync(800);
    clients[0].streams[3].emit('data', Buffer.from('y\n'));
    await vi.advanceTimersByTimeAsync(800);
    await expect(long).rejects.toThrow(/max total time/);

    // abort
    const ac = new AbortController();
    const aborted = ssh.execCommand(agent, 'sleep 600', 60000, undefined, undefined, ac.signal);
    aborted.catch(() => {});
    await flush();
    ac.abort();
    await expect(aborted).rejects.toThrow(/aborted/);

    expect(clients).toHaveLength(1);
    expect(clients[0].streams).toHaveLength(5);
    expect(totalLive()).toBe(0);
  });

  it('exec: a timeout that fires before the channel opens still closes the channel when it arrives', async () => {
    const agent = makeTestAgent();
    deferExec = true;
    const p = ssh.execCommand(agent, 'slow-open', 1000);
    p.catch(() => {});
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).rejects.toThrow(/timed out/);
    // The exec reply arrives late.
    deferred.splice(0).forEach((run) => run());
    await flush();
    expect(clients[0].streams).toHaveLength(1);
    expect(totalLive()).toBe(0);
  });

  it('exec: the remote kill channel opened on timeout is closed too', async () => {
    const agent = makeTestAgent();
    const p = ssh.execCommand(agent, 'wrapped', 1000);
    p.catch(() => {});
    await flush();
    clients[0].streams[0].emit('data', Buffer.from('FLEET_PID:4242\n'));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).rejects.toThrow(/timed out/);
    // kill command channel opened, stdin closed
    const kill = clients[0].streams[1];
    expect(kill).toBeDefined();
    expect(kill.end).toHaveBeenCalled();
    // even if the kill command never exits, its channel is closed by the safety timer
    await vi.advanceTimersByTimeAsync(30000);
    expect(totalLive()).toBe(0);
  });

  it('sftp: upload/download/content transfers end their session on success, per-file failure, mkdir failure and abort', async () => {
    const agent = makeTestAgent();

    await expect(sftp.uploadViaSFTP(agent, ['/l/a.txt', '/l/b.txt'], 'dest')).resolves.toMatchObject({ success: ['a.txt', 'b.txt'] });
    const partial = await sftp.uploadViaSFTP(agent, ['/l/ok.txt', '/l/bad.txt'], 'dest');
    expect(partial.failed.map((f) => f.path)).toEqual(['bad.txt']);
    await sftp.uploadViaSFTP(agent, ['/l/x.txt'], 'baddir');
    await sftp.uploadContentToHome(agent, [{ relPath: 'a/b.json', content: '{}' }, { relPath: 'bad.json', content: '' }], '.fleet');
    vi.spyOn((await import('node:fs')).default, 'mkdirSync').mockImplementation((() => undefined) as any);
    await sftp.downloadViaSFTP(agent, ['r1.txt', 'bad.txt'], '/tmp/out');

    // abort while a transfer is in flight: the session is ended immediately
    const ac = new AbortController();
    const hung = sftp.uploadViaSFTP(agent, ['/l/hang.txt', '/l/next.txt'], 'dest', ac.signal);
    hung.catch(() => {});
    await flush();
    expect(totalLive()).toBe(1);
    ac.abort();
    await expect(hung).rejects.toThrow(/Aborted/);

    expect(clients).toHaveLength(1);
    expect(clients[0].sftps).toHaveLength(6);
    expect(clients[0].sftps.every((s) => s.end.mock.calls.length > 0)).toBe(true);
    expect(totalLive()).toBe(0);
  });

  it('50 consecutive transfers + commands on one connection with MaxSessions 10 all succeed', async () => {
    const agent = makeTestAgent();
    for (let i = 0; i < 25; i++) {
      const up = await sftp.uploadViaSFTP(agent, [`/l/f${i}.txt`], 'dest');
      expect(up.failed).toEqual([]);
      const run = ssh.execCommand(agent, `echo ${i}`, 1000);
      await flush();
      clients[0].streams[i].finish(0);
      await expect(run).resolves.toMatchObject({ code: 0 });
    }
    expect(clients).toHaveLength(1);
    expect(totalLive()).toBe(0);
  });

  it('channel #11 refused on a saturated connection: retried once on a fresh connection; the old one ends when its channels finish', async () => {
    const agent = makeTestAgent();
    const running: Array<Promise<unknown>> = [];
    for (let i = 0; i < 10; i++) {
      running.push(ssh.execCommand(agent, `long ${i}`, 60000));
      await flush();
    }
    expect(clients[0].live).toBe(10);

    const eleventh = ssh.execCommand(agent, 'eleventh', 60000);
    await flush();
    expect(clients).toHaveLength(2);
    expect(clients[1].execCalls).toEqual(['eleventh']);
    clients[1].streams[0].finish(0);
    await expect(eleventh).resolves.toMatchObject({ code: 0 });

    // the saturated connection is out of the pool but not torn down under its running commands
    expect(clients[0].end).not.toHaveBeenCalled();
    clients[0].streams.forEach((s) => s.finish(0));
    await Promise.all(running);
    expect(clients[0].end).toHaveBeenCalledTimes(1);
    expect(clients[1].end).not.toHaveBeenCalled();

    // new work uses the fresh connection
    const next = ssh.execCommand(agent, 'next', 1000);
    await flush();
    expect(clients).toHaveLength(2);
    clients[1].streams[1].finish(0);
    await expect(next).resolves.toMatchObject({ code: 0 });
    expect(totalLive()).toBe(0);
  });

  it('refused again on the fresh connection: a transport error naming the member and the session-limit cause', async () => {
    const agent = makeTestAgent({ friendlyName: 'kbr-remote' });
    maxSessionsForNewClients = 0;

    const run = ssh.execCommand(agent, 'anything', 1000);
    run.catch(() => {});
    await flush();
    await expect(run).rejects.toThrow(/member "kbr-remote".*Channel open failure: open failed.*MaxSessions/s);
    expect(clients).toHaveLength(2);

    await expect(sftp.uploadViaSFTP(agent, ['/l/a.txt'], 'dest')).rejects.toThrow(/kbr-remote.*MaxSessions/s);
    expect(totalLive()).toBe(0);
  });
});
