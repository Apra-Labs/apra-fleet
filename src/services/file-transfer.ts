import type { Agent } from '../types.js';
import { uploadViaSFTP } from './sftp.js';

/**
 * Upload files to a remote agent via SFTP.
 */
export async function uploadFiles(
  agent: Agent,
  localPaths: string[],
  remoteSubfolder?: string
): Promise<{ success: string[]; failed: { path: string; error: string }[] }> {
  return uploadViaSFTP(agent, localPaths, remoteSubfolder);
}
