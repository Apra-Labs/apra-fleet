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
}

export default SeWindowsGitbashCommands;
