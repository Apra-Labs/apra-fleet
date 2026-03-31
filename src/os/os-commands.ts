import { escapeDoubleQuoted, escapeWindowsArg, escapeGrepPattern, sanitizeSessionId } from '../utils/shell-escape.js';
import type { ProviderAdapter, PromptOptions } from '../providers/provider.js';

export { escapeDoubleQuoted, escapeWindowsArg, escapeGrepPattern, sanitizeSessionId };
export type { ProviderAdapter, PromptOptions };

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

  // --- Generic agent CLI (provider-agnostic) ---
  agentCommand(provider: ProviderAdapter, args: string): string;
  agentVersion(provider: ProviderAdapter): string;
  installAgent(provider: ProviderAdapter): string;
  updateAgent(provider: ProviderAdapter): string;

  // --- Claude CLI (kept for backwards compat — deprecated, use agent* methods) ---
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

  // --- Git credential helper ---
  gitCredentialHelperWrite(host: string, username: string, token: string): string;
  gitCredentialHelperRemove(host: string): string;

  // --- SSH key deployment ---
  deploySSHPublicKey(publicKeyLine: string): string[];

  // --- Local exec ---
  cleanExec(command: string): { command: string; env?: Record<string, string>; shell?: string };

  // --- Shell ---
  wrapInWorkFolder(folder: string, command: string): string;

  // --- Prompt building ---
  /** @deprecated Use provider.buildPromptCommand(opts) wrapped with agentCommand() instead */
  buildPromptCommand(folder: string, b64Prompt: string, sessionId?: string, dangerouslySkipPermissions?: boolean, model?: string, maxTurns?: number): string;
  /** Provider-generic prompt command builder */
  buildAgentPromptCommand(provider: ProviderAdapter, opts: PromptOptions): string;

  // --- GPU activity ---
  gpuProcessCheck(): string;  // outputs "busy"|"idle", exits 2 if nvidia-smi not available
  gpuUtilization(): string;   // outputs GPU utilization 0-100 (integer), or empty if unavailable

  // --- Resource output parsing ---
  parseMemory(stdout: string): string;
  parseDisk(stdout: string): string;
}
