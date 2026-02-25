import path from 'node:path';
import type { Agent } from '../types.js';
import { execCommand } from './ssh.js';
import { uploadViaSFTP } from './sftp.js';

/**
 * Upload files to a remote agent.
 * Strategy: Use SCP if available on the remote, otherwise fall back to SFTP.
 */
export async function uploadFiles(
  agent: Agent,
  localPaths: string[],
  remoteSubfolder?: string
): Promise<{ success: string[]; failed: { path: string; error: string }[] }> {
  if (agent.scpAvailable) {
    return uploadViaSCP(agent, localPaths, remoteSubfolder);
  }
  return uploadViaSFTP(agent, localPaths, remoteSubfolder);
}

async function uploadViaSCP(
  agent: Agent,
  localPaths: string[],
  remoteSubfolder?: string
): Promise<{ success: string[]; failed: { path: string; error: string }[] }> {
  // SCP via SFTP subsystem — we read local files and write them through the SSH channel
  // This avoids needing the `scp` binary on the local machine
  return uploadViaSFTP(agent, localPaths, remoteSubfolder);
}
