import type { LlmProvider } from '../../types.js';
import { getProvider } from '../../providers/index.js';
import { encodeClaudeProjectDir } from '../../providers/provider.js';

export { encodeClaudeProjectDir };

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
