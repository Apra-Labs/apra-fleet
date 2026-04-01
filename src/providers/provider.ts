import type { LlmProvider } from '../types.js';
import type { SSHExecResult } from '../types.js';
import type { PromptErrorCategory } from '../utils/prompt-errors.js';

export type { LlmProvider };

export interface PromptOptions {
  folder: string;
  b64Prompt: string;
  sessionId?: string;
  dangerouslySkipPermissions?: boolean;
  model?: string;
  maxTurns?: number;
}

export interface ParsedResponse {
  result: string;
  sessionId?: string;
  isError: boolean;
  raw: string;
}

export interface ProviderAdapter {
  readonly name: LlmProvider;
  readonly processName: string;
  readonly authEnvVar: string;
  readonly credentialPath: string;
  readonly instructionFileName: string;

  // CLI command building
  cliCommand(args: string): string;
  versionCommand(): string;
  installCommand(os: 'linux' | 'macos' | 'windows'): string;
  updateCommand(): string;

  // Prompt building
  buildPromptCommand(opts: PromptOptions): string;

  // Permission bypass flag
  skipPermissionsFlag(): string;

  // Response parsing
  parseResponse(result: SSHExecResult): ParsedResponse;

  // Session management
  supportsResume(): boolean;
  supportsMaxTurns(): boolean;
  resumeFlag(sessionId?: string): string;

  // Model tier mapping
  modelTiers(): Record<'cheap' | 'standard' | 'premium', string>;
  modelForTier(tier: 'cheap' | 'mid' | 'premium'): string;
  modelFlag(model: string): string;

  // Error classification
  classifyError(output: string): PromptErrorCategory;

  // Permission configuration
  /** Returns the config file path(s) for this provider's permission config (relative to repo root).
   *  Parallel to the array returned by composePermissionConfig(). */
  permissionConfigPaths(): string[];
  /** Returns provider-native permission config for the given role.
   *  Each element corresponds to the path at the same index in permissionConfigPaths().
   *  JSON providers return Record<string, unknown>; TOML providers return a string. */
  composePermissionConfig(role: 'doer' | 'reviewer', allow?: string[]): Array<Record<string, unknown> | string>;

  // Auth capabilities
  supportsOAuthCopy(): boolean;
  supportsApiKey(): boolean;

  // Windows / PowerShell prompt building helpers
  /** JSON output flag for the CLI (e.g. --output-format json, --json, --format json) */
  jsonOutputFlag(): string;
  /** Args for headless invocation with an already-decoded prompt expression (e.g. "$p" on Windows).
   *  Returns e.g. "-p $p" for Claude/Gemini/Copilot or "exec $p" for Codex. */
  headlessInvocation(promptExpr: string): string;
}
