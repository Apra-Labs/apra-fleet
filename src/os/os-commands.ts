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
  fleetProcessCheck(folder: string, sessionId?: string, processName?: string): string;

  // --- Generic agent CLI (provider-agnostic) ---
  agentCommand(provider: ProviderAdapter, args: string): string;
  agentVersion(provider: ProviderAdapter): string;
  installAgent(provider: ProviderAdapter): string;
  updateAgent(provider: ProviderAdapter): string;

  // --- Filesystem ---
  mkdir(folder: string): string;
  readTextFile(destPath: string): string;
  writeTextFile(destPath: string, content: string): string;
  readRemoteJson(destPath: string): string;
  deepMergeJson(destPath: string, newObj: Record<string, unknown>): string;

  // --- Auth ---
  credentialFileCheck(destPath: string): string;
  credentialFileWrite(content: string, destPath: string): string;
  credentialFileRemove(destPath: string): string;
  apiKeyCheck(envVarName?: string): string;
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
  buildAgentPromptCommand(provider: ProviderAdapter, opts: PromptOptions): string;

  // --- Process management ---
  killPid(pid: number): string;

  // --- Git ---
  gitCurrentBranch(folder: string): string;

  // --- GPU activity ---
  gpuProcessCheck(): string;  // outputs "busy"|"idle", exits 2 if nvidia-smi not available
  gpuUtilization(): string;   // outputs GPU utilization 0-100 (integer), or empty if unavailable

  // --- Resource output parsing ---
  parseMemory(stdout: string): string;
  parseDisk(stdout: string): string;
}