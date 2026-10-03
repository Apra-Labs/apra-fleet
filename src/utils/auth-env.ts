import type { Agent } from '../types.js';
import { decryptPassword } from './crypto.js';
import { escapeShellArg, escapePowerShellArg } from './shell-escape.js';

/**
 * Stored member auth env vars (encryptedEnvVars) reach the member's CLI
 * process through a short-lived owner-only FILE, never through the command
 * line: anything in a member-bound command string ends up in the argv of the
 * member's shell (`bash -c <cmd>` / `powershell -c <cmd>`) for the lifetime of
 * the dispatch, readable by every local user via ps or /proc/<pid>/cmdline.
 *
 * The flow (see services/member-secret-env.ts):
 *   1. buildAuthEnvFileContent() renders the values for the member's shell;
 *   2. the file is written over SFTP (remote) or fs (local) -- no argv;
 *   3. buildAuthEnvSourcePrefix() returns a prefix that carries ONLY the file
 *      path: it loads the file into the shell's environment and deletes it
 *      before the CLI starts, so the CLI inherits the variables.
 */

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Decrypted stored auth env vars for the member ({} when none). */
export function decryptAuthEnvVars(agent: Agent): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, encrypted] of Object.entries(agent.encryptedEnvVars ?? {})) {
    if (!ENV_NAME_RE.test(name)) throw new Error(`Invalid stored env var name: ${name}`);
    out[name] = decryptPassword(encrypted);
  }
  return out;
}

/**
 * File content for the member's shell.
 *  - POSIX: `export NAME='value'` lines (single-quoted: fully literal, safe for
 *    any byte including newlines), loaded with `.`.
 *  - PowerShell: `NAME=<base64(utf8 value)>` lines, parsed (never executed --
 *    no execution-policy or quoting exposure).
 */
export function buildAuthEnvFileContent(vars: Record<string, string>, posix: boolean): string {
  const lines = Object.entries(vars).map(([name, value]) => {
    if (!ENV_NAME_RE.test(name)) throw new Error(`Invalid env var name: ${name}`);
    return posix
      ? `export ${name}=${escapeShellArg(value)}`
      : `${name}=${Buffer.from(value, 'utf-8').toString('base64')}`;
  });
  return lines.join('\n') + '\n';
}

/**
 * Command prefix that loads the staged file into the current shell's
 * environment and deletes it. Carries only the file path, never a value.
 * POSIX: a missing/unreadable file short-circuits the `&&` chain (no
 * unauthenticated run). PowerShell: fails loudly with exit 1.
 */
export function buildAuthEnvSourcePrefix(filePath: string, posix: boolean): string {
  if (posix) {
    const q = escapeShellArg(filePath);
    return `. ${q} && rm -f ${q} && `;
  }
  const q = escapePowerShellArg(filePath);
  return `$__fleetEnv = ${q}; try { foreach ($__l in [IO.File]::ReadAllLines($__fleetEnv)) { $__i = $__l.IndexOf('='); if ($__i -gt 0) { [Environment]::SetEnvironmentVariable($__l.Substring(0, $__i), [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($__l.Substring($__i + 1))), 'Process') } } } catch { [Console]::Error.WriteLine('apra-fleet: could not load the member credential file'); exit 1 } finally { Remove-Item -LiteralPath $__fleetEnv -Force -ErrorAction SilentlyContinue }; `;
}
