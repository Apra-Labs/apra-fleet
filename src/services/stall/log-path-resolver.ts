import type { LlmProvider } from '../../types.js';
import type { TargetOS } from '../../providers/provider.js';
import { getProvider } from '../../providers/index.js';
import { encodeClaudeProjectDir } from '../../providers/provider.js';

export { encodeClaudeProjectDir };

/**
 * apra-fleet issue #390: `homeDir` and `targetOs` describe the MEMBER's machine.
 *  - `homeDir === undefined` -> fall back to this process's home dir (correct
 *    for local members; the legacy behavior for everyone else).
 *  - `homeDir === null` -> the member's home dir could not be resolved; return
 *    null instead of fabricating a hub-home path on a remote machine.
 *  - `targetOs === undefined` -> join with this process's host convention.
 */
export function resolveSessionLogDir(
  provider: LlmProvider,
  workFolder: string,
  homeDir?: string | null,
  targetOs?: TargetOS
): string | null {
  const adapter = getProvider(provider);
  return adapter.resolveSessionLogDir(workFolder, homeDir, targetOs);
}

export function resolveSessionLogPath(
  provider: LlmProvider,
  sessionId: string,
  workFolder: string,
  homeDir?: string | null,
  targetOs?: TargetOS
): string {
  const adapter = getProvider(provider);
  const resolved = adapter.resolveSessionLogPath(sessionId, workFolder, homeDir, targetOs);
  if (!resolved) {
    throw new Error(`Unsupported log polling for provider: ${provider}`);
  }
  return resolved;
}
