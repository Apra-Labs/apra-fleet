// se-os-commands.mjs -- the one place fleet-sprint and the supervisor ask
// "what does a command string look like for THIS member?".
//
// Same package as its callers, imported directly: no REST hop, no IPC, no
// build step, and no dependency on apra-fleet core (which ships as a compiled
// binary, while these files ship as open user-copyable source).
//
// ---------------------------------------------------------------------------
// WHY THESE PRIMITIVES AND NO OTHERS
//
// The set is derived from the member-bound strings this package actually
// builds today, not from a general model of a shell:
//
//   wrapForMember          runner.js's local PowerShell envelope builder (the
//                          only ad-hoc PowerShell builder in the runner) and
//                          its git-credential call site.
//   readCredentialHelper   runner.js buildCredentialReadCommand(os, label) --
//                          the runner's only OS-branched member-bound command.
//   credentialHelperPath   the readable descriptor that same function returns
//                          for its error messages.
//   homePath               dolt-settle.mjs's member-side dolt path
//                          ("$env:USERPROFILE\.apra-fleet\bin\dolt.exe" vs
//                          "$HOME/.apra-fleet/bin/dolt").
//   invoke                 dolt-settle.mjs's invokeBinary(): PowerShell needs
//                          the call operator, POSIX must not have it.
//
// Deliberately NOT included, so this stays an interface rather than a
// catalogue:
//   - argument quoting and the curl/curl.exe binary choice: their only call
//     site is the GitHub VCS provider, and provider-specific logic belongs
//     behind the provider descriptor hooks, never in a shared module.
//   - work-folder wrapping and PID capture: apra-fleet core's execute_command
//     applies both server-side. No file in this package builds either -- the
//     runner only MENTIONS them in comments describing what core does. A
//     primitive here would have no caller.
//   - credential file WRITE: core's provision_vcs_auth owns the write side;
//     this package only ever reads the deployed helper back.
//
// The supervisor was audited too: its only shell text is a local
// process-inspection call on the supervisor's OWN host (wmic / Get-CimInstance
// / ps, chosen from process.platform), never a member-bound command string, so
// it needs nothing of its own from this module.
// ---------------------------------------------------------------------------

import { SePosixCommands } from './se-posix.mjs';
import { SeWindowsCommands } from './se-windows.mjs';
import { SeWindowsGitbashCommands } from './se-windows-gitbash.mjs';

export { SePosixCommands } from './se-posix.mjs';
export { SeWindowsCommands } from './se-windows.mjs';
export { SeWindowsGitbashCommands } from './se-windows-gitbash.mjs';

const posix = new SePosixCommands();
const windowsPowerShell = new SeWindowsCommands();
const windowsGitbash = new SeWindowsGitbashCommands();

/** Normalize whatever a caller has to hand into { os, shell }. */
function normalizeTarget(target) {
  if (typeof target === 'string') return { os: target.trim().toLowerCase(), shell: '' };
  const os = String((target && target.os) || '').trim().toLowerCase();
  const shell = String((target && target.shell) || '').trim().toLowerCase();
  return { os, shell };
}

/**
 * Resolve the command primitives for a member.
 *
 * Accepts either a member record shape ({ os, shell } -- exactly the two
 * fields member_detail exposes) or a bare OS string, so existing callers that
 * only know the OS can adopt this without first widening their resolver.
 *
 * A member whose OS cannot be determined resolves to POSIX: that is the
 * historical behaviour of every string this module replaces, and keeping it
 * means an unresolvable member degrades exactly as it does today rather than
 * silently switching dialect.
 *
 * @param {{ os?: string, shell?: string }|string} target
 * @returns {SePosixCommands|SeWindowsCommands}
 */
export function getSeCommands(target) {
  const { os, shell } = normalizeTarget(target);
  if (os === 'windows' || os === 'win32') {
    if (shell === 'gitbash') return windowsGitbash;
    // A Windows member with no recorded shell (or any shell other than
    // gitbash) is a PowerShell member: that is what every Windows member was
    // assumed to be before shells were recorded, so it must stay
    // byte-identical.
    return windowsPowerShell;
  }
  return posix;
}

export default getSeCommands;
