import type { Agent } from '../types.js';
import type { RemoteOS } from './platform.js';
import type { MemberShell } from '../os/os-commands.js';
import { decryptPassword } from './crypto.js';
import { escapeShellArg, escapePowerShellArgInner } from './shell-escape.js';
import { isPosixShell } from './agent-helpers.js';

/**
 * Build a shell-correct inline export prefix for all stored auth env vars.
 * Returns empty string if the agent has no stored env vars.
 *
 * Branches on the member's SHELL, not its OS: a Windows member registered as
 * Git-for-Windows bash (shell=gitbash) runs the command under bash, which
 * would execute a PowerShell `$env:K='v'` assignment as a command -- the var
 * is never set and bash echoes the value back on stderr. `shell` is required
 * (it may be undefined) so every caller has to pass the member's shell.
 *
 * POSIX values are single-quoted via escapeShellArg, so no $, backtick, !, or
 * backslash inside the value is ever expanded by the member's shell.
 */
export function buildAuthEnvPrefix(agent: Agent, os: RemoteOS, shell: MemberShell | undefined): string {
  const vars = agent.encryptedEnvVars;
  if (!vars || Object.keys(vars).length === 0) return '';

  const posix = isPosixShell(os, shell);
  const parts: string[] = [];

  for (const [name, encrypted] of Object.entries(vars)) {
    const value = decryptPassword(encrypted);

    if (posix) {
      parts.push(`export ${name}=${escapeShellArg(value)}`);
    } else {
      // PowerShell: single-quote escaping (matching windows.ts envPrefix pattern)
      const escaped = escapePowerShellArgInner(value);
      parts.push(`$env:${name}='${escaped}'`);
    }
  }

  if (posix) {
    return parts.join(' && ') + ' && ';
  }
  return parts.join('; ') + '; ';
}
