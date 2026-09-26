import path from 'node:path';

export function validateFilePaths(files: string[]): void {
  for (const file of files) {
    if (path.isAbsolute(file)) {
      throw new Error(`Path traversal rejected: absolute path not allowed: ${file}`);
    }
    const normalized = path.normalize(file);
    if (normalized.startsWith('..') || normalized.includes(`..${path.sep}`) || normalized.includes(`${path.sep}..`)) {
      throw new Error(`Path traversal rejected: ${file}`);
    }
  }
}
