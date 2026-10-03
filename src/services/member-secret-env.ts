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

/** Write `content` to a fresh owner-only file on the member; returns its absolute path. */
export async function writeMemberSecretFile(agent: Agent, content: string, kind = 'env'): Promise<string> {
  return getStrategy(agent).writeSecretFile(`.apra-fleet-${kind}-${randomUUID()}`, content);
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
