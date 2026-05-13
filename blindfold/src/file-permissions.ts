import fs from 'node:fs';

export function enforceOwnerOnly(filePath: string): void {
  if (process.platform === 'win32') return;
  fs.chmodSync(filePath, 0o600);
}
