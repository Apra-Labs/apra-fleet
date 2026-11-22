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

/**
 * The path form a member's SFTP server accepts. A Windows member runs
 * Win32-OpenSSH, whose SFTP server does not understand the MSYS/Git Bash
 * drive form (/c/Users/x): it answers "No such file". A Git Bash member's
 * probed home -- and every path built from it for its shell -- is in that
 * form, so every SFTP operation rewrites it to C:/Users/x here. Only a
 * Windows member is rewritten (on POSIX, /c/x is a real path); every other
 * spelling passes through unchanged.
 */
export function toSftpPath(remotePath: string, agentOs: RemoteOS | undefined): string {
  if (agentOs !== 'windows') return remotePath;
  const m = remotePath.match(/^\/([A-Za-z])(?:\/(.*))?$/);
  return m ? `${m[1].toUpperCase()}:/${m[2] ?? ''}` : remotePath;
}

/**
 * True when `uname -s` output identifies a POSIX-emulation layer running on
 * Windows (Git-for-Windows / MSYS2 / Cygwin). This is the ONLY reliable way to
 * tell a Git-for-Windows bash.exe apart from the WSL launcher of the same name
 * under System32: the WSL one also exits 0 but reports "Linux".
 */
export function isWindowsPosixUname(unameOutput: string): boolean {
  const uname = unameOutput.trim().toLowerCase();
  return uname.startsWith('mingw') || uname.startsWith('msys') || uname.startsWith('cygwin');
}

export function detectOS(unameOutput: string, verOutput: string): RemoteOS {
  if (verOutput.toLowerCase().includes('windows') || verOutput.toLowerCase().includes('microsoft')) {
    return 'windows';
  }
  const uname = unameOutput.trim().toLowerCase();
  if (uname === 'darwin') return 'macos';
  // Git Bash / MSYS2 / Cygwin on Windows report MINGW*, MSYS*, or CYGWIN*
  if (isWindowsPosixUname(unameOutput)) {
    return 'windows';
  }
  return 'linux';
}
