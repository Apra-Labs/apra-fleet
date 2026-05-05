import type { Agent } from '../types.js';
import { uploadViaSFTP, downloadViaSFTP } from './sftp.js';

/**
 * Upload files to a remote agent via SFTP.
 */
export async function uploadFiles(
  agent: Agent,
  localPaths: string[],
  destinationPath?: string,
  abortSignal?: AbortSignal
): Promise<{ success: string[]; failed: { path: string; error: string }[] }> {
  return uploadViaSFTP(agent, localPaths, destinationPath, abortSignal);
}

/**
 * Download files from a remote agent via SFTP.
 */
export async function downloadFiles(
  agent: Agent,
  remotePaths: string[],
  localDestination: string,
  abortSignal?: AbortSignal
): Promise<{ success: string[]; failed: { path: string; error: string }[] }> {
  return downloadViaSFTP(agent, remotePaths, localDestination, abortSignal);
}
