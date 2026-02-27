import fs from 'node:fs';

/**
 * Enforce restrictive file permissions (owner-only read/write).
 * On Linux/macOS: chmod 0o600. On Windows: no-op (NTFS ACLs handle this).
 *
 * Centralises the platform check — callers never branch on process.platform.
 */
export function enforceOwnerOnly(filePath: string): void {
  if (process.platform === 'win32') return;
  fs.chmodSync(filePath, 0o600);
}
