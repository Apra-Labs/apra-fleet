/**
 * Shell-selected environment prefix builder (F14), member.env ONLY.
 *
 * Renders the member's plaintext `agent.env` map (register_member /
 * update_member's `env` field) in the form the member's ACTUAL shell speaks,
 * for every dispatch site.
 *
 * Stored auth credentials (`agent.encryptedEnvVars`) are NEVER rendered here:
 * anything in a member-bound command string lands in the argv of the member's
 * shell, readable via ps for the whole dispatch. They reach the member CLI
 * through the staged owner-only file (src/services/member-secret-env.ts,
 * stageAuthEnv), which every dispatch site loads AFTER this prefix.
 *
 * Two hard rules encoded here:
 *
 *  1. Form is chosen by isPosixShell(os, shell), NOT by `os === 'windows'`.
 *     A Windows member registered as Git-for-Windows bash speaks POSIX, and
 *     the old os-only branch handed it PowerShell `$env:` syntax that bash
 *     would silently mis-parse (apra-fleet-7dir precedent).
 *
 *  2. Auth credentials WIN a name collision with member.env: a member.env
 *     entry named like a stored credential is DROPPED here. It must never be
 *     able to shadow a stored credential -- that would
 *     let an operator with only update_member rights redirect or blank an
 *     API token for every dispatch to that member.
 *
 * Values are escaped with the shared primitives in shell-escape.ts so the
 * member's shell performs NO expansion on them: a value containing $, a
 * backtick, a backslash, a newline or a single quote arrives at the remote
 * process byte-for-byte as stored.
 */
import type { Agent } from '../types.js';
import type { RemoteOS } from './platform.js';
import type { MemberShell } from '../os/os-commands.js';
import { isPosixShell } from './agent-helpers.js';
import { ENV_NAME_PATTERN } from './env-map-validation.js';
import { escapeShellArgInner, escapePowerShellArgInner } from './shell-escape.js';

export interface EnvPrefixOptions {
  os: RemoteOS;
  shell?: MemberShell;
}

/** A resolved, merged, validated, UNESCAPED name/value pair. */
export interface EnvAssignment {
  name: string;
  value: string;
}

/**
 * Resolve + merge + validate the member's env sources into plain
 * {name, value} pairs, with NO shell escaping applied.
 *
 * Deliberately shell-agnostic: the long_running wrapper generators
 * (src/services/cloud/task-wrapper.ts) embed these assignments INSIDE a
 * script whose language is fixed by the generator, not by the member's
 * interactive shell, so they must do their own escaping. `opts.os`/
 * `opts.shell` therefore have no effect on this function's output -- they
 * are part of the shared options shape only so callers can pass one opts
 * object to either entry point.
 *
 * A name that is also a stored credential name is skipped (auth wins).
 *
 * @throws if any resolved name fails ENV_NAME_PATTERN. A stored bad name is
 *   a loud failure, never a silent skip: the alternative is emitting an
 *   unquotable name straight into a dispatched command string.
 */
export function buildEnvAssignments(agent: Agent, _opts: EnvPrefixOptions): EnvAssignment[] {
  // Auth wins a collision (rule 2): the credential itself is delivered by the
  // staged file (stageAuthEnv), loaded AFTER this prefix, so a member.env
  // entry with a credential's name is dropped here rather than rendered.
  const authNames = new Set(Object.keys(agent.encryptedEnvVars ?? {}));

  const assignments: EnvAssignment[] = [];
  for (const [name, value] of Object.entries(agent.env ?? {})) {
    // Re-validated at BUILD time, not just at store time: a record written
    // by an older/looser build, or hand-edited in registry.json, must not
    // become shell injection at dispatch.
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid env variable name "${name}" for member "${agent.friendlyName ?? agent.id}": ` +
        `names must match ${ENV_NAME_PATTERN} (letters, digits, underscore; cannot start with a digit).`,
      );
    }
    if (authNames.has(name)) continue;
    assignments.push({ name, value });
  }

  return assignments;
}

/**
 * Build an inline env-assignment prefix for the member's shell, ready to be
 * prepended directly to a command string.
 *
 * Trailing-separator contract: the
 * returned string either is empty, or ends in the shell's statement
 * separator (`' && '` / `'; '`) so `prefix + command` is always valid.
 *
 *   POSIX (linux, macos, gitbash-on-Windows):
 *     export NAME='value' && export OTHER='value' &&
 *   PowerShell (Windows without gitbash):
 *     $env:NAME='value'; $env:OTHER='value';
 *
 * Both forms use single quotes, which are fully literal in both shells, so
 * no $, backtick or backslash in a value is ever expanded by the member.
 */
export function buildEnvPrefix(agent: Agent, opts: EnvPrefixOptions): string {
  const assignments = buildEnvAssignments(agent, opts);
  if (assignments.length === 0) return '';

  if (isPosixShell(opts.os, opts.shell)) {
    return assignments
      .map(({ name, value }) => `export ${name}='${escapeShellArgInner(value)}'`)
      .join(' && ') + ' && ';
  }

  return assignments
    .map(({ name, value }) => `$env:${name}='${escapePowerShellArgInner(value)}'`)
    .join('; ') + '; ';
}
