import path from 'node:path';
import fs from 'node:fs';
import type { Client } from 'ssh2';
import type { Agent } from '../types.js';
import { openPooledChannel } from './ssh.js';
import { resolveRemotePath } from '../utils/platform.js';

function getSFTP(client: Client): Promise<import('ssh2').SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) reject(err);
      else resolve(sftp);
    });
  });
}

/**
 * Run one transfer on its own SFTP session and ALWAYS end it afterwards --
 * on success, error and abort. Each session is a channel (one sftp-server
 * process) on the member's pooled SSH connection; one left open per transfer
 * exhausts sshd's per-connection MaxSessions (default 10), after which every
 * command on that member fails with "Channel open failure". An abort ends
 * the session immediately, which fails any in-flight operation.
 */
async function withSftpSession<T>(
  agent: Agent,
  abortSignal: AbortSignal | undefined,
  fn: (sftp: import('ssh2').SFTPWrapper) => Promise<T>,
): Promise<T> {
  const { channel: sftp, release } = await openPooledChannel(agent, getSFTP);
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    try { sftp.end(); } catch { /* best-effort */ }
    release();
  };
  abortSignal?.addEventListener('abort', close, { once: true });
  try {
    if (abortSignal?.aborted) throw new Error('Aborted by client');
    return await fn(sftp);
  } finally {
    abortSignal?.removeEventListener('abort', close);
    close();
  }
}

function sftpMkdir(sftp: import('ssh2').SFTPWrapper, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, (err) => {
      if (err && (err as any).code !== 4) reject(err); // code 4 = already exists
      else resolve();
    });
  });
}

async function sftpMkdirRecursive(sftp: import('ssh2').SFTPWrapper, remotePath: string): Promise<void> {
  const parts = remotePath.replace(/\\/g, '/').split('/').filter(Boolean);
  let current = remotePath.startsWith('/') ? '/' : '';

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    try {
      await sftpMkdir(sftp, current);
    } catch {
      // directory may already exist
    }
  }
}

function sftpWriteFile(sftp: import('ssh2').SFTPWrapper, remotePath: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(remotePath, data, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function sftpPut(sftp: import('ssh2').SFTPWrapper, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function sftpGet(sftp: import('ssh2').SFTPWrapper, remotePath: string, localPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export async function uploadViaSFTP(
  agent: Agent,
  localPaths: string[],
  destinationPath?: string,
  abortSignal?: AbortSignal
): Promise<{ success: string[]; failed: { path: string; error: string }[] }> {
  return withSftpSession(agent, abortSignal, async (sftp) => {
    const remoteBase = destinationPath
      ? resolveRemotePath(agent.workFolder, destinationPath)
      : agent.workFolder.replace(/\\/g, '/');

    await sftpMkdirRecursive(sftp, remoteBase);

    const success: string[] = [];
    const failed: { path: string; error: string }[] = [];

    for (const localPath of localPaths) {
      if (abortSignal?.aborted) throw new Error('Aborted by client');
      const fileName = path.basename(localPath);
      const remotePath = `${remoteBase}/${fileName}`;
      try {
        await sftpPut(sftp, localPath, remotePath);
        success.push(fileName);
      } catch (err: any) {
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
  return withSftpSession(agent, undefined, async (sftp) => {
    const base = baseDir.replace(/\\/g, '/').replace(/\/$/, '');
    const success: string[] = [];
    const failed: { path: string; error: string }[] = [];

    for (const file of files) {
      const remotePath = `${base}/${file.relPath}`;
      try {
        await sftpMkdirRecursive(sftp, path.posix.dirname(remotePath));
        await sftpWriteFile(sftp, remotePath, Buffer.from(file.content, 'utf-8'));
        success.push(file.relPath);
      } catch (err: any) {
        failed.push({ path: file.relPath, error: err.message });
      }
    }

    return { success, failed };
  });
}

function sftpRealpath(sftp: import('ssh2').SFTPWrapper, p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(p, (err, abs) => {
      if (err) reject(err);
      else resolve(abs);
    });
  });
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
  return withSftpSession(agent, undefined, async (sftp) => {
    const home = (await sftpRealpath(sftp, '.')).replace(/\/+$/, '');
    const remotePath = `${home}/${fileName}`;
    // open (0600) -> fchmod -> write -> close: a server that ignores the
    // open-time mode is still owner-only BEFORE any content lands. Windows
    // servers ignore/reject the chmod -- not fatal there (profile ACL).
    const data = Buffer.from(content, 'utf-8');
    const handle = await new Promise<Buffer>((resolve, reject) => {
      sftp.open(remotePath, 'w', { mode: 0o600 }, (err, h) => (err ? reject(err) : resolve(h)));
    });
    let written = false;
    try {
      await new Promise<void>((resolve) => { sftp.fchmod(handle, 0o600, () => resolve()); });
      await new Promise<void>((resolve, reject) => {
        sftp.write(handle, data, 0, data.length, 0, (err) => (err ? reject(err) : resolve()));
      });
      written = true;
    } finally {
      await new Promise<void>((resolve) => { sftp.close(handle, () => resolve()); });
      if (!written) await new Promise<void>((resolve) => { sftp.unlink(remotePath, () => resolve()); });
    }
    return sftpPathToShellPath(remotePath);
  });
}

/** Best-effort removal of a file written by writeSecretFileInHome. */
export async function removeSecretFile(agent: Agent, shellPath: string): Promise<void> {
  const sftpPath = /^[A-Za-z]:/.test(shellPath) ? `/${shellPath}` : shellPath;
  await withSftpSession(agent, undefined, (sftp) => new Promise<void>((resolve) => {
    sftp.unlink(sftpPath, () => resolve());
  })).catch(() => { /* best-effort */ });
}

export async function downloadViaSFTP(
  agent: Agent,
  remotePaths: string[],
  localDestination: string,
  abortSignal?: AbortSignal
): Promise<{ success: string[]; failed: { path: string; error: string }[] }> {
  return withSftpSession(agent, abortSignal, async (sftp) => {
    fs.mkdirSync(localDestination, { recursive: true });

    const success: string[] = [];
    const failed: { path: string; error: string }[] = [];

    for (const remotePath of remotePaths) {
      if (abortSignal?.aborted) throw new Error('Aborted by client');
      const resolvedRemote = resolveRemotePath(agent.workFolder, remotePath);
      const fileName = path.posix.basename(resolvedRemote);
      const localPath = path.join(localDestination, fileName);
      try {
        await sftpGet(sftp, resolvedRemote, localPath);
        success.push(fileName);
      } catch (err: any) {
        failed.push({ path: fileName, error: err.message });
      }
    }

    return { success, failed };
  });
}
