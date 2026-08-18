import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Agent } from '../src/types.js';

// rmkb-3n5.5.1: openReverseTunnel() asks the MEMBER's sshd to listen on its
// own loopback and pipes every accepted channel back to the fleet server's
// loopback MCP port. The properties pinned here are the ones the design
// depends on:
//   - a DEDICATED, NON-POOLED connection (the pool's 5-minute idle reaper must
//     not be able to kill a live tunnel mid-dispatch),
//   - the bind is requested on 127.0.0.1 with port 0 (sshd picks the port and
//     reports it back) -- never on a routable interface,
//   - accepted channels are piped both ways to 127.0.0.1:<localPort>,
//   - close() unforwards + ends the connection, is idempotent, and is safe
//     after the connection has already dropped,
//   - an sshd that refuses forwarding (AllowTcpForwarding no) surfaces as a
//     DISTINCT error class from a transport failure.
//
// ssh2 and node:net are both mocked: this is about our own bookkeeping, not
// ssh2's handshake or real sockets.

class MockChannel extends EventEmitter {
  pipe = vi.fn((dest: unknown) => dest);
  close = vi.fn(() => { this.emit('close'); });
}

class MockSocket extends EventEmitter {
  pipe = vi.fn((dest: unknown) => dest);
  destroy = vi.fn();
}

const createdSockets: MockSocket[] = [];
const netConnectCalls: Array<[number, string]> = [];

function fakeNetConnect(port: number, host: string): MockSocket {
  netConnectCalls.push([port, host]);
  const socket = new MockSocket();
  createdSockets.push(socket);
  return socket;
}

vi.mock('node:net', () => ({
  default: { connect: (port: number, host: string) => fakeNetConnect(port, host) },
  connect: (port: number, host: string) => fakeNetConnect(port, host),
}));

interface Behavior {
  /** How the mocked client answers connect(): 'ready' or an error message. */
  connect: 'ready' | { error: string };
  /** How the mocked sshd answers the tcpip-forward request. */
  forward: { port: number } | { error: string } | 'silent' | { throws: string };
  /** Whether unforwardIn's callback ever fires. */
  unforwardReplies: boolean;
}

let behavior: Behavior;

class MockClient extends EventEmitter {
  connectConfig: unknown;
  forwardInCalls: Array<[string, number]> = [];
  unforwardInCalls: Array<[string, number]> = [];
  end = vi.fn(() => { this.emit('close'); });

  connect(config: unknown): void {
    this.connectConfig = config;
    if (behavior.connect === 'ready') this.emit('ready');
    else this.emit('error', new Error(behavior.connect.error));
  }

  forwardIn(addr: string, port: number, cb?: (err?: Error, port?: number) => void): void {
    this.forwardInCalls.push([addr, port]);
    const f = behavior.forward;
    if (f === 'silent') return;
    if ('throws' in f) throw new Error(f.throws);
    if ('error' in f) { cb?.(new Error(f.error)); return; }
    cb?.(undefined, f.port);
  }

  unforwardIn(addr: string, port: number, cb?: () => void): void {
    this.unforwardInCalls.push([addr, port]);
    if (behavior.unforwardReplies) cb?.();
  }

  exec(_command: string, cb: (err: Error | null, stream: EventEmitter) => void): void {
    const stream = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      end: vi.fn(),
      close: vi.fn(),
    });
    cb(null, stream);
  }
}

let lastClient: MockClient | undefined;

vi.mock('ssh2', () => ({
  Client: vi.fn().mockImplementation(function mockClientCtor() {
    lastClient = new MockClient();
    return lastClient;
  }),
}));

function makeTestAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: `agent-${Math.random().toString(36).slice(2)}`,
    friendlyName: 'tunnel-test-agent',
    agentType: 'remote',
    host: `test-host-${Math.random().toString(36).slice(2)}`,
    port: 22,
    username: 'developer',
    workFolder: '/home/developer',
    llmProvider: 'claude',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Agent;
}

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // matches ssh.ts's private IDLE_TIMEOUT

describe('openReverseTunnel (rmkb-3n5.5.1)', () => {
  let sshModule: typeof import('../src/services/ssh.js');

  beforeEach(async () => {
    vi.resetModules();
    lastClient = undefined;
    createdSockets.length = 0;
    netConnectCalls.length = 0;
    behavior = { connect: 'ready', forward: { port: 17523 }, unforwardReplies: true };
    sshModule = await import('../src/services/ssh.js');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requests a loopback bind on port 0 and returns the port the sshd assigned', async () => {
    const tunnel = await sshModule.openReverseTunnel(makeTestAgent(), 18700);

    expect(lastClient!.forwardInCalls).toEqual([['127.0.0.1', 0]]);
    expect(tunnel.remotePort).toBe(17523);
    expect(tunnel.localPort).toBe(18700);

    await tunnel.close();
  });

  it('honours an explicit remotePort request (for the member .mcp.json default port)', async () => {
    behavior.forward = { port: 7523 };
    const tunnel = await sshModule.openReverseTunnel(makeTestAgent(), 18700, { remotePort: 7523 });

    expect(lastClient!.forwardInCalls).toEqual([['127.0.0.1', 7523]]);
    expect(tunnel.remotePort).toBe(7523);

    await tunnel.close();
  });

  it('pipes each accepted channel both ways to 127.0.0.1:<localPort> on the fleet server', async () => {
    const tunnel = await sshModule.openReverseTunnel(makeTestAgent(), 18700);

    const channel = new MockChannel();
    lastClient!.emit(
      'tcp connection',
      { srcIP: '127.0.0.1', srcPort: 55001, destIP: '127.0.0.1', destPort: 17523 },
      () => channel,
      () => { throw new Error('must not reject a connection on a live tunnel'); },
    );

    expect(netConnectCalls).toEqual([[18700, '127.0.0.1']]);
    const socket = createdSockets[0];
    socket.emit('connect');
    expect(channel.pipe).toHaveBeenCalledWith(socket);
    expect(socket.pipe).toHaveBeenCalledWith(channel);

    // close() must not leak the live pipe.
    await tunnel.close();
    expect(socket.destroy).toHaveBeenCalled();
    expect(channel.close).toHaveBeenCalled();
  });

  it('fails a single forwarded connection (not the tunnel) when the local MCP port refuses', async () => {
    const tunnel = await sshModule.openReverseTunnel(makeTestAgent(), 18700);

    const channel = new MockChannel();
    lastClient!.emit('tcp connection', {}, () => channel, () => {});
    const socket = createdSockets[0];
    socket.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:18700'));

    expect(socket.destroy).toHaveBeenCalled();
    expect(lastClient!.end).not.toHaveBeenCalled();

    // The tunnel itself is still usable: a second connection still gets piped.
    const channel2 = new MockChannel();
    lastClient!.emit('tcp connection', {}, () => channel2, () => {});
    expect(netConnectCalls).toHaveLength(2);

    await tunnel.close();
  });

  it('rejects an incoming channel once the tunnel has been closed', async () => {
    const tunnel = await sshModule.openReverseTunnel(makeTestAgent(), 18700);
    await tunnel.close();

    const rejectChannel = vi.fn();
    lastClient!.emit('tcp connection', {}, () => { throw new Error('must not accept after close'); }, rejectChannel);
    expect(rejectChannel).toHaveBeenCalledTimes(1);
    expect(netConnectCalls).toHaveLength(0);
  });

  it('close() unforwards the assigned port, ends the connection, and is idempotent', async () => {
    const tunnel = await sshModule.openReverseTunnel(makeTestAgent(), 18700);

    await tunnel.close();
    expect(lastClient!.unforwardInCalls).toEqual([['127.0.0.1', 17523]]);
    expect(lastClient!.end).toHaveBeenCalledTimes(1);

    await tunnel.close();
    await tunnel.close();
    expect(lastClient!.unforwardInCalls).toEqual([['127.0.0.1', 17523]]);
    expect(lastClient!.end).toHaveBeenCalledTimes(1);
  });

  it('close() resolves even when the sshd never answers the unforward request', async () => {
    vi.useFakeTimers();
    try {
      behavior.unforwardReplies = false;
      const tunnel = await sshModule.openReverseTunnel(makeTestAgent(), 18700);

      const closed = tunnel.close();
      await vi.advanceTimersByTimeAsync(5000);
      await closed;

      expect(lastClient!.end).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('close() after the SSH connection already dropped leaves no stale forward attempt and does not throw', async () => {
    const tunnel = await sshModule.openReverseTunnel(makeTestAgent(), 18700);

    // Connection drops underneath us (network loss / member reboot).
    lastClient!.emit('close');

    await expect(tunnel.close()).resolves.toBeUndefined();
    // Nothing to cancel: the remote bind died with the connection, and
    // unforwardIn would have thrown 'Not connected' on a real client.
    expect(lastClient!.unforwardInCalls).toEqual([]);
    // Still idempotent afterwards.
    await expect(tunnel.close()).resolves.toBeUndefined();
  });

  it('surfaces an sshd forwarding refusal as TcpForwardingRefusedError with actionable guidance', async () => {
    behavior.forward = { error: 'Unable to bind to 127.0.0.1:0' };

    await expect(sshModule.openReverseTunnel(makeTestAgent(), 18700)).rejects.toBeInstanceOf(
      sshModule.TcpForwardingRefusedError,
    );

    behavior.forward = { error: 'Unable to bind to 127.0.0.1:0' };
    const err = await sshModule.openReverseTunnel(makeTestAgent(), 18700).catch((e) => e);
    expect(err).not.toBeInstanceOf(sshModule.ReverseTunnelTransportError);
    expect(err.code).toBe('TCP_FORWARDING_REFUSED');
    expect(err.message).toContain('AllowTcpForwarding yes');
    // The dedicated connection is not leaked when the request is refused.
    expect(lastClient!.end).toHaveBeenCalled();
  });

  it('surfaces a transport failure as ReverseTunnelTransportError, distinct from a refusal', async () => {
    behavior.connect = { error: 'connect ECONNREFUSED 10.102.10.65:22' };

    const err = await sshModule.openReverseTunnel(makeTestAgent(), 18700).catch((e) => e);
    expect(err).toBeInstanceOf(sshModule.ReverseTunnelTransportError);
    expect(err).not.toBeInstanceOf(sshModule.TcpForwardingRefusedError);
    expect(err.code).toBe('REVERSE_TUNNEL_TRANSPORT');
    expect(err.message).toContain('Connection refused');
  });

  it('times out (as a transport failure) when the sshd never answers the forward request', async () => {
    vi.useFakeTimers();
    try {
      behavior.forward = 'silent';
      const pending = sshModule.openReverseTunnel(makeTestAgent(), 18700, { requestTimeoutMs: 2000 }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(2000);
      const err = await pending;
      expect(err).toBeInstanceOf(sshModule.ReverseTunnelTransportError);
      expect(err.message).toContain('timed out');
      expect(lastClient!.end).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to tunnel an agent with no SSH host/username (local members)', async () => {
    const local = makeTestAgent({ agentType: 'local', host: undefined, username: undefined });
    await expect(sshModule.openReverseTunnel(local, 18700)).rejects.toBeInstanceOf(
      sshModule.ReverseTunnelTransportError,
    );
    // No connection was even attempted.
    expect(lastClient).toBeUndefined();
  });

  it('uses a dedicated non-pooled connection: neither the idle reaper nor closeAllConnections can kill a live tunnel', async () => {
    vi.useFakeTimers();
    try {
      const agent = makeTestAgent();
      const tunnel = await sshModule.openReverseTunnel(agent, 18700);
      const tunnelClient = lastClient!;

      // The pool's idle timer is the documented trap (execStream's comment):
      // fire well past two full idle windows with nothing touching the tunnel.
      await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS * 2);
      expect(tunnelClient.end).not.toHaveBeenCalled();

      // The tunnel is not in the pool at all, so pool-wide teardown for the
      // very same agent must not reach it either.
      sshModule.closeConnection(agent);
      sshModule.closeAllConnections();
      expect(tunnelClient.end).not.toHaveBeenCalled();

      const closed = tunnel.close();
      await vi.advanceTimersByTimeAsync(0);
      await closed;
      expect(tunnelClient.end).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
