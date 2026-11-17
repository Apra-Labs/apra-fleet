/**
 * Go concurrency default for bd / dolt started on WINDOWS members.
 *
 * Why: on Windows, `bd dolt pull/push` (dolt is a Go program) starts one git
 * process per remote chunk at once; enough concurrent CreateProcess calls fail
 * with ERROR_NOT_ENOUGH_MEMORY ("Not enough memory resources are available to
 * process this command") although plenty of RAM is free. Capping the Go
 * runtime to one OS thread (GOMAXPROCS=1) serialises those spawns and was the
 * evidenced mitigation (upstream: https://github.com/gastownhall/beads/issues/7082;
 * precedent: scripts/rekey-beads-memories.mjs). See docs/troubleshooting.md
 * ("Not enough memory resources").
 * Side effect: the default covers the whole fleet-started Windows session, so
 * Go builds and tests run there are serialized too; override via the member's
 * own GOMAXPROCS (see that docs section).
 *
 * THE RULE (one place): a Windows child env / Windows member shell gets
 * GOMAXPROCS=GO_MAXPROCS_WINDOWS_DEFAULT ONLY when GOMAXPROCS is not already
 * set (unset or empty). An operator value is never overridden. POSIX members
 * are untouched.
 *
 * Where it applies:
 *   - LOCAL Windows members: the child env object (withGoMaxProcsDefault),
 *     used by WindowsCommands.getCleanEnv and WindowsGitBashCommands.cleanExec.
 *   - REMOTE Windows members: the agent launch and execute_command wrapper
 *     strings, where the member's env is only known to the member's own shell.
 *     The snippet is chosen in JS per member shell (PowerShell vs Git Bash),
 *     never a POSIX string sent to PowerShell; it references only the
 *     member's own GOMAXPROCS variable in that shell's own dialect.
 *
 * ASCII only.
 */

export const GO_MAXPROCS_VAR = 'GOMAXPROCS';
export const GO_MAXPROCS_WINDOWS_DEFAULT = '1';

/**
 * Pure: a copy of `env` with GOMAXPROCS defaulted when absent or empty.
 * The lookup is case-insensitive (Windows env names are), so an existing
 * `GoMaxProcs` is honoured rather than duplicated. The input is not mutated.
 */
export function withGoMaxProcsDefault(env: Record<string, string>): Record<string, string> {
  const key = Object.keys(env).find((k) => k.toUpperCase() === GO_MAXPROCS_VAR);
  if (key !== undefined && env[key] !== '') return { ...env };
  const out = { ...env };
  if (key !== undefined) delete out[key];
  out[GO_MAXPROCS_VAR] = GO_MAXPROCS_WINDOWS_DEFAULT;
  return out;
}

/** PowerShell statement (with trailing separator) applying the rule in the member's session. */
export const GO_MAXPROCS_DEFAULT_PWSH =
  `if (-not $env:${GO_MAXPROCS_VAR}) { $env:${GO_MAXPROCS_VAR} = '${GO_MAXPROCS_WINDOWS_DEFAULT}' }; `;

/** Git Bash (POSIX sh) statement (with trailing separator) applying the rule in the member's shell. */
export const GO_MAXPROCS_DEFAULT_GITBASH =
  `[ -n "\${${GO_MAXPROCS_VAR}:-}" ] || export ${GO_MAXPROCS_VAR}=${GO_MAXPROCS_WINDOWS_DEFAULT}; `;
