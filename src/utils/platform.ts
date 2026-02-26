export type RemoteOS = 'windows' | 'macos' | 'linux';

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
