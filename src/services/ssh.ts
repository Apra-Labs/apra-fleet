import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import type { Agent, SSHExecResult } from '../types.js';
import { decryptPassword } from '../utils/crypto.js';
import { verifyHostKey, replaceKnownHost, HostKeyMismatchError } from './known-hosts.js';
import { setStoredPid, clearStoredPid, getAgentOS } from '../utils/agent-helpers.js';
import { getOsCommands } from '../os/index.js';
import { classifySshError } from '../utils/ssh-error-messages.js';

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB

interface PoolEntry {
  client: Client;
  lastUsed: number;
  timer: ReturnType<typeof setTimeout>;
  // apra-fleet-9zz.1: count of execCommand() calls currently in flight on
  // this connection (incremented before client.exec() is issued, decremented
  // when that call's promise settles -- see execCommand below). A provisional
  // stall-detector entry (stall-detector.ts) only refreshes the idle timer
  // incidentally via the poller's own tail probes, not via this activity
  // directly, so a long-running exec could otherwise sit through an idle-timer
  // fire with no other signal that the connection is still genuinely in use.
  activeChannels: number;
}

const pool = new Map<string, PoolEntry>();
const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

function poolKey(agent: Agent): string {
  return `${agent.username}@${agent.host}:${agent.port}`;
}

function cleanupEntry(key: string): void {
  const entry = pool.get(key);
  if (entry) {
    if (entry.activeChannels > 0) {
      // apra-fleet-9zz.1: a channel opened by execCommand (or an exec call
      // about to open one) is still live on this connection -- ending it here
      // would reap a genuinely active command out from under a caller that is
      // still waiting on its result. Re-arm the idle timer instead of
      // reaping; execCommand decrements activeChannels when the in-flight
      // call actually settles, so a later idle-timer fire with no active
      // channels left reaps normally.
      clearTimeout(entry.timer);
      const timer = setTimeout(() => cleanupEntry(key), IDLE_TIMEOUT);
      timer.unref();
      entry.timer = timer;
      return;
    }
    try { entry.client.end(); } catch {}
    clearTimeout(entry.timer);
    pool.delete(key);
  }
}

function resetIdleTimer(key: string): void {
  const entry = pool.get(key);
  if (entry) {
    clearTimeout(entry.timer);
    entry.lastUsed = Date.now();
    const timer = setTimeout(() => cleanupEntry(key), IDLE_TIMEOUT);
    timer.unref();
    entry.timer = timer;
  }
}

export function getSSHConfig(agent: Agent): ConnectConfig {
  const config: ConnectConfig = {
    host: agent.host,
    port: agent.port,
    username: agent.username,
    readyTimeout: 15000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
    hostVerifier: (key: Buffer) => {
      return verifyHostKey(agent.host!, agent.port!, key);
    },
  };

  if (agent.authType === 'key' && agent.keyPath) {
    config.privateKey = fs.readFileSync(agent.keyPath);
  } else if (agent.authType === 'password' && agent.encryptedPassword) {
    config.password = decryptPassword(agent.encryptedPassword);
  }

  return config;
}

function connectClient(config: ConnectConfig, key: string): Promise<Client> {
  return new Promise<Client>((resolve, reject) => {
    const client = new Client();

    client.on('ready', () => {
      const timer = setTimeout(() => cleanupEntry(key), IDLE_TIMEOUT);
      timer.unref();
      pool.set(key, { client, lastUsed: Date.now(), timer, activeChannels: 0 });

      client.on('close', () => {
        pool.delete(key);
      });
      client.on('error', () => {
        cleanupEntry(key);
      });

      resolve(client);
    });

    client.on('error', (err) => {
      reject(err);
    });

    client.connect(config);
  });
}

export async function getConnection(agent: Agent): Promise<Client> {
  const key = poolKey(agent);
  const entry = pool.get(key);

  if (entry) {
    resetIdleTimer(key);
    return entry.client;
  }

  return connectClient(getSSHConfig(agent), key);
}

/**
 * Connect with TOFU: on HostKeyMismatchError, auto-accept the new key and retry once.
 * Returns the client and an optional warning string if the key was updated.
 */
export async function connectWithTOFU(agent: Agent): Promise<{ client: Client; warning?: string }> {
  try {
    const client = await getConnection(agent);
    return { client };
  } catch (err) {
    if (err instanceof HostKeyMismatchError) {
      replaceKnownHost(err.host, err.port, err.newFingerprint);
      closeConnection(agent);
      const client = await getConnection(agent);
      return { client, warning: `Host key updated for ${err.host}:${err.port}` };
    }
    throw err;
  }
}

export async function execCommand(
  agent: Agent,
  command: string,
  timeoutMs: number = 30000,
  maxTotalMs?: number,
  onPidCaptured?: (pid: number) => void,
  abortSignal?: AbortSignal,
): Promise<SSHExecResult> {
  const { client, warning } = await connectWithTOFU(agent);
  const key = poolKey(agent);
  resetIdleTimer(key);

  // apra-fleet-9zz.1: mark this call as an active channel on the pool entry
  // BEFORE issuing client.exec() -- covers both the in-flight exec request
  // and the channel it opens -- so cleanupEntry's idle-timer reap can see it
  // and never end the connection out from under it (see cleanupEntry above).
  // connectWithTOFU/connectClient always populates the pool entry before
  // returning (pool.set() runs before the 'ready' promise resolves), so this
  // entry is guaranteed to exist here.
  const poolEntry = pool.get(key);
  if (poolEntry) poolEntry.activeChannels += 1;
  let channelReleased = false;
  function releaseChannel(): void {
    if (channelReleased) return;
    channelReleased = true;
    const entry = pool.get(key);
    if (entry) entry.activeChannels = Math.max(0, entry.activeChannels - 1);
  }

  // Remote PID captured from the FLEET_PID marker (see execute-command.ts's
  // wrapPidCapture), if the wrapped command emits one. A closed/rejected SSH
  // channel does NOT kill the remote process it started (unlike a local
  // child_process, an ssh2 exec channel closing has no effect on the far
  // side) -- apra-fleet-kwx fixed this for LocalStrategy via a local
  // child.pid tree-kill; killRemoteTree below is the same fix for the SSH
  // path, using the marker PID instead of a local handle.
  let capturedPid: number | undefined;
  function killRemoteTree() {
    if (capturedPid === undefined) return;
    try {
      const killCmd = getOsCommands(getAgentOS(agent)).killPid(capturedPid);
      // Best-effort, fire-and-forget on a FRESH channel -- the timed-out
      // command's own channel may itself be wedged and must not be relied
      // on to carry the kill.
      client.exec(killCmd, (err, killStream) => {
        if (err) return;
        killStream.on('data', () => {});
        killStream.stderr?.on('data', () => {});
      });
    } catch { /* best-effort; connection may already be gone */ }
  }

  return new Promise<SSHExecResult>((resolve, reject) => {
    let settled = false;
    function settle(fn: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(inactivityTimer);
      if (maxTotalTimer) clearTimeout(maxTotalTimer);
      releaseChannel();
      fn();
    }

    // Rolling inactivity timer — resets on each stdout/stderr data event
    let inactivityTimer: ReturnType<typeof setTimeout>;
    function resetInactivityTimer() {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        killRemoteTree();
        settle(() => reject(new Error(`Command timed out after ${timeoutMs}ms of inactivity`)));
      }, timeoutMs);
      inactivityTimer.unref();
    }
    resetInactivityTimer();

    // Hard ceiling — never reset regardless of activity
    let maxTotalTimer: ReturnType<typeof setTimeout> | undefined;
    if (maxTotalMs !== undefined) {
      maxTotalTimer = setTimeout(() => {
        killRemoteTree();
        settle(() => reject(new Error(`Command exceeded max total time of ${maxTotalMs}ms`)));
      }, maxTotalMs);
      maxTotalTimer.unref();
    }

    client.exec(command, (err, stream) => {
      if (err) {
        settle(() => reject(err));
        return;
      }

      // Close stdin so commands that read from it (e.g. claude -p) get EOF
      stream.end();

      let stdout = '';
      let stderr = '';
      let stdoutLen = 0;
      let stderrLen = 0;
      let stdoutSpillStream: fs.WriteStream | null = null;
      let stderrSpillStream: fs.WriteStream | null = null;
      let stdoutSpillPath: string | null = null;
      let stderrSpillPath: string | null = null;
      let pidExtracted = false;

      stream.on('data', (data: Buffer) => {
        resetInactivityTimer();
        let chunk = data.toString();
        if (!pidExtracted) {
          const m = /^FLEET_PID:(\d+)\r?$/m.exec(chunk);
          if (m) {
            const pid = parseInt(m[1], 10);
            capturedPid = pid;
            setStoredPid(agent.id, pid);
            onPidCaptured?.(pid);
            chunk = chunk.replace(/^FLEET_PID:\d+\r?(?:\n|$)/m, '');
            pidExtracted = true;
          }
        }
        stdoutLen += data.length;
        if (stdoutLen <= MAX_OUTPUT_BYTES) {
          stdout += chunk;
        } else {
          if (!stdoutSpillStream) {
            stdoutSpillPath = path.join(os.tmpdir(), `fleet-stdout-${uuid()}.txt`);
            stdoutSpillStream = fs.createWriteStream(stdoutSpillPath);
            stdoutSpillStream.write(stdout);
          }
          stdoutSpillStream.write(chunk);
        }
      });

      stream.stderr.on('data', (data: Buffer) => {
        resetInactivityTimer();
        stderrLen += data.length;
        if (stderrLen <= MAX_OUTPUT_BYTES) {
          stderr += data.toString();
        } else {
          if (!stderrSpillStream) {
            stderrSpillPath = path.join(os.tmpdir(), `fleet-stderr-${uuid()}.txt`);
            stderrSpillStream = fs.createWriteStream(stderrSpillPath);
            stderrSpillStream.write(stderr);
          }
          stderrSpillStream.write(data);
        }
      });

      stream.on('close', (code: number) => {
        clearStoredPid(agent.id);
        if (stdoutSpillStream) stdoutSpillStream.end();
        if (stderrSpillStream) stderrSpillStream.end();
        if (stdoutSpillPath) {
          stdout = `[OUTPUT TRUNCATED -- full stdout saved to ${stdoutSpillPath}]\n${stdout}`;
        }
        if (stderrSpillPath) {
          stderr = `[OUTPUT TRUNCATED -- full stderr saved to ${stderrSpillPath}]\n${stderr}`;
        }
        if (warning) {
          stderr = `Warning: ${warning}\n${stderr}`;
        }
        settle(() => resolve({ stdout, stderr, code: code ?? 0 }));
      });
      stream.on('error', (err: Error) => {
        clearStoredPid(agent.id);
        if (stdoutSpillStream) stdoutSpillStream.end();
        if (stderrSpillStream) stderrSpillStream.end();
        settle(() => reject(err));
      });

      if (abortSignal) {
        const onAbort = () => {
          killRemoteTree();
          try { stream.close(); } catch { /* best-effort */ }
          settle(() => reject(new Error('Command aborted by client')));
        };
        if (abortSignal.aborted) onAbort();
        else abortSignal.addEventListener('abort', onAbort, { once: true });
      }
    });
  });
}

export interface SSHStream {
  /** Close the streaming channel and its dedicated connection. */
  close: () => void;
}

/**
 * Open a dedicated (non-pooled) SSH channel for a long-lived streaming command
 * such as `tail -F`. stdout chunks are delivered to onData as they arrive; the
 * channel stays open until close() is called or the remote command exits
 * (onEnd). It uses its own connection so a long-lived tail is never blocked by,
 * or torn down by the idle timer of, the request/response pool. Fails soft: the
 * returned promise rejects on connect/exec error so callers can retry later.
 */
export async function execStream(
  agent: Agent,
  command: string,
  onData: (chunk: string) => void,
  onEnd?: () => void,
): Promise<SSHStream> {
  const config = getSSHConfig(agent);
  const client = await new Promise<Client>((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => resolve(c));
    c.on('error', reject);
    c.connect(config);
  });

  return new Promise<SSHStream>((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) { try { client.end(); } catch {} reject(err); return; }
      let ended = false;
      const done = () => { if (ended) return; ended = true; onEnd?.(); try { client.end(); } catch {} };
      stream.on('data', (d: Buffer) => onData(d.toString()));
      stream.stderr.on('data', () => { /* ignore tail's stderr */ });
      stream.on('close', done);
      stream.on('error', done);
      resolve({ close: () => { try { stream.close(); } catch {} try { client.end(); } catch {} } });
    });
  });
}

// ---------------------------------------------------------------------------
// Reverse tunnel (apra-fleet rmkb-3n5.5.1)
// ---------------------------------------------------------------------------

/**
 * Loopback address used on BOTH ends of a reverse tunnel:
 *  - the bind address requested of the member's sshd, so the forwarded port
 *    only ever appears on the MEMBER'S OWN loopback and never on a routable
 *    interface (proven on hardware: `LISTEN 127.0.0.1:<port>` only), and
 *  - the address each accepted channel is piped to on the fleet server, so we
 *    reach the existing loopback-bound MCP server (src/paths.ts DEFAULT_HOST)
 *    without opening any new listener of our own.
 */
const TUNNEL_LOOPBACK = '127.0.0.1';

/** Default ceiling on the sshd's reply to the tcpip-forward request. */
const FORWARD_REQUEST_TIMEOUT_MS = 15000;

/** Default ceiling on the sshd's reply to the cancel-tcpip-forward request. */
const UNFORWARD_TIMEOUT_MS = 5000;

/**
 * The member's sshd answered the remote-forward request with a failure --
 * i.e. it is reachable and authenticated us, but refuses to forward
 * (`AllowTcpForwarding no` / `PermitListen` restrictions). Callers degrade
 * differently for this than for a transport failure: the member is fine, the
 * tunnel feature simply is not available on it.
 */
export class TcpForwardingRefusedError extends Error {
  readonly code = 'TCP_FORWARDING_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'TcpForwardingRefusedError';
  }
}

/**
 * The SSH transport itself failed (connect refused, auth rejected, host
 * unreachable, connection dropped or timed out mid-request). Distinct from
 * TcpForwardingRefusedError: nothing was learned about the member's
 * forwarding policy, so this is worth retrying.
 */
export class ReverseTunnelTransportError extends Error {
  readonly code = 'REVERSE_TUNNEL_TRANSPORT';
  constructor(message: string) {
    super(message);
    this.name = 'ReverseTunnelTransportError';
  }
}

export interface ReverseTunnel {
  /**
   * Port the member's sshd bound on ITS OWN loopback. Assigned by the sshd
   * when remotePort 0 (the default) is requested.
   */
  remotePort: number;
  /** Fleet-server loopback port every accepted channel is piped to. */
  localPort: number;
  /**
   * Idempotent teardown: unforwards the remote bind, destroys any live piped
   * channels, and ends the dedicated connection. Safe to call twice and safe
   * to call after the SSH connection has already dropped.
   */
  close: () => Promise<void>;
}

export interface ReverseTunnelOptions {
  /**
   * Member-side port to ask for. 0 (default) lets the member's sshd pick a
   * free one and report it back; pass a specific port when the caller needs a
   * fixed one (e.g. 7523, which the member's committed .mcp.json already
   * points at) and is prepared to fall back to 0 when it is taken.
   */
  remotePort?: number;
  /** Ceiling on the sshd's reply to the forward request. */
  requestTimeoutMs?: number;
}

function tunnelLabel(agent: Agent): string {
  return `${agent.username ?? '<no-user>'}@${agent.host ?? '<no-host>'}:${agent.port ?? 22}`;
}

/**
 * Open an SSH reverse (remote) port forward on a member: the member's sshd
 * listens on its own loopback and every connection it accepts there is piped
 * back to 127.0.0.1:<localPort> on the fleet server. This is what gives a
 * remote member a reachable MCP endpoint without exposing the fleet server on
 * any routable interface (rmkb-3n5.5).
 *
 * The tunnel gets a DEDICATED, NON-POOLED connection, modelled on execStream
 * above: the pool's idle timer (cleanupEntry/IDLE_TIMEOUT) must never be able
 * to reap a live tunnel out from under an in-flight dispatch.
 *
 * Rejects with TcpForwardingRefusedError when the member's sshd refuses the
 * forward request, and with ReverseTunnelTransportError for connect/auth/
 * transport failures -- callers degrade differently for the two.
 */
export async function openReverseTunnel(
  agent: Agent,
  localPort: number,
  options: ReverseTunnelOptions = {},
): Promise<ReverseTunnel> {
  const label = tunnelLabel(agent);
  const requestedPort = options.remotePort ?? 0;
  const requestTimeoutMs = options.requestTimeoutMs ?? FORWARD_REQUEST_TIMEOUT_MS;

  if (!agent.host || !agent.username) {
    throw new ReverseTunnelTransportError(
      `Cannot open a reverse tunnel to ${agent.friendlyName}: it has no SSH host/username (local members are not tunnelled).`,
    );
  }

  const config = getSSHConfig(agent);
  const client = new Client();
  let connectionAlive = false;
  let forwardActive = false;
  let assignedPort = requestedPort;
  // Every channel/socket pair currently piping, so close() can tear them down
  // instead of leaking them (and so a dropped connection cannot leave sockets
  // half-open against the local MCP server).
  const livePipes = new Set<{ channel: ClientChannel; socket: net.Socket }>();

  // An ssh2 Client with no 'error' listener throws on the next transport
  // error, which for a long-lived tunnel would take the whole server down.
  // This permanent handler absorbs post-setup errors; the setup phases below
  // add their own temporary listeners on top to reject their promises.
  client.on('error', () => { /* absorbed; see per-phase listeners below */ });
  client.on('close', () => {
    connectionAlive = false;
    // The remote bind died with the connection -- there is nothing left to
    // cancel, so close() must not try to (and must not report a failure).
    forwardActive = false;
  });

  // --- phase 1: dedicated connection -------------------------------------
  await new Promise<void>((resolve, reject) => {
    const onReady = () => { detach(); connectionAlive = true; resolve(); };
    const onError = (err: Error) => {
      detach();
      try { client.end(); } catch { /* best-effort */ }
      reject(new ReverseTunnelTransportError(
        `Failed to open reverse tunnel to ${label}: ${classifySshError(err?.message ?? String(err))}`,
      ));
    };
    const onClose = () => {
      detach();
      reject(new ReverseTunnelTransportError(
        `Failed to open reverse tunnel to ${label}: connection closed before it was ready`,
      ));
    };
    function detach(): void {
      client.removeListener('ready', onReady);
      client.removeListener('error', onError);
      client.removeListener('close', onClose);
    }
    client.on('ready', onReady);
    client.on('error', onError);
    client.on('close', onClose);
    try {
      client.connect(config);
    } catch (err: any) {
      onError(err);
    }
  });

  // --- phase 2: pipe accepted channels back to the local MCP port ---------
  // Registered BEFORE forwardIn so a connection that arrives the instant the
  // bind lands is never dropped on the floor.
  client.on('tcp connection', (_details, accept, rejectChannel) => {
    if (!forwardActive) {
      try { rejectChannel(); } catch { /* best-effort */ }
      return;
    }
    let channel: ClientChannel;
    try {
      channel = accept();
    } catch {
      return; // connection went away between the event and accept()
    }
    const socket = net.connect(localPort, TUNNEL_LOOPBACK);
    const pipe = { channel, socket };
    livePipes.add(pipe);
    let torn = false;
    const teardown = () => {
      if (torn) return;
      torn = true;
      livePipes.delete(pipe);
      try { socket.destroy(); } catch { /* best-effort */ }
      try { channel.close(); } catch { /* best-effort */ }
    };
    socket.on('connect', () => {
      channel.pipe(socket);
      socket.pipe(channel);
    });
    // A local MCP server that is not listening yet (ECONNREFUSED) must fail
    // just this one forwarded connection, never the process or the tunnel.
    socket.on('error', teardown);
    socket.on('close', teardown);
    channel.on('error', teardown);
    channel.on('close', teardown);
  });

  // --- phase 3: ask the member's sshd to bind ------------------------------
  assignedPort = await new Promise<number>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(() => reject(new ReverseTunnelTransportError(
        `Failed to open reverse tunnel to ${label}: timed out after ${requestTimeoutMs}ms waiting for the member's sshd to bind ${TUNNEL_LOOPBACK}:${requestedPort}`,
      )));
    }, requestTimeoutMs);
    timer.unref();
    const onError = (err: Error) => finish(() => reject(new ReverseTunnelTransportError(
      `Failed to open reverse tunnel to ${label}: ${classifySshError(err?.message ?? String(err))}`,
    )));
    const onClose = () => finish(() => reject(new ReverseTunnelTransportError(
      `Failed to open reverse tunnel to ${label}: connection closed while requesting the remote forward`,
    )));
    function finish(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.removeListener('error', onError);
      client.removeListener('close', onClose);
      fn();
    }
    client.on('error', onError);
    client.on('close', onClose);
    try {
      client.forwardIn(TUNNEL_LOOPBACK, requestedPort, (err, port) => {
        if (err) {
          // The sshd replied REQUEST_FAILURE: it is up and authenticated us,
          // it just will not forward. This is the AllowTcpForwarding-no case.
          finish(() => reject(new TcpForwardingRefusedError(
            `${label} refused the SSH remote port-forward request (${err.message}). ` +
            `Its sshd most likely has 'AllowTcpForwarding no' (or a PermitListen restriction); ` +
            `set 'AllowTcpForwarding yes' in its sshd_config and restart sshd to enable tunnelled MCP access.`,
          )));
          return;
        }
        finish(() => resolve(port));
      });
    } catch (err: any) {
      // forwardIn throws synchronously ('Not connected') when the socket is
      // already gone -- a transport failure, not a policy refusal.
      finish(() => reject(new ReverseTunnelTransportError(
        `Failed to open reverse tunnel to ${label}: ${classifySshError(err?.message ?? String(err))}`,
      )));
    }
  }).catch((err) => {
    try { client.end(); } catch { /* best-effort */ }
    throw err;
  });

  forwardActive = true;

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    // Idempotent: every later call awaits the same teardown.
    if (closePromise) return closePromise;
    closePromise = (async () => {
      const shouldUnforward = forwardActive && connectionAlive;
      forwardActive = false;
      for (const pipe of [...livePipes]) {
        livePipes.delete(pipe);
        try { pipe.socket.destroy(); } catch { /* best-effort */ }
        try { pipe.channel.close(); } catch { /* best-effort */ }
      }
      if (shouldUnforward) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, UNFORWARD_TIMEOUT_MS);
          timer.unref();
          try {
            client.unforwardIn(TUNNEL_LOOPBACK, assignedPort, () => {
              clearTimeout(timer);
              resolve();
            });
          } catch {
            // 'Not connected' -- the connection dropped underneath us, so the
            // remote bind is already gone with it. Nothing stale is left.
            clearTimeout(timer);
            resolve();
          }
        });
      }
      try { client.end(); } catch { /* best-effort */ }
      connectionAlive = false;
    })();
    return closePromise;
  };

  return { remotePort: assignedPort, localPort, close };
}

export async function testConnection(agent: Agent): Promise<{ ok: boolean; latencyMs: number; error?: string; warning?: string }> {
  const start = Date.now();
  try {
    const { warning } = await connectWithTOFU(agent);
    const latencyMs = Date.now() - start;
    return { ok: true, latencyMs, warning };
  } catch (err: any) {
    return { ok: false, latencyMs: Date.now() - start, error: err.message };
  }
}

export function closeConnection(agent: Agent): void {
  cleanupEntry(poolKey(agent));
}

export function closeAllConnections(): void {
  for (const key of pool.keys()) {
    cleanupEntry(key);
  }
}

/**
 * Test SSH auth with a dedicated non-pooled connection.
 * Used by setup_ssh_key to verify key auth works without
 * touching the connection pool (avoids TOCTOU races with
 * other agents sharing the same host).
 */
export async function testAuthConnection(agent: Agent, command: string, timeoutMs = 10000): Promise<SSHExecResult> {
  const config = getSSHConfig(agent);
  const client = await new Promise<Client>((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => resolve(c));
    c.on('error', (err) => reject(err));
    c.connect(config);
  });

  try {
    return await new Promise<SSHExecResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      client.exec(command, (err, stream) => {
        if (err) { clearTimeout(timer); reject(err); return; }
        stream.end();
        let stdout = '';
        let stderr = '';
        stream.on('data', (data: Buffer) => { stdout += data.toString(); });
        stream.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
        stream.on('close', (code: number) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, code: code ?? 0 });
        });
        stream.on('error', (err: Error) => { clearTimeout(timer); reject(err); });
      });
    });
  } finally {
    try { client.end(); } catch {}
  }
}
