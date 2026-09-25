/**
 * Shell-selected environment prefix builder (F14).
 *
 * Generalises the former auth-only src/utils/auth-env.ts into ONE builder
 * that serves every dispatch site: it merges the member's plaintext
 * `agent.env` map (register_member/update_member's `env` field) with the
 * member's decrypted `agent.encryptedEnvVars` auth credentials, and renders
 * them in the form the member's ACTUAL shell speaks.
 *
 * Two hard rules encoded here:
 *
 *  1. Form is chosen by isPosixShell(os, shell), NOT by `os === 'windows'`.
 *     A Windows member registered as Git-for-Windows bash speaks POSIX, and
 *     the old os-only branch handed it PowerShell `$env:` syntax that bash
 *     would silently mis-parse (apra-fleet-7dir precedent).
 *
 *  2. Auth credentials WIN a name collision with member.env. A member.env
 *     entry must never be able to shadow a stored credential -- that would
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
import { decryptPassword } from './crypto.js';
import { isPosixShell } from './agent-helpers.js';
import { ENV_NAME_PATTERN } from './env-map-validation.js';
import { escapeShellArgInner, escapePowerShellArgInner } from './shell-escape.js';

/** Which of the two env sources to include. Both default to true. */
export interface EnvPrefixInclude {
  /** agent.encryptedEnvVars (decrypted auth credentials). Default true. */
  auth?: boolean;
  /** agent.env (plaintext member env map). Default true. */
  member?: boolean;
}

export interface EnvPrefixOptions {
  os: RemoteOS;
  shell?: MemberShell;
  include?: EnvPrefixInclude;
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
 * Merge order: agent.env first, then auth on top (auth wins collisions).
 *
 * @throws if any resolved name fails ENV_NAME_PATTERN. A stored bad name is
 *   a loud failure, never a silent skip: the alternative is emitting an
 *   unquotable name straight into a dispatched command string.
 */
export function buildEnvAssignments(agent: Agent, opts: EnvPrefixOptions): EnvAssignment[] {
  const includeAuth = opts.include?.auth ?? true;
  const includeMember = opts.include?.member ?? true;

  // Map preserves insertion order, and re-setting an existing key keeps its
  // original position -- so auth overwriting a member.env name replaces the
  // value in place rather than reordering the prefix.
  const merged = new Map<string, string>();

  if (includeMember && agent.env) {
    for (const [name, value] of Object.entries(agent.env)) {
      merged.set(name, value);
    }
  }

  if (includeAuth && agent.encryptedEnvVars) {
    for (const [name, encrypted] of Object.entries(agent.encryptedEnvVars)) {
      merged.set(name, decryptPassword(encrypted));
    }
  }

  const assignments: EnvAssignment[] = [];
  for (const [name, value] of merged) {
    // Re-validated at BUILD time, not just at store time: a record written
    // by an older/looser build, or hand-edited in registry.json, must not
    // become shell injection at dispatch.
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid env variable name "${name}" for member "${agent.friendlyName ?? agent.id}": ` +
        `names must match ${ENV_NAME_PATTERN} (letters, digits, underscore; cannot start with a digit).`,
      );
    }
    assignments.push({ name, value });
  }

  return assignments;
}

/**
 * Build an inline env-assignment prefix for the member's shell, ready to be
 * prepended directly to a command string.
 *
 * Trailing-separator contract (unchanged from buildAuthEnvPrefix): the
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
