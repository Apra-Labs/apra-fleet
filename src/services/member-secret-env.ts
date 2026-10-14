import { randomUUID } from 'node:crypto';
import type { Agent } from '../types.js';
import { isPosixShellMember } from '../utils/agent-helpers.js';
import { decryptAuthEnvVars, buildAuthEnvFileContent, buildAuthEnvSourcePrefix } from '../utils/auth-env.js';
import { getStrategy } from './strategy.js';

/**
 * Delivery of secret VALUES to a member without ever placing them in a
 * member-bound command string (which becomes the argv of the member's shell,
 * readable by every local user via ps / /proc/<pid>/cmdline for as long as
 * the command runs).
 *
 * A value is written to an owner-only file through the member's strategy
 * (SFTP for remote members, fs for local ones; relay members fail loudly);
 * the command only ever references the file's path. The file name is random
 * and carries no part of the secret.
 */

/** The remedy any caller surfaces when stored credentials cannot be delivered. */
export const CLEAR_STORED_CREDENTIALS_HINT =
  'or clear the member\'s stored credentials with provision_llm_auth {clear_stored_credentials: true} '
  + '(registry only; then provide the credential in that machine\'s own environment)';

/**
 * A secret could not be delivered to the member without a command line --
 * deterministic (relay member, SFTP subsystem disabled, ...), so callers must
 * classify it before dispatch and never retry it.
 */
export class SecretDeliveryError extends Error {
  readonly reason = 'secret_delivery_unavailable' as const;
  constructor(agent: Agent, cause: string) {
    const remedy = agent.agentType === 'relay'
      ? `Relay members have no channel that delivers a credential without a command line; ${CLEAR_STORED_CREDENTIALS_HINT}.`
      : `Enable the SFTP subsystem on the member's sshd (sshd_config: "Subsystem sftp <path-to-sftp-server>" or "Subsystem sftp internal-sftp", then restart sshd), ${CLEAR_STORED_CREDENTIALS_HINT}.`;
    super(`Cannot deliver a credential to "${agent.friendlyName}" without exposing it on a command line (${cause}). ${remedy}`);
    this.name = 'SecretDeliveryError';
  }
}

/** Write `content` to a fresh owner-only file on the member; returns its absolute path. */
export async function writeMemberSecretFile(agent: Agent, content: string, kind = 'env'): Promise<string> {
  try {
    return await getStrategy(agent).writeSecretFile(`.apra-fleet-${kind}-${randomUUID()}`, content);
  } catch (err) {
    if (err instanceof SecretDeliveryError) throw err;
    throw new SecretDeliveryError(agent, (err as Error)?.message ?? String(err));
  }
}

/** Best-effort removal of a file written by writeMemberSecretFile. */
export async function removeMemberSecretFile(agent: Agent, filePath: string): Promise<void> {
  try { await getStrategy(agent).removeSecretFile(filePath); } catch { /* best-effort */ }
}

export interface StagedAuthEnv {
  /** Prepend to the member command; '' when there is nothing to deliver. */
  prefix: string;
  /** The staged file (the prefix deletes it once loaded); null when none. */
  path: string | null;
}

/**
 * Stage the member's stored auth env vars (encryptedEnvVars) for ONE command.
 * The returned prefix loads the file and deletes it, so every attempt (each
 * retry included) must stage its own file.
 */
export async function stageAuthEnv(agent: Agent): Promise<StagedAuthEnv> {
  return stageEnvVars(agent, decryptAuthEnvVars(agent));
}

/** stageAuthEnv for an explicit set of values (e.g. a key being provisioned). */
export async function stageEnvVars(agent: Agent, vars: Record<string, string>): Promise<StagedAuthEnv> {
  if (Object.keys(vars).length === 0) return { prefix: '', path: null };
  const posix = isPosixShellMember(agent);
  const filePath = await writeMemberSecretFile(agent, buildAuthEnvFileContent(vars, posix), 'env');
  return { prefix: buildAuthEnvSourcePrefix(filePath, posix), path: filePath };
}
