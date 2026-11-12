import path from 'node:path';

/**
 * True when `file` cannot be repo-relative on ANY platform: absolute in POSIX
 * or Windows form (leading / or \, or a drive letter), or with a '..' segment
 * under either separator. Independent of the host OS, so a path checked here
 * means the same on the KB server as on this machine.
 */
export function isAbsoluteOrTraversing(file: string): boolean {
  if (/^[\\/]/.test(file) || /^[A-Za-z]:/.test(file)) return true;
  return file.split(/[\\/]/).includes('..');
}

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
