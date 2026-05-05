import type { LlmProvider } from '../../types.js';
import { homedir } from 'os';
import { join } from 'path';

export function resolveSessionLogPath(
  provider: LlmProvider,
  sessionId: string,
  workFolder: string,
  homeDir?: string
): string {
  const home = homeDir ?? homedir();

  if (provider === 'claude') {
    // Claude: ~/.claude/projects/<project-path-encoded>/<sessionId>.jsonl
    // TODO: Verify exact encoding scheme for project path (currently: replace / and \ with %2F and %5C)
    const projectPathEncoded = workFolder.replace(/\//g, '%2F').replace(/\\/g, '%5C');
    return join(home, '.claude', 'projects', projectPathEncoded, `${sessionId}.jsonl`);
  }

  if (provider === 'gemini') {
    // Gemini: ~/.gemini/tmp/<project>/<sessionId>.jsonl
    // TODO: Verify exact Gemini path structure on live system
    const projectName = workFolder.split(/[\\/]/).pop() ?? 'project';
    return join(home, '.gemini', 'tmp', projectName, `${sessionId}.jsonl`);
  }

  throw new Error(`Unknown LLM provider: ${provider}`);
}
