import { z } from 'zod';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { getAgentOS, getAgentShell, isPosixShell } from '../utils/agent-helpers.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { escapeShellArg, escapePowerShellArg, escapeShellArgInner, escapePowerShellArgInner } from '../utils/shell-escape.js';
import { logLine } from '../utils/log-helpers.js';
import type { Agent } from '../types.js';

/**
 * Server-side VCS credential handoff (apra-fleet-3swo.7.3).
 *
 * BEFORE: the only way an orchestrator-side caller could run a
 * credential-requiring git/VCS command was to first LEARN the token --
 * fleet-sprint's readMemberVcsCredentialToken dispatches the deployed
 * git-credential-helper as a member command and parses `password=<token>` out
 * of the captured stdout. Even dispatched with silent:true, the plaintext
 * still round-trips through a command result the orchestrator reads.
 *
 * NOW: the caller sends the command it already builds (VCSModule's
 * buildCreatePrCommand and friends) with a literal placeholder where the
 * token belongs -- `{{vcs_token}}` for a bare reference or
 * `{{vcs_token_inline}}` for one sitting inside the caller's own single
 * quotes (apra-fleet-3swo.7.16; see VCS_TOKEN_INLINE_PLACEHOLDER below) --
 * and the SERVER performs the whole handoff inside this one call:
 *
 *   1. runs the member's deployed credential helper through
 *      strategy.execCommand -- that output is consumed in-process and is
 *      NEVER part of this tool's result;
 *   2. substitutes whichever placeholder(s) are present with the token,
 *      escaped for the member's OWN shell (the same isPosixShell branch
 *      execute_command uses for {{secure.NAME}}) -- `{{vcs_token}}` gets the
 *      fully-quoted form, `{{vcs_token_inline}}` gets the bare interior
 *      escaping with no quotes of its own;
 *   3. dispatches the substituted command;
 *   4. redacts any occurrence of the token from stdout/stderr before
 *      returning, the same defence execute-command.ts's redactOutput applies.
 *
 * The plaintext token therefore appears in no field of any result an
 * orchestrator-side caller can read. readMemberVcsCredentialToken is
 * deliberately left in place; retiring it is a separate task.
 */

/**
 * Reference this one BARE (never inside your own quotes): the substituted
 * value arrives ALREADY shell-escaped for the member's shell (quotes
 * included), exactly like execute_command's {{secure.NAME}} tokens --
 * wrapping it in the caller's own quotes double-escapes it and surfaces as a
 * false 401 / invalid-token error.
 */
export const VCS_TOKEN_PLACEHOLDER = '{{vcs_token}}';

/**
 * Reference this one INSIDE your own single quotes (e.g.
 * `'Authorization: Bearer {{vcs_token_inline}}'`): the substituted value is
 * escaped for the INTERIOR of a single-quoted string in the member's shell
 * dialect and carries no quotes of its own, for callers (like VCSModule's
 * provider command builders) that must interpolate the token into a larger
 * already-quoted value rather than reference it as a free-standing word.
 * Using `{{vcs_token}}` in that position double-escapes it the same way
 * wrapping it in extra quotes would; use this placeholder there instead.
 *
 * Whether a given occurrence really sits inside the caller's open quotes is
 * not reliably decidable from the command string alone, so this tool does
 * not attempt to validate placement -- a heuristic here would produce false
 * refusals. The contract is documented, not enforced (apra-fleet-3swo.7.16).
 */
export const VCS_TOKEN_INLINE_PLACEHOLDER = '{{vcs_token_inline}}';

export const vcsCredentialExecSchema = z.object({
  ...memberIdentifier,
  command: z.string().min(1).describe(
    'The credential-requiring command to run on the member. MUST contain at least one of two '
    + 'placeholders where the credential belongs: {{vcs_token}}, referenced BARE (never inside your '
    + 'own quotes) -- the server substitutes it with the value already escaped AND quoted for the '
    + 'member\'s shell; or {{vcs_token_inline}}, referenced INSIDE your own single quotes -- the '
    + 'server substitutes it with the value escaped for the interior of a single-quoted string, with '
    + 'no quotes of its own (use this one when the token must be interpolated into a larger quoted '
    + 'value, e.g. an Authorization header). Both may appear in the same command. '
    + 'The plaintext credential never leaves the server and never appears in this tool\'s result.'
  ),
  label: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/).optional().describe(
    'Credential label the helper was deployed under by provision_vcs_auth (defaults to the '
    + 'provider name there, e.g. "github" or "azure-devops"). Omit to use the unlabelled helper.'
  ),
  timeout_s: z.number().int().positive().max(600).optional().describe(
    'Timeout in seconds for the credential-requiring command (default: 120).'
  ),
});

export type VcsCredentialExecInput = z.infer<typeof vcsCredentialExecSchema>;

export type VcsCredentialExecReason =
  /** The command ran (inspect exitCode for its own success). */
  | 'ok'
  /** No member matched member_id/member_name. */
  | 'member_not_found'
  /** `command` contained neither {{vcs_token}} nor {{vcs_token_inline}}. */
  | 'placeholder_missing'
  /** This member's OS/shell has no credential-read implementation. */
  | 'unsupported_member_os'
  /** Running the credential helper on the member failed. */
  | 'credential_read_failed'
  /** The helper ran but printed no usable password= line. */
  | 'credential_empty'
  /** Dispatching the credential-requiring command threw. */
  | 'dispatch_failed';

interface VcsCredentialExecFields {
  /** True when the credential-requiring command was dispatched. Read exitCode for its outcome. */
  ok: boolean;
  /** Machine-readable outcome code. Branch on this, never on `text`. */
  reason: VcsCredentialExecReason;
  /** Exit code of the dispatched command, or null when it never ran. */
  exitCode: number | null;
  /** Command stdout with every occurrence of the credential redacted. */
  stdout: string;
  /** Command stderr with every occurrence of the credential redacted. */
  stderr: string;
  /**
   * How many times the credential had to be redacted out of stdout+stderr.
   * Normally 0; a nonzero count means the dispatched command echoed its own
   * credential back and the redaction earned its keep.
   */
  tokenRedactions: number;
  /** Credential label used, or null for the unlabelled helper. */
  credentialLabel: string | null;
  /** Registry id of the resolved member, or null. */
  memberId: string | null;
  /** Friendly name of the resolved member, or null. */
  memberName: string | null;
}

export interface VcsCredentialExecStructured extends VcsCredentialExecFields {
  [key: string]: unknown;
}

export interface VcsCredentialExecResult {
  text: string;
  structuredContent: VcsCredentialExecStructured;
}

const REDACTION = '[REDACTED:vcs_token]';

function execResult(
  text: string,
  fields: Partial<VcsCredentialExecFields> & { reason: VcsCredentialExecReason },
): VcsCredentialExecResult {
  return {
    text,
    structuredContent: {
      ok: fields.ok ?? fields.reason === 'ok',
      reason: fields.reason,
      exitCode: fields.exitCode ?? null,
      stdout: fields.stdout ?? '',
      stderr: fields.stderr ?? '',
      tokenRedactions: fields.tokenRedactions ?? 0,
      credentialLabel: fields.credentialLabel ?? null,
      memberId: fields.memberId ?? null,
      memberName: fields.memberName ?? null,
    },
  };
}

/** Replace every occurrence of `secret` in `output`, and report how many. */
function redactToken(output: string, secret: string): { text: string; count: number } {
  if (!secret) return { text: output, count: 0 };
  const parts = output.split(secret);
  return { text: parts.join(REDACTION), count: parts.length - 1 };
}

export async function vcsCredentialExec(input: VcsCredentialExecInput): Promise<VcsCredentialExecResult> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') {
    return execResult(agentOrError, {
      reason: 'member_not_found',
      memberId: input.member_id ?? null,
      memberName: input.member_name ?? null,
    });
  }
  const agent = agentOrError as Agent;
  const who = { memberId: agent.id, memberName: agent.friendlyName, credentialLabel: input.label ?? null };

  // Refusing a command with neither placeholder is what keeps this tool a
  // credential handoff rather than a second, unguarded execute_command.
  const hasBare = input.command.includes(VCS_TOKEN_PLACEHOLDER);
  const hasInline = input.command.includes(VCS_TOKEN_INLINE_PLACEHOLDER);
  if (!hasBare && !hasInline) {
    return execResult(
      `[FAIL] command must contain ${VCS_TOKEN_PLACEHOLDER} or ${VCS_TOKEN_INLINE_PLACEHOLDER} -- use execute_command for a command that needs no credential.`,
      { ...who, reason: 'placeholder_missing' },
    );
  }

  const agentOs = getAgentOS(agent);
  const agentShell = getAgentShell(agent);
  const cmds = getOsCommands(agentOs, agentShell);
  const strategy = getStrategy(agent);

  // A member OS/shell with no credential-read implementation is a HARD
  // failure with a surfaced error, never an advisory warning that lets the
  // caller proceed credential-less.
  let read: { command: string; path: string };
  try {
    read = cmds.gitCredentialHelperRead(input.label);
  } catch (err: any) {
    return execResult(
      `[FAIL] Cannot read a VCS credential on "${agent.friendlyName}" (os=${agentOs} shell=${agentShell ?? 'default'}): ${err.message}`,
      { ...who, reason: 'unsupported_member_os' },
    );
  }

  // STEP 1 -- read the credential SERVER-SIDE. This result is consumed
  // in-process and is never placed in the payload returned below.
  let token = '';
  try {
    const readRes = await strategy.execCommand(read.command, 15000);
    if (readRes.code !== 0) {
      return execResult(
        `[FAIL] Failed to read the VCS credential for "${agent.friendlyName}" from '${read.path}' (exit ${readRes.code}).`,
        { ...who, reason: 'credential_read_failed', exitCode: readRes.code },
      );
    }
    const m = /^password=(.*)$/m.exec(readRes.stdout || '');
    token = m ? m[1].trim() : '';
  } catch (err: any) {
    return execResult(
      `[FAIL] Failed to read the VCS credential for "${agent.friendlyName}" from '${read.path}': ${err.message}`,
      { ...who, reason: 'credential_read_failed' },
    );
  }
  if (!token) {
    return execResult(
      `[FAIL] The VCS credential for "${agent.friendlyName}" was empty or unreadable (expected a 'password=' line from '${read.path}'). Re-run provision_vcs_auth.`,
      { ...who, reason: 'credential_empty' },
    );
  }

  // STEP 2 -- substitute, escaped for the member's OWN shell. A Windows
  // member registered with shell=gitbash runs bash, so it needs POSIX
  // escaping even though its OS is windows; isPosixShell owns that decision
  // for every consumer. The bare placeholder gets the fully-quoted form; the
  // inline placeholder gets the SAME dialect's interior-only escaping, with
  // no wrapping quotes of its own, so it composes inside the caller's
  // already-open single quotes instead of double-escaping.
  const posix = isPosixShell(agentOs, agentShell);
  const escaped = posix ? escapeShellArg(token) : escapePowerShellArg(token);
  const escapedInline = posix ? escapeShellArgInner(token) : escapePowerShellArgInner(token);
  const finalCommand = input.command
    .replaceAll(VCS_TOKEN_PLACEHOLDER, escaped)
    .replaceAll(VCS_TOKEN_INLINE_PLACEHOLDER, escapedInline);

  // STEP 3 -- dispatch. Only the log-safe form (placeholder still in place) is
  // ever logged; `finalCommand` is never written anywhere.
  logLine('vcs_credential_exec', `label=${input.label ?? '(default)'} command=${input.command.slice(0, 120)}`, agent);
  let code: number;
  let stdout: string;
  let stderr: string;
  try {
    const res = await strategy.execCommand(finalCommand, (input.timeout_s ?? 120) * 1000);
    code = res.code;
    stdout = res.stdout ?? '';
    stderr = res.stderr ?? '';
  } catch (err: any) {
    // The thrown message can quote the command that failed, so it is redacted
    // on the same footing as stdout/stderr.
    const redactedErr = redactToken(String(err?.message ?? err), token);
    return execResult(
      `[FAIL] Command dispatch failed on "${agent.friendlyName}": ${redactedErr.text}`,
      { ...who, reason: 'dispatch_failed', stderr: redactedErr.text, tokenRedactions: redactedErr.count },
    );
  }

  // STEP 4 -- defence in depth: the command itself may echo the credential
  // back (a curl -v, a git error quoting the remote URL), so scrub both
  // streams before anything is returned.
  const outRedacted = redactToken(stdout, token);
  const errRedacted = redactToken(stderr, token);

  return execResult(
    `[OK] Ran credential-requiring command on "${agent.friendlyName}" (exit ${code}).`,
    {
      ...who,
      reason: 'ok',
      exitCode: code,
      stdout: outRedacted.text,
      stderr: errRedacted.text,
      tokenRedactions: outRedacted.count + errRedacted.count,
    },
  );
}
