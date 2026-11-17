// se-windows-gitbash.mjs -- member-bound command primitives for a Windows
// member whose registered shell is Git-for-Windows bash (`shell: 'gitbash'`).
//
// EXTENDS SePosixCommands (not SeWindowsCommands): what this member's shell
// actually receives is a *bash* command string, so the whole POSIX surface
// (wrapForMember's identity passthrough, homePath's `$HOME/...` form, invoke's
// unquoted-path contract, readCredentialHelper's unvalidated label) is correct
// as-is and is inherited verbatim -- Git for Windows sets `$HOME` to the same
// user-profile directory `$env:USERPROFILE` resolves to, so no path-root
// override is needed. This mirrors the extends-based reuse shape used on the
// core side by src/os/windows-gitbash.ts (which extends LinuxCommands for the
// identical reason), even though the two implementations share no code.
//
// The ONLY genuinely Windows-native detail left is the deployed
// git-credential-helper's file suffix: apra-fleet core's Windows
// gitCredentialHelperWrite (both the PowerShell and the gitbash variant --
// see src/os/windows-gitbash.ts's gitCredentialHelperWrite, which writes
// "$HOME/${credFileName}.bat") always writes a native Windows `.bat` helper,
// never the extensionless POSIX script SePosixCommands assumes. Everything
// else -- wrapForMember, homePath, invoke, credentialHelperPath,
// readCredentialHelper -- inherits unchanged from se-posix.mjs; duplicating
// any of those bodies here would just be bash-string-building drift waiting
// to happen.
//
// PID capture is deliberately NOT overridden here: se-os-commands.mjs's
// header audit found no call site in this package that builds a PID-capture
// command string (apra-fleet core's execute_command applies that server-side
// for every member OS), so there is no primitive to override.
//
// wrapPowerShellScript IS overridden here, even though this class extends
// SePosixCommands: a handful of member-bound scripts (dolt-settle.mjs's
// installPinnedDolt/killProcessAtPath/spawnEphemeralServer) are whole
// PowerShell scripts with no safe bash equivalent, so this member -- despite
// its own shell being bash -- still needs a way to invoke real PowerShell
// for them (apra-fleet-7dir.21). See that method's own doc comment for the
// full design rationale.

import { SePosixCommands } from './se-posix.mjs';

/**
 * Bash command primitives for a Windows member running Git-for-Windows bash.
 */
export class SeWindowsGitbashCommands extends SePosixCommands {
  /** Stable identifier for logging/tests. */
  get shell() {
    return 'gitbash';
  }

  /**
   * The deployed git-credential helper on ANY Windows member is a native
   * `.bat` (git.exe execs it directly), even when the member's own shell is
   * bash -- see src/os/windows-gitbash.ts's gitCredentialHelperWrite, which
   * writes "$HOME/${credFileName}.bat" rather than the extensionless
   * `#!/bin/sh` script SePosixCommands.credentialHelperSuffix assumes.
   */
  get credentialHelperSuffix() {
    return '.bat';
  }

  /**
   * Wrap a whole PowerShell SCRIPT (not a single command string) into a
   * bash-invocable form, for the handful of member-bound scripts that have
   * no safe bash equivalent (installPinnedDolt's Invoke-WebRequest/
   * Expand-Archive install, killProcessAtPath's Get-Process/Stop-Process
   * pipeline, spawnEphemeralServer's Invoke-CimMethod Win32_Process spawn --
   * see dolt-settle.mjs). This member's OWN shell is bash (that is what
   * `shell: 'gitbash'` means), but per the repo CLAUDE.md rule ("Wrap
   * PowerShell commands explicitly... rather than assuming the member's
   * shell") a Windows gitbash member still HAS a PowerShell interpreter
   * available, so the live-verified PowerShell script bodies are kept
   * as-is and invoked FROM bash, never rewritten in bash.
   *
   * `-EncodedCommand` (base64 UTF-16LE) is used rather than `-Command`
   * specifically because it removes every quoting interaction between bash
   * and PowerShell -- a script containing double quotes, `$` or backticks
   * would otherwise need bash-safe AND PowerShell-safe quoting
   * simultaneously, which the two dialects cannot agree on (see
   * dolt-settle.mjs's own Section 1b header for concrete examples of that
   * disagreement). Decoding the base64 blob as UTF-16LE reproduces the
   * original script exactly.
   *
   * NON-OBVIOUS: inside the wrapped script the dialect is STILL PowerShell,
   * never this member's own bash -- paths and escaping inside `script` must
   * keep the PowerShell form ($env:USERPROFILE\..., backtick escaping) even
   * though this member's shell is bash. This override only changes how the
   * script is INVOKED, never what it contains.
   *
   * @param {string} script a whole PowerShell script body
   * @returns {string} a bash-safe command line that runs it via PowerShell
   */
  wrapPowerShellScript(script) {
    const encoded = Buffer.from(String(script), 'utf16le').toString('base64');
    return `powershell -NoProfile -EncodedCommand ${encoded}`;
  }
}

export default SeWindowsGitbashCommands;
