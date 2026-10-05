import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import type { Agent, SSHExecResult } from '../types.js';
import { decryptPassword } from '../utils/crypto.js';
import { verifyHostKey, replaceKnownHost, HostKeyMismatchError } from './known-hosts.js';
import { setStoredPid, clearStoredPid, getAgentOS, getAgentShell } from '../utils/agent-helpers.js';
import { getOsCommands } from '../os/index.js';
import { completesOnProcessExit, exitDrainMs } from './exit-drain.js';

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
  // Set when a channel open on this connection was refused (sshd session
  // limit). A retired entry is out of the pool -- new work gets a fresh
  // connection -- and its client is ended once its last in-flight channel
  // releases (see retireEntry/openPooledChannel below).
  retired?: boolean;
}

const pool = new Map<string, PoolEntry>();
// In-flight connects per pool key, so concurrent callers share one new
// connection instead of each opening one (only the last would be pooled; the
// others would be orphaned and never idle-reaped).
const connecting = new Map<string, Promise<Client>>();
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

      // Guarded by identity: once this client has been retired and replaced,
      // its late close/error must not drop or reap the replacement entry.
      client.on('close', () => {
        if (pool.get(key)?.client === client) pool.delete(key);
      });
      client.on('error', () => {
        if (pool.get(key)?.client === client) cleanupEntry(key);
      });

      resolve(client);
    });

    client.on('error', (err) => {
      reject(err);
    });

    // ssh2 emits 'error' only when no SSH banner was seen; a socket that
    // closes after the banner but before 'ready' (no DISCONNECT) would
    // otherwise leave this promise -- shared by every concurrent caller for
    // the member via `connecting` -- pending forever. A no-op once resolved.
    client.once('close', () => {
      reject(new Error(`SSH connection to ${key} closed before it became ready`));
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

  const inFlight = connecting.get(key);
  if (inFlight) return inFlight;
  const p = connectClient(getSSHConfig(agent), key);
  connecting.set(key, p);
  const clear = () => { if (connecting.get(key) === p) connecting.delete(key); };
  p.then(clear, clear);
  return p;
}

/** True for ssh2's "(SSH) Channel open failure: ..." -- sshd refused a new channel. */
export function isChannelOpenFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /Channel open failure/i.test(msg);
}

/**
 * Transport error for a refused channel open, naming the member and the
 * likely cause. ssh2's raw text ("open failed") says nothing actionable.
 */
export function channelOpenFailureError(agent: Agent, err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const e = new Error(
    `SSH transport error on member "${agent.friendlyName}" (${agent.username}@${agent.host}:${agent.port}): ` +
    `the member's sshd refused to open a new session channel (${raw}), also on a fresh connection. ` +
    `Likely cause: its per-connection session limit (sshd MaxSessions, default 10) is exhausted by ` +
    `concurrent or leaked SSH sessions (e.g. stale sftp-server processes). Close the stale sessions on ` +
    `the member (or restart its sshd) or raise MaxSessions, then retry.`,
  );
  (e as Error & { cause?: unknown }).cause = err;
  return e;
}

/**
 * Take a pool entry out of service after a refused channel open: new work
 * gets a fresh connection, while channels still running on this one finish
 * undisturbed. Its client is ended now if idle, else on its last release.
 */
function retireEntry(key: string, entry: PoolEntry | undefined): void {
  if (!entry) return;
  entry.retired = true;
  clearTimeout(entry.timer);
  if (pool.get(key) === entry) pool.delete(key);
  if (entry.activeChannels === 0) { try { entry.client.end(); } catch {} }
}

export interface ChannelLease<T> {
  channel: T;
  client: Client;
  warning?: string;
  /** Idempotent: drops this channel from its connection's active count. */
  release: () => void;
}

async function leaseConnection(agent: Agent) {
  const { client, warning } = await connectWithTOFU(agent);
  const key = poolKey(agent);
  resetIdleTimer(key);
  // Bind the lease to THIS connection's entry (not a later pool lookup by
  // key), so a release after a reconnect never decrements the replacement.
  const found = pool.get(key);
  const entry = found && found.client === client ? found : undefined;
  if (entry) entry.activeChannels += 1;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    if (!entry) return;
    entry.activeChannels = Math.max(0, entry.activeChannels - 1);
    if (entry.retired && entry.activeChannels === 0) { try { entry.client.end(); } catch {} }
  };
  return { client, warning, release, key, entry };
}

/**
 * Open one channel (exec or sftp) on the member's pooled connection, counted
 * in the entry's activeChannels until release(). The caller owns the channel
 * and MUST close it and call release() on every path (success, error,
 * timeout, abort) -- an unclosed channel holds one of the member sshd's
 * per-connection sessions (MaxSessions) forever.
 *
 * A "Channel open failure" means nothing started on the far side, so it is
 * safe to retry: the connection is retired and the open is retried ONCE on a
 * fresh connection (MaxSessions is per connection). A second refusal
 * surfaces as channelOpenFailureError.
 */
export async function openPooledChannel<T>(
  agent: Agent,
  open: (client: Client) => Promise<T>,
): Promise<ChannelLease<T>> {
  const first = await leaseConnection(agent);
  try {
    const channel = await open(first.client);
    return { channel, client: first.client, warning: first.warning, release: first.release };
  } catch (err) {
    first.release();
    if (!isChannelOpenFailure(err)) throw err;
    retireEntry(first.key, first.entry);
  }
  const second = await leaseConnection(agent);
  try {
    const channel = await open(second.client);
    return { channel, client: second.client, warning: first.warning ?? second.warning, release: second.release };
  } catch (err) {
    second.release();
    if (isChannelOpenFailure(err)) throw channelOpenFailureError(agent, err);
    throw err;
  }
}

function openExec(client: Client, command: string): Promise<ClientChannel> {
  return new Promise<ClientChannel>((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) reject(err);
      else resolve(stream);
    });
  });
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
  // Connect (and TOFU-heal a changed host key) before the command timers
  // start -- connection setup has its own readyTimeout.
  const { warning } = await connectWithTOFU(agent);

  // apra-fleet-9zz.1: the channel is counted as active on its pool entry from
  // BEFORE the exec request until settle (openPooledChannel/releaseChannel),
  // so cleanupEntry's idle-timer reap never ends the connection out from
  // under it. The channel itself is closed on every non-'close' settle path
  // (timeout, abort, error, late open) -- a channel left open holds one of
  // the member sshd's per-connection sessions (MaxSessions) forever.
  let client: Client | undefined;
  let activeStream: ClientChannel | undefined;
  let releaseChannel: () => void = () => {};
  function closeStream(): void {
    if (activeStream) { try { activeStream.close(); } catch { /* best-effort */ } }
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
    if (capturedPid === undefined || !client) return;
    let killCmd: string;
    try {
      killCmd = getOsCommands(getAgentOS(agent), getAgentShell(agent)).killPid(capturedPid);
    } catch { return; /* best-effort */ }
    // Best-effort, fire-and-forget on a FRESH channel -- the timed-out
    // command's own channel may itself be wedged and must not be relied on
    // to carry the kill. Opened through openPooledChannel so it is LEASED:
    // the timed-out command's release can no longer end a retired connection
    // before the kill is sent (a PID kill works over any connection to the
    // member), and a refused open retries once on a fresh connection.
    // stdin EOF + a safety close so this channel can never outlive the kill.
    openPooledChannel(agent, (c) => openExec(c, killCmd)).then(({ channel: killStream, release }) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        release();
      };
      const killTimer = setTimeout(() => {
        try { killStream.close(); } catch { /* best-effort */ }
        finish();
      }, 30000);
      killTimer.unref();
      try { killStream.end(); } catch { /* best-effort */ }
      killStream.on('data', () => {});
      killStream.stderr?.on('data', () => {});
      killStream.on('close', finish);
      killStream.on('error', () => {
        try { killStream.close(); } catch { /* best-effort */ }
        finish();
      });
    }).catch(() => { /* best-effort; the member may be unreachable */ });
  }

  return new Promise<SSHExecResult>((resolve, reject) => {
    let settled = false;
    let exitDrainTimer: ReturnType<typeof setTimeout> | undefined;
    function settle(fn: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(inactivityTimer);
      if (maxTotalTimer) clearTimeout(maxTotalTimer);
      if (exitDrainTimer) clearTimeout(exitDrainTimer);
      releaseChannel();
      fn();
    }

    // Rolling inactivity timer — resets on each stdout/stderr data event
    let inactivityTimer: ReturnType<typeof setTimeout>;
    function resetInactivityTimer() {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        killRemoteTree();
        closeStream();
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
        closeStream();
        settle(() => reject(new Error(`Command exceeded max total time of ${maxTotalMs}ms`)));
      }, maxTotalMs);
      maxTotalTimer.unref();
    }

    openPooledChannel(agent, (c) => openExec(c, command)).then((lease) => {
      const stream = lease.channel;
      if (settled) {
        // A timer settled this call before the channel opened: nobody will
        // ever read it, so close it now instead of leaking the session.
        try { stream.close(); } catch { /* best-effort */ }
        lease.release();
        return;
      }
      client = lease.client;
      activeStream = stream;
      releaseChannel = lease.release;

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

      const finalize = (code: number | null) => {
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
      };

      stream.on('close', (code: number) => finalize(code));

      // apra-fleet-qe83.1.2 (READ SIDE of the fix; rationale in
      // src/services/exit-drain.ts). The SSH twin of the LocalStrategy change in
      // strategy.ts: sshd sends `exit-status` when the command process itself
      // exits, but only closes the channel once every inherited handle on the
      // far side is released -- so one surviving grandchild (sandbox server,
      // orphaned find.exe) holds the channel open indefinitely. On Windows
      // members, treat the remote process exit as completion, drain briefly, then
      // settle; the remote grandchild is left running on purpose.
      if (completesOnProcessExit(getAgentOS(agent))) {
        stream.on('exit', (code: number | null) => {
          if (settled || exitDrainTimer) return;
          exitDrainTimer = setTimeout(() => {
            if (settled) return;
            // Invariant: settle the result before releasing the read ends.
            finalize(code);
            // Release our end of the wedged channel; the remote grandchild is
            // unaffected (closing an ssh2 channel never signals the far side's
            // processes -- see killRemoteTree above for why that is deliberate).
            try { stream.close(); } catch { /* best-effort */ }
          }, exitDrainMs());
          // apra-fleet-qe83.6 (VERIFIED: this unref-ed timer can NOT be the
          // last live handle, so unref-ing it cannot strand the promise).
          // The handle that always outlives the drain window here is the ssh2
          // Client's TCP socket: the channel is still open (that is why the
          // drain is running at all), so its connection socket is live, and
          // ssh2 never unrefs it -- `unref` appears nowhere in
          // node_modules/ssh2/lib/client.js (only in http-agents.js and
          // server.js). Measured standalone that this is sufficient: a
          // connected, reading net.Socket with the helper listener process
          // unref-ed gave getActiveResourcesInfo() = [TCPSocketWrap] and an
          // unref-ed 3000 ms timer still fired at 3014 ms -- i.e. the socket
          // alone kept the loop alive with no ref-ed timer present. If the
          // channel had already closed instead, `close` would have settled the
          // promise without this timer. The connection-pool idle timers
          // (resetIdleTimer above) are all unref-ed and are deliberately NOT
          // part of this argument. Caller paths enumerated as for the
          // strategy.ts twin: every execCommand() call site runs inside the
          // long-lived MCP server, except src/cli/watch.ts, which holds a
          // ref-ed setInterval for its watch loop.
          // Residual risk: if the TCP socket dies during the drain window the
          // callback is skipped -- but that path emits 'error', which settles
          // via reject(), so the promise still settles. The narrow uncovered
          // case is a socket destroyed with no 'error' and no 'close'.
          exitDrainTimer.unref();
        });
      }

      stream.on('error', (err: Error) => {
        clearStoredPid(agent.id);
        if (stdoutSpillStream) stdoutSpillStream.end();
        if (stderrSpillStream) stderrSpillStream.end();
        try { stream.close(); } catch { /* best-effort */ }
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
    }, (err: unknown) => {
      settle(() => reject(err));
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
