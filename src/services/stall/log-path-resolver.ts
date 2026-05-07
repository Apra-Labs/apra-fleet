import type { LlmProvider } from '../../types.js';
import { homedir } from 'os';
import { join, basename } from 'path';

export function resolveSessionLogDir(
  provider: LlmProvider,
  workFolder: string,
  homeDir?: string
): string | null {
  const home = homeDir ?? homedir();

  if (provider === 'claude') {
    const projectPathEncoded = workFolder.replace(/[\/\\:]/g, '-');
    return join(home, '.claude', 'projects', projectPathEncoded);
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
    const projectPathEncoded = workFolder.replace(/[\/\\:]/g, '-');
    return join(home, '.claude', 'projects', projectPathEncoded, `${sessionId}.jsonl`);
  }

  if (provider === 'gemini') {
    // Gemini: ~/.gemini/tmp/<project>/chats/<sessionId>.jsonl
    const projectName = workFolder.split(/[\\/]/).pop() ?? 'project';
    return join(home, '.gemini', 'tmp', projectName, 'chats', `${sessionId}.jsonl`);
  }

  throw new Error(`Unknown LLM provider: ${provider}`);
}
