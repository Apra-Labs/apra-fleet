/**
 * Well-known Git-for-Windows bash.exe install locations, shared verbatim
 * between the registration probe (src/services/shell-probe.ts's
 * buildGitBashDiscoveryCommand) and the local gitbash OsCommands path
 * resolver (src/os/windows-gitbash.ts's resolveGitBashPath) so the two lists
 * can never drift apart again (apra-fleet-7dir.7).
 *
 * Order matches Git for Windows' own install precedence: the two machine-wide
 * locations ("Git for Windows" / 32-bit vs 64-bit) first, then the per-user
 * ("Git for Windows" installed for the current user only, or portable-style)
 * LOCALAPPDATA location.
 */
export const GIT_BASH_MACHINE_CANDIDATES: readonly string[] = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];

/**
 * The user-scope candidate path, built from a LOCALAPPDATA value. Returns
 * undefined when localAppData is not set -- mirrors the registration probe's
 * own `if ($env:LOCALAPPDATA)` guard, which likewise skips this candidate
 * when the remote member has no LOCALAPPDATA env var.
 */
export function gitBashUserCandidate(localAppData: string | undefined): string | undefined {
  if (!localAppData) return undefined;
  return `${localAppData.replace(/[\\/]+$/, '')}\\Programs\\Git\\bin\\bash.exe`;
}

/**
 * Full ordered candidate list for a given LOCALAPPDATA value: the machine-wide
 * locations followed by the user-scope one (when LOCALAPPDATA is set).
 */
export function gitBashCandidates(localAppData: string | undefined): string[] {
  const userCandidate = gitBashUserCandidate(localAppData);
  return userCandidate ? [...GIT_BASH_MACHINE_CANDIDATES, userCandidate] : [...GIT_BASH_MACHINE_CANDIDATES];
}
