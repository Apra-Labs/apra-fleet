import type { LlmProvider } from '../../types.js';
import { getProvider } from '../../providers/index.js';

/**
 * Claude Code stores each project's sessions under a single directory named
 * after the project's absolute path, with EVERY non-alphanumeric character
 * replaced by '-' (slashes, backslashes, colons, dots, underscores, spaces...).
 * e.g. /home/ecs_user/vbv_nyk/app -> -home-ecs-user-vbv-nyk-app
 * This must match Claude's own encoding exactly, or the transcript is not found.
 */
export function encodeClaudeProjectDir(workFolder: string): string {
  return workFolder.replace(/[^a-zA-Z0-9]/g, '-');
}

export function resolveSessionLogDir(
  provider: LlmProvider,
  workFolder: string,
  homeDir?: string
): string | null {
  const adapter = getProvider(provider);
  return adapter.resolveSessionLogDir(workFolder, homeDir);
}

export function resolveSessionLogPath(
  provider: LlmProvider,
  sessionId: string,
  workFolder: string,
  homeDir?: string
): string {
  const adapter = getProvider(provider);
  const resolved = adapter.resolveSessionLogPath(sessionId, workFolder, homeDir);
  if (!resolved) {
    throw new Error(`Unsupported log polling for provider: ${provider}`);
  }
  return resolved;
}
