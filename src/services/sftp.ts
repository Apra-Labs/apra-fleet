import path from 'node:path';
import fs from 'node:fs';
import type { Client } from 'ssh2';
import type { Agent } from '../types.js';
import { getConnection } from './ssh.js';
import { resolveRemotePath } from '../utils/platform.js';

function getSFTP(client: Client): Promise<import('ssh2').SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) reject(err);
      else resolve(sftp);
    });
  });
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
  const client = await getConnection(agent);
  const sftp = await getSFTP(client);

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
}

export async function downloadViaSFTP(
  agent: Agent,
  remotePaths: string[],
  localDestination: string,
  abortSignal?: AbortSignal
): Promise<{ success: string[]; failed: { path: string; error: string }[] }> {
  const client = await getConnection(agent);
  const sftp = await getSFTP(client);

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
}
