import type { LlmProvider } from '../../types.js';
import { homedir } from 'os';
import { join, basename } from 'path';

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
  const home = homeDir ?? homedir();

  if (provider === 'claude') {
    return join(home, '.claude', 'projects', encodeClaudeProjectDir(workFolder));
  }

  if (provider === 'gemini') {
    const projectName = basename(workFolder) || 'project';
    return join(home, '.gemini', 'tmp', projectName, 'chats');
  }

  return null;
}

export function resolveSessionLogPath(
  provider: LlmProvider,
  sessionId: string,
  workFolder: string,
  homeDir?: string
): string {
  const home = homeDir ?? homedir();

  if (provider === 'claude') {
    // Claude: ~/.claude/projects/<project-path-encoded>/<sessionId>.jsonl
    return join(home, '.claude', 'projects', encodeClaudeProjectDir(workFolder), `${sessionId}.jsonl`);
  }

  if (provider === 'gemini') {
    // Gemini: ~/.gemini/tmp/<project>/chats/<sessionId>.jsonl
    const projectName = workFolder.split(/[\\/]/).pop() ?? 'project';
    return join(home, '.gemini', 'tmp', projectName, 'chats', `${sessionId}.jsonl`);
  }

  if (provider === 'agy' || provider === 'codex' || provider === 'copilot') {
    throw new Error(`Unsupported log polling for provider: ${provider}`);
  }

  throw new Error(`Unknown LLM provider: ${provider}`);
}
