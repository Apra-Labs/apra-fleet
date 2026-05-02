import path from 'node:path';

export type RemoteOS = 'windows' | 'macos' | 'linux';

/**
 * Check whether a remote path is contained within the member's work folder.
 * Handles Windows remote members where path.posix.resolve fails on drive letters.
 */
export function isContainedInWorkFolder(workFolder: string, remotePath: string): boolean {
  const normWorkFolder = workFolder.replace(/\\/g, '/').replace(/\/$/, '');
  const normRemotePath = remotePath.replace(/\\/g, '/');
  const isWindowsWorkFolder = /^[A-Za-z]:/.test(normWorkFolder);

  let resolved: string;
  if (isWindowsWorkFolder) {
    const isAbsolute = /^[A-Za-z]:/.test(normRemotePath) || normRemotePath.startsWith('/');
    const joined = isAbsolute ? normRemotePath : `${normWorkFolder}/${normRemotePath}`;
    // Collapse .. and . segments manually (path.posix.resolve doesn't understand drive letters)
    const stack: string[] = [];
    for (const part of joined.split('/')) {
      if (part === '..') { stack.pop(); }
      else if (part !== '.') { stack.push(part); }
    }
    resolved = stack.join('/');
  } else {
    resolved = path.posix.resolve(normWorkFolder, normRemotePath);
  }

  return resolved === normWorkFolder || resolved.startsWith(`${normWorkFolder}/`);
}

/**
 * Resolves a remote path relative to a work folder, handling Windows drive-letter paths
 * that path.posix.resolve incorrectly treats as relative (since they don't start with '/').
 */
export function resolveRemotePath(workFolder: string, subPath: string): string {
  const normWorkFolder = workFolder.replace(/\\/g, '/').replace(/\/$/, '');
  const normSubPath = subPath.replace(/\\/g, '/');
  const isWindowsWorkFolder = /^[A-Za-z]:/.test(normWorkFolder);

  if (isWindowsWorkFolder) {
    const isAbsolute = /^[A-Za-z]:/.test(normSubPath) || normSubPath.startsWith('/');
    return isAbsolute ? normSubPath : `${normWorkFolder}/${normSubPath}`;
  } else {
    return path.posix.resolve(normWorkFolder, normSubPath);
  }
}

export function detectOS(unameOutput: string, verOutput: string): RemoteOS {
  if (verOutput.toLowerCase().includes('windows') || verOutput.toLowerCase().includes('microsoft')) {
    return 'windows';
  }
  const uname = unameOutput.trim().toLowerCase();
  if (uname === 'darwin') return 'macos';
  // Git Bash / MSYS2 / Cygwin on Windows report MINGW*, MSYS*, or CYGWIN*
  if (uname.startsWith('mingw') || uname.startsWith('msys') || uname.startsWith('cygwin')) {
    return 'windows';
  }
  return 'linux';
}
