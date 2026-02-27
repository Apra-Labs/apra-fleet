import path from 'node:path';
import fs from 'node:fs';
import type { Client } from 'ssh2';
import type { Agent } from '../types.js';
import { getConnection } from './ssh.js';

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

export async function uploadViaSFTP(
  agent: Agent,
  localPaths: string[],
  remoteSubfolder?: string
): Promise<{ success: string[]; failed: { path: string; error: string }[] }> {
  const client = await getConnection(agent);
  const sftp = await getSFTP(client);

  let remoteBase = agent.workFolder.replace(/\\/g, '/');
  if (remoteSubfolder) {
    remoteBase = `${remoteBase}/${remoteSubfolder}`;
  }

  await sftpMkdirRecursive(sftp, remoteBase);

  const success: string[] = [];
  const failed: { path: string; error: string }[] = [];

  for (const localPath of localPaths) {
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
