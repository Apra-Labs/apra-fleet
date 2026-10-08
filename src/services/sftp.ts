import path from 'node:path';
import fs from 'node:fs';
import type { Client, SFTPWrapper } from 'ssh2';
import type { Agent } from '../types.js';
import { openPooledChannel } from './ssh.js';
import { resolveRemotePath } from '../utils/platform.js';

/**
 * Inactivity budget for one SFTP operation (session open, mkdir, writeFile,
 * fastPut, fastGet). INACTIVITY-based, not a wall-clock ceiling: fastPut and
 * fastGet report every chunk through their `step` callback and each report
 * re-arms the timer, so a large transfer that keeps making progress is never
 * cut; one that stops moving for this long is. On expiry the SFTP session is
 * ended (its channel closed, its pooled-connection lease released) and the
 * transfer rejects with SftpTimeoutError naming the member, path and budget.
 * Without it a transfer the far side never answers pins its channel -- one
 * of the member sshd's MaxSessions -- for as long as the connection lives.
 */
export const SFTP_INACTIVITY_TIMEOUT_MS = 120_000;

export class SftpTimeoutError extends Error {
  constructor(agent: Agent, op: string, target: string, timeoutMs: number) {
    super(
      `SFTP ${op} on member "${agent.friendlyName}" (${agent.username}@${agent.host}:${agent.port}) ` +
      `made no progress for ${timeoutMs}ms on ${target}; the SFTP session was closed. ` +
      `The member may be unreachable or its sftp-server hung -- retry, or check the member.`,
    );
    this.name = 'SftpTimeoutError';
  }
}

/**
 * Close any SFTP channel ssh2 left open after its "sftp" subsystem request
 * was refused. ssh2 (1.17) opens the session channel, then on a refused
 * subsystem request calls back with only an error -- the channel stays open
 * on both ends and holds one of the member sshd's MaxSessions. ssh2's own
 * exec() closes its channel on the equivalent failure; sftp() does not, and
 * it never hands us the channel, so we find it in the client's channel table.
 *
 * Only an SFTP channel in exactly that state is closed: subsystem request
 * already answered (no pending request callbacks) and the SFTP handshake
 * never started (_init not yet replaced on the instance). A concurrent
 * sftp() still waiting on its subsystem reply has a pending callback, and
 * one past the subsystem stage has had _init replaced, so neither matches.
 * Best-effort: the internals are read defensively and any surprise is ignored.
 */
function closeRefusedSftpChannels(client: Client): void {
  try {
    const channels = (client as unknown as { _chanMgr?: { _channels?: Record<string, unknown> } })
      ._chanMgr?._channels;
    if (!channels) return;
    for (const ch of Object.values(channels) as any[]) {
      if (!ch || typeof ch !== 'object' || ch.constructor?.name !== 'SFTP') continue;
      if (ch.outgoing?.state !== 'open') continue;
      if (!Array.isArray(ch._callbacks) || ch._callbacks.length !== 0) continue;
      if (Object.prototype.hasOwnProperty.call(ch, '_init')) continue;
      try { ch.end(); } catch { /* best-effort */ }
    }
  } catch { /* best-effort */ }
}

/** Open an SFTP session on `client`; a refused subsystem request closes its channel. */
export function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        closeRefusedSftpChannels(client);
        reject(err);
      } else resolve(sftp);
    });
  });
}

/** One SFTP session plus the inactivity guard every operation on it runs under. */
interface SftpSession {
  sftp: SFTPWrapper;
  /**
   * Run one operation under the inactivity timeout. `start` receives a
   * `progress` callback that re-arms the timer (wire it to fastPut/fastGet's
   * `step`). Rejects immediately once the session has timed out or closed.
   */
  guard<T>(op: string, target: string, start: (progress: () => void) => Promise<T>): Promise<T>;
}

/**
 * Run one transfer on its own SFTP session and ALWAYS end it afterwards --
 * on success, error, abort and timeout. Each session is a channel (one
 * sftp-server process) on the member's pooled SSH connection; one left open
 * per transfer exhausts sshd's per-connection MaxSessions (default 10), after
 * which every command on that member fails with "Channel open failure". An
 * abort ends the session immediately, which fails any in-flight operation.
 * Every operation, including opening the session, runs under
 * SFTP_INACTIVITY_TIMEOUT_MS (see there); a timeout ends the session and the
 * whole transfer rejects with SftpTimeoutError -- it is never folded into a
 * per-file failure, because the session it would continue on is gone.
 */
async function withSftpSession<T>(
  agent: Agent,
  abortSignal: AbortSignal | undefined,
  fn: (session: SftpSession) => Promise<T>,
  timeoutMs: number = SFTP_INACTIVITY_TIMEOUT_MS,
): Promise<T> {
  if (abortSignal?.aborted) throw new Error('Aborted by client');
  const remoteRoot = agent.workFolder || '(home)';
  const { channel: sftp, release } = await openPooledChannel(agent, (client) =>
    new Promise<SFTPWrapper>((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        reject(new SftpTimeoutError(agent, 'session open', remoteRoot, timeoutMs));
      }, timeoutMs);
      timer.unref();
      openSftp(client).then((s) => {
        clearTimeout(timer);
        // Opened after we gave up: nobody will use it -- close it, do not leak it.
        if (timedOut) { try { s.end(); } catch { /* best-effort */ } return; }
        resolve(s);
      }, (err) => { clearTimeout(timer); reject(err); });
    }));

  let closed = false;
  let failure: Error | undefined;
  let failSession: (err: Error) => void = () => {};
  const failed = new Promise<never>((_, reject) => { failSession = reject; });
  failed.catch(() => {});
  const close = (): void => {
    if (closed) return;
    closed = true;
    try { sftp.end(); } catch { /* best-effort */ }
    release();
  };
  const fail = (err: Error): void => {
    if (failure) return;
    failure = err;
    close();
    failSession(err);
  };
  const onAbort = (): void => fail(new Error('Aborted by client'));
  abortSignal?.addEventListener('abort', onAbort, { once: true });

  const session: SftpSession = {
    sftp,
    guard<R>(op: string, target: string, start: (progress: () => void) => Promise<R>): Promise<R> {
      if (failure) return Promise.reject(failure);
      if (closed) return Promise.reject(new Error('SFTP session already closed'));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = (): void => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fail(new SftpTimeoutError(agent, op, target, timeoutMs)), timeoutMs);
        timer.unref();
      };
      arm();
      return Promise.race([start(arm), failed]).finally(() => { if (timer) clearTimeout(timer); });
    },
  };

  try {
    if (abortSignal?.aborted) throw new Error('Aborted by client');
    const result = await Promise.race([fn(session), failed]);
    if (failure) throw failure;
    return result;
  } finally {
    abortSignal?.removeEventListener('abort', onAbort);
    close();
  }
}

function sftpMkdir(s: SftpSession, remotePath: string): Promise<void> {
  return s.guard('mkdir', remotePath, () => new Promise((resolve, reject) => {
    s.sftp.mkdir(remotePath, (err) => {
      if (err && (err as any).code !== 4) reject(err); // code 4 = already exists
      else resolve();
    });
  }));
}

/** True when the error ended the whole session (timeout/abort) rather than one operation. */
function isSessionFatal(err: unknown): boolean {
  return err instanceof SftpTimeoutError || (err instanceof Error && err.message === 'Aborted by client');
}

async function sftpMkdirRecursive(s: SftpSession, remotePath: string): Promise<void> {
  const parts = remotePath.replace(/\\/g, '/').split('/').filter(Boolean);
  let current = remotePath.startsWith('/') ? '/' : '';

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    try {
      await sftpMkdir(s, current);
    } catch (err) {
      if (isSessionFatal(err)) throw err;
      // directory may already exist
    }
  }
}

function sftpWriteFile(s: SftpSession, remotePath: string, data: Buffer): Promise<void> {
  return s.guard('write', remotePath, () => new Promise((resolve, reject) => {
    s.sftp.writeFile(remotePath, data, (err) => {
      if (err) reject(err);
      else resolve();
    });
  }));
}

function sftpPut(s: SftpSession, localPath: string, remotePath: string): Promise<void> {
  return s.guard('upload', remotePath, (progress) => new Promise((resolve, reject) => {
    s.sftp.fastPut(localPath, remotePath, { step: () => progress() }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  }));
}

function sftpGet(s: SftpSession, remotePath: string, localPath: string): Promise<void> {
  return s.guard('download', remotePath, (progress) => new Promise((resolve, reject) => {
    s.sftp.fastGet(remotePath, localPath, { step: () => progress() }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  }));
}

export async function uploadViaSFTP(
  agent: Agent,
  localPaths: string[],
  destinationPath?: string,
  abortSignal?: AbortSignal
): Promise<{ success: string[]; failed: { path: string; error: string }[] }> {
  return withSftpSession(agent, abortSignal, async (s) => {
    const remoteBase = destinationPath
      ? resolveRemotePath(agent.workFolder, destinationPath)
      : agent.workFolder.replace(/\\/g, '/');

    await sftpMkdirRecursive(s, remoteBase);

    const success: string[] = [];
    const failed: { path: string; error: string }[] = [];

    for (const localPath of localPaths) {
      if (abortSignal?.aborted) throw new Error('Aborted by client');
      const fileName = path.basename(localPath);
      const remotePath = `${remoteBase}/${fileName}`;
      try {
        await sftpPut(s, localPath, remotePath);
        success.push(fileName);
      } catch (err: any) {
        if (isSessionFatal(err)) throw err;
        failed.push({ path: fileName, error: err.message });
      }
    }

    return { success, failed };
  });
}

/**
 * Write in-memory file contents directly to home-relative paths on the remote
 * machine -- no local temp files. baseDir + relPath is resolved by the SFTP
 * server relative to the connecting user's home directory.
 */
export async function uploadContentToHome(
  agent: Agent,
  files: Array<{ relPath: string; content: string }>,
  baseDir: string
): Promise<{ success: string[]; failed: { path: string; error: string }[] }> {
  return withSftpSession(agent, undefined, async (s) => {
    const base = baseDir.replace(/\\/g, '/').replace(/\/$/, '');
    const success: string[] = [];
    const failed: { path: string; error: string }[] = [];

    for (const file of files) {
      const remotePath = `${base}/${file.relPath}`;
      try {
        await sftpMkdirRecursive(s, path.posix.dirname(remotePath));
        await sftpWriteFile(s, remotePath, Buffer.from(file.content, 'utf-8'));
        success.push(file.relPath);
      } catch (err: any) {
        if (isSessionFatal(err)) throw err;
        failed.push({ path: file.relPath, error: err.message });
      }
    }

    return { success, failed };
  });
}

function sftpRealpath(s: SftpSession, p: string): Promise<string> {
  return s.guard('realpath', p, () => new Promise((resolve, reject) => {
    s.sftp.realpath(p, (err, abs) => {
      if (err) reject(err);
      else resolve(abs);
    });
  }));
}

/**
 * SFTP reports a Windows (Win32-OpenSSH) path as "/C:/Users/x"; every member
 * shell (PowerShell or Git Bash) wants "C:/Users/x". POSIX paths pass through.
 */
export function sftpPathToShellPath(p: string): string {
  return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;
}

/**
 * Write a secret-bearing file into the connecting user's home directory over
 * SFTP, so the value never appears in any command line on the member. The
 * file is created owner-only (0600; Windows ignores the mode -- the user
 * profile ACL is the boundary there). Returns the absolute path in the form
 * the member's shell accepts, resolved by the SFTP server itself (never a
 * guessed home directory).
 */
export async function writeSecretFileInHome(agent: Agent, fileName: string, content: string): Promise<string> {
  if (!/^[A-Za-z0-9._-]+$/.test(fileName)) throw new Error(`Unsafe secret file name: ${fileName}`);
  return withSftpSession(agent, undefined, async (s) => {
    const home = (await sftpRealpath(s, '.')).replace(/\/+$/, '');
    const remotePath = `${home}/${fileName}`;
    // open (0600) -> fchmod -> write -> close: a server that ignores the
    // open-time mode is still owner-only BEFORE any content lands. Windows
    // servers ignore/reject the chmod -- not fatal there (profile ACL).
    // Every step runs under the session's inactivity guard; the cleanup steps
    // are best-effort (a timed-out session is already ended).
    const data = Buffer.from(content, 'utf-8');
    const handle = await s.guard('open', remotePath, () => new Promise<Buffer>((resolve, reject) => {
      s.sftp.open(remotePath, 'w', { mode: 0o600 }, (err, h) => (err ? reject(err) : resolve(h)));
    }));
    let written = false;
    try {
      await s.guard('chmod', remotePath, () => new Promise<void>((resolve) => { s.sftp.fchmod(handle, 0o600, () => resolve()); }));
      await s.guard('write', remotePath, () => new Promise<void>((resolve, reject) => {
        s.sftp.write(handle, data, 0, data.length, 0, (err) => (err ? reject(err) : resolve()));
      }));
      written = true;
    } finally {
      await s.guard('close', remotePath, () => new Promise<void>((resolve) => { s.sftp.close(handle, () => resolve()); })).catch(() => {});
      if (!written) await s.guard('unlink', remotePath, () => new Promise<void>((resolve) => { s.sftp.unlink(remotePath, () => resolve()); })).catch(() => {});
    }
    return sftpPathToShellPath(remotePath);
  });
}

/** Best-effort removal of a file written by writeSecretFileInHome. */
export async function removeSecretFile(agent: Agent, shellPath: string): Promise<void> {
  const sftpPath = /^[A-Za-z]:/.test(shellPath) ? `/${shellPath}` : shellPath;
  await withSftpSession(agent, undefined, (s) => s.guard('unlink', sftpPath, () => new Promise<void>((resolve) => {
    s.sftp.unlink(sftpPath, () => resolve());
  }))).catch(() => { /* best-effort */ });
}

export async function downloadViaSFTP(
  agent: Agent,
  remotePaths: string[],
  localDestination: string,
  abortSignal?: AbortSignal
): Promise<{ success: string[]; failed: { path: string; error: string }[] }> {
  return withSftpSession(agent, abortSignal, async (s) => {
    fs.mkdirSync(localDestination, { recursive: true });

    const success: string[] = [];
    const failed: { path: string; error: string }[] = [];

    for (const remotePath of remotePaths) {
      if (abortSignal?.aborted) throw new Error('Aborted by client');
      const resolvedRemote = resolveRemotePath(agent.workFolder, remotePath);
      const fileName = path.posix.basename(resolvedRemote);
      const localPath = path.join(localDestination, fileName);
      try {
        await sftpGet(s, resolvedRemote, localPath);
        success.push(fileName);
      } catch (err: any) {
        if (isSessionFatal(err)) throw err;
        failed.push({ path: fileName, error: err.message });
      }
    }

    return { success, failed };
  });
}
