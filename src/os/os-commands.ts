import { escapeDoubleQuoted, escapeWindowsArg, escapeGrepPattern, sanitizeSessionId } from '../utils/shell-escape.js';

export { escapeDoubleQuoted, escapeWindowsArg, escapeGrepPattern, sanitizeSessionId };

/**
 * Platform-specific command builders.
 * Each OS implements this interface — no switch/if on OS outside this module.
 */
export interface OsCommands {
  // --- Resources ---
  cpuLoad(): string;
  memory(): string;
  disk(folder: string): string;

  // --- Process check ---
  fleetProcessCheck(folder: string, sessionId?: string): string;

  // --- Claude CLI ---
  claudeCommand(args: string): string;
  claudeVersion(): string;
  claudeCheck(): string;
  installClaude(): string;
  updateClaude(): string;

  // --- Filesystem ---
  mkdir(folder: string): string;

  // --- Auth ---
  credentialFileCheck(): string;
  credentialFileWrite(json: string): string;
  credentialFileRemove(): string;
  apiKeyCheck(): string;
  setEnv(name: string, value: string): string[];
  unsetEnv(name: string): string[];
  envPrefix(name: string, value: string): string;

  // --- SSH key deployment ---
  deploySSHPublicKey(publicKeyLine: string): string[];

  // --- Local exec ---
  cleanExec(command: string): { command: string; env?: Record<string, string>; shell?: string };

  // --- Shell ---
  wrapInWorkFolder(folder: string, command: string): string;

  // --- Prompt building ---
  buildPromptCommand(folder: string, b64Prompt: string, sessionId?: string, dangerouslySkipPermissions?: boolean, model?: string): string;

  // --- Resource output parsing ---
  parseMemory(stdout: string): string;
  parseDisk(stdout: string): string;
}
