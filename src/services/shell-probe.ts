/**
 * Windows member shell probe (apra-fleet-7dir.1.3).
 *
 * Registration needs to know WHICH Windows shell a member's command strings
 * should target -- Git-for-Windows bash, PowerShell 7, or Windows PowerShell
 * 5.1 -- because the three are not interchangeable (PS7 vs PS5.1 module
 * resolution differences are an already-known bug source here, and gitbash
 * members want POSIX command strings entirely).
 *
 * Two hard-won constraints shape every probe below:
 *
 *  1. PowerShell reports false success on non-terminating errors, so an
 *     exit-code-only check is NOT evidence a candidate shell works. Every
 *     probe therefore asserts on a prefixed stdout marker as well as exit 0.
 *  2. A `bash.exe` on PATH is not necessarily Git bash: Windows ships the WSL
 *     launcher under System32 (and WindowsApps) with the same binary name. It
 *     exits 0 and prints "Linux" for `uname -s`, so only the MINGW/MSYS/CYGWIN
 *     uname check disambiguates it. Verified on a real box: Git's bash prints
 *     "MINGW64_NT-10.0-19045", System32's prints "Linux".
 *
 * Every probe is issued through `powershell -EncodedCommand` (base64 UTF-16LE)
 * so it survives regardless of whether the member's SSH default shell is
 * cmd.exe or PowerShell -- no quoting of ours ever reaches an unknown parser.
 */
import type { MemberShell } from '../os/os-commands.js';
import type { RemoteOS } from '../utils/platform.js';
import { isWindowsPosixUname } from '../utils/platform.js';
import { wrapPowerShellEncoded } from '../os/windows.js';
import { GIT_BASH_MACHINE_CANDIDATES, GIT_BASH_USER_SUFFIX } from '../os/git-bash-candidates.js';

/** Result shape of a single probe command execution. */
export interface ProbeExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Minimal command runner the probe needs (AgentStrategy.execCommand shaped). */
export type ProbeExec = (command: string, timeoutMs: number) => Promise<ProbeExecResult>;

export interface ShellProbeResult {
  shell: MemberShell;
  /** Present only when the probe could not prove anything and fell back. */
  warning?: string;
}

/** Per-probe budget. Short on purpose: an unprovisioned WSL bash.exe can sit
 *  there printing a store URL instead of exiting. */
export const SHELL_PROBE_TIMEOUT_MS = 15000;

const BASH_CANDIDATE_MARKER = 'BASHCAND:';
const PS_EDITION_MARKER = 'PSEDITION:';
const PS_MAJOR_MARKER = 'PSMAJOR:';
const BASH_CHANNEL_MARKER_LINE = 'FLEET_BASH_CHANNEL_MARKER';
const BASH_CHANNEL_HEREDOC_DELIM = 'FLEET_BASH_CHANNEL_EOF';

/**
 * Whether registration should probe for a shell at all.
 *
 * Windows members only, and never when the operator supplied one explicitly --
 * an explicit shell always wins over the probe result.
 */
export function shouldProbeShell(os: RemoteOS | undefined, explicitShell?: MemberShell): boolean {
  return os === 'windows' && !explicitShell;
}

/**
 * Reject bash.exe paths that are Windows' own WSL launcher rather than a real
 * Git-for-Windows / MSYS install. Belt and braces: the uname check below is
 * what actually proves the candidate, this just avoids spending a probe (and
 * possibly a WSL first-run stall) on a known-bad path.
 */
export function isWslLauncherPath(candidatePath: string): boolean {
  const segments = candidatePath.replace(/\//g, '\\').toLowerCase().split('\\');
  return segments.includes('system32') || segments.includes('sysnative') || segments.includes('windowsapps');
}

/** One round trip that lists every plausible Git-bash path that actually exists
 *  on the member: well-known install locations plus anything named bash.exe on
 *  PATH. Each line is prefixed so echoed-back input can never be mistaken for a
 *  result.
 *
 *  The machine-wide well-known locations come from GIT_BASH_MACHINE_CANDIDATES
 *  (src/os/git-bash-candidates.ts), the SAME list windows-gitbash.ts's
 *  resolveGitBashPath consults for a local member -- one literal, two
 *  consumers, so the two can never drift apart again (apra-fleet-7dir.7). The
 *  LOCALAPPDATA (user-scope) candidate is still built with a PowerShell
 *  `Join-Path $env:LOCALAPPDATA ...` expression rather than a JS-side value,
 *  because it must resolve against the REMOTE member's LOCALAPPDATA, not this
 *  process's own. */
export function buildGitBashDiscoveryCommand(): string {
  const machineCandidates = GIT_BASH_MACHINE_CANDIDATES
    .map((p) => `'${p.replace(/'/g, "''")}'`)
    .join(',');
  const ps = [
    `$c = @(${machineCandidates})`,
    `if ($env:LOCALAPPDATA) { $c += (Join-Path $env:LOCALAPPDATA '${GIT_BASH_USER_SUFFIX.replace(/'/g, "''")}') }`,
    `$c += @(Get-Command bash.exe -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })`,
    `$c | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique | ForEach-Object { Write-Output ('${BASH_CANDIDATE_MARKER}' + $_) }`,
  ].join('; ');
  return wrapPowerShellEncoded(ps);
}

/** Smoke command for one Git-bash candidate: run the real binary and ask it what
 *  it is. `&` is the call operator -- without it PowerShell would merely echo the
 *  quoted path back, exit 0, and look like a success. */
export function buildGitBashProbeCommand(bashPath: string): string {
  const quoted = bashPath.replace(/'/g, "''");
  return wrapPowerShellEncoded(`& '${quoted}' -lc 'uname -s'`);
}

/** Smoke command for PowerShell 7. Nested -EncodedCommand so neither our outer
 *  wrapper nor a cmd.exe default shell can eat the `$` before pwsh sees it. */
export function buildPwsh7ProbeCommand(): string {
  const inner = Buffer.from(
    `Write-Output ('${PS_EDITION_MARKER}' + $PSVersionTable.PSEdition)`,
    'utf16le',
  ).toString('base64');
  return wrapPowerShellEncoded(`& pwsh -NoProfile -EncodedCommand ${inner}`);
}

/** Smoke command for Windows PowerShell 5.1. */
export function buildPowerShell5ProbeCommand(): string {
  const inner = Buffer.from(
    `Write-Output ('${PS_MAJOR_MARKER}' + $PSVersionTable.PSVersion.Major)`,
    'utf16le',
  ).toString('base64');
  return wrapPowerShellEncoded(`& powershell -NoProfile -EncodedCommand ${inner}`);
}

/** Parse the discovery output into candidate paths, dropping WSL launchers. */
export function parseGitBashCandidates(stdout: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(BASH_CANDIDATE_MARKER)) continue;
    const candidate = trimmed.slice(BASH_CANDIDATE_MARKER.length).trim();
    if (!candidate || isWslLauncherPath(candidate)) continue;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

/** Exit code AND stdout must both check out -- see constraint (1) above. */
export function isProvenGitBash(result: ProbeExecResult): boolean {
  return result.code === 0 && isWindowsPosixUname(result.stdout);
}

/**
 * Proves the RAW (unwrapped) exec channel itself is interpreted by a genuine
 * Git-for-Windows/MSYS bash -- not merely that a bash.exe binary exists
 * somewhere on the machine. This distinction only matters for a REMOTE (SSH)
 * member: `ssh.ts`'s execCommand hands the command string straight to the
 * member's sshd, which runs it through whatever ITS OWN DefaultShell is
 * configured to be -- a Git-bash binary being installed proves nothing about
 * that, since every other probe above (isProvenGitBash included) is
 * deliberately wrapped in `powershell -EncodedCommand ...` so it survives
 * regardless of the connection's real default shell. A local member has no
 * such gap (LocalStrategy spawns the resolved bash.exe path directly, see
 * strategy.ts), so this check is remote-transport-only.
 *
 * Deliberately NOT wrapPowerShellEncoded -- wrapping would defeat the whole
 * point of testing what interprets an unwrapped string. Heredoc syntax
 * (`<<`) is rejected outright by both cmd.exe and PowerShell, making it a
 * clean interpreter discriminator; chaining `&& uname -s` onto it in the
 * SAME round trip reuses the existing MINGW/MSYS/CYGWIN-vs-WSL uname check
 * (isWindowsPosixUname) to rule out a WSL bash.exe DefaultShell the same way
 * the binary-existence path above already does for local members.
 */
export function buildRemoteBashChannelProbeCommand(): string {
  return `cat <<'${BASH_CHANNEL_HEREDOC_DELIM}' && uname -s\n${BASH_CHANNEL_MARKER_LINE}\n${BASH_CHANNEL_HEREDOC_DELIM}`;
}

/** Exit code, the literal marker line, AND a proven-POSIX uname line right
 *  after it must all be present -- tolerates CRLF/blank-line noise a real
 *  SSH round trip can introduce. */
export function isProvenRemoteBashChannel(result: ProbeExecResult): boolean {
  if (result.code !== 0) return false;
  const lines = result.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const markerIdx = lines.indexOf(BASH_CHANNEL_MARKER_LINE);
  if (markerIdx === -1 || markerIdx + 1 >= lines.length) return false;
  return isWindowsPosixUname(lines[markerIdx + 1]);
}

export function isProvenPwsh7(result: ProbeExecResult): boolean {
  return result.code === 0 && /PSEDITION:\s*Core/i.test(result.stdout);
}

export function isProvenPowerShell5(result: ProbeExecResult): boolean {
  return result.code === 0 && /PSMAJOR:\s*5/.test(result.stdout);
}

const FAILED: ProbeExecResult = { stdout: '', stderr: '', code: 1 };

async function safeExec(exec: ProbeExec, command: string): Promise<ProbeExecResult> {
  try {
    const r = await exec(command, SHELL_PROBE_TIMEOUT_MS);
    return { stdout: r?.stdout ?? '', stderr: r?.stderr ?? '', code: r?.code ?? 1 };
  } catch {
    return FAILED;
  }
}

/**
 * Probe a Windows member for its shell, in order: Git bash, then PowerShell 7,
 * then PowerShell 5.1. Returns the FIRST candidate proven working by a real
 * smoke command (exit code AND stdout both checked).
 *
 * `transport` distinguishes a local member (LocalStrategy spawns the
 * resolved bash.exe path directly -- binary existence is sufficient proof)
 * from a remote/SSH member (raw command strings are handed straight to the
 * member's own sshd DefaultShell -- binary existence proves nothing about
 * what that connection actually executes; see isProvenRemoteBashChannel's
 * doc comment). Defaults to 'local' so every existing local-member call site
 * and test keeps its current behaviour unchanged.
 *
 * Never throws and never fails registration: if nothing can be proven it
 * degrades to powershell5 -- the shell Windows always has and the value that
 * yields byte-identical command strings to the pre-probe behaviour -- with a
 * warning for the caller to surface.
 */
export async function probeWindowsShell(exec: ProbeExec, transport: 'local' | 'ssh' = 'local'): Promise<ShellProbeResult> {
  const discovery = await safeExec(exec, buildGitBashDiscoveryCommand());
  const candidates = discovery.code === 0 ? parseGitBashCandidates(discovery.stdout) : [];

  let gitBashBinaryProven = false;
  for (const candidate of candidates) {
    if (isProvenGitBash(await safeExec(exec, buildGitBashProbeCommand(candidate)))) {
      gitBashBinaryProven = true;
      break;
    }
  }

  if (gitBashBinaryProven) {
    const channelConfirmed = transport === 'local'
      || isProvenRemoteBashChannel(await safeExec(exec, buildRemoteBashChannelProbeCommand()));
    if (channelConfirmed) return { shell: 'gitbash' };
  }

  // Reached only when gitbash could not be confirmed for this transport --
  // either no binary was proven at all, or (ssh only) one was proven but the
  // connection's own default shell isn't actually bash. Fall through to
  // PowerShell 7 / 5.1 below as before; if this specifically was the
  // "binary exists but wrong default shell" case, attach a warning
  // identifying that even when a shell IS successfully proven, since it is
  // operator-actionable information the plain success path would otherwise
  // swallow silently.
  const gitBashUnreachableWarning = (transport === 'ssh' && gitBashBinaryProven)
    ? 'Git bash is installed on this member but is not this connection\'s default shell '
      + '(its SSH server\'s configured DefaultShell) -- using PowerShell dialect instead. To use '
      + 'gitbash command strings, set the remote SSH DefaultShell to bash.exe, or set shell '
      + 'explicitly with update_member.'
    : undefined;

  if (isProvenPwsh7(await safeExec(exec, buildPwsh7ProbeCommand()))) {
    return gitBashUnreachableWarning ? { shell: 'pwsh7', warning: gitBashUnreachableWarning } : { shell: 'pwsh7' };
  }

  if (isProvenPowerShell5(await safeExec(exec, buildPowerShell5ProbeCommand()))) {
    return gitBashUnreachableWarning ? { shell: 'powershell5', warning: gitBashUnreachableWarning } : { shell: 'powershell5' };
  }

  return {
    shell: 'powershell5',
    warning: gitBashUnreachableWarning
      ?? ('Could not verify which Windows shell this member uses -- assuming Windows PowerShell 5.1. '
        + 'If this member should use Git bash or PowerShell 7, set it explicitly with update_member.'),
  };
}
