import type { LlmProvider } from '../types.js';
import type { SSHExecResult } from '../types.js';
import type { PromptErrorCategory } from '../utils/prompt-errors.js';
import { sanitizeSessionId } from '../os/os-commands.js';

export type { LlmProvider };

/**
 * Build a `--resume <id>` flag with session ID sanitization and quoting.
 * Shared by providers that pass session IDs on the command line (Claude, Gemini).
 * @param sessionId - The raw session ID (will be sanitized)
 * @param fallback  - Value to return when sessionId is absent (default: '')
 */
export function buildResumeFlag(sessionId: string | undefined, fallback = ''): string {
  if (sessionId) {
    return `--resume "${sanitizeSessionId(sessionId)}"`;
  }
  return fallback;
}

/**
 * Build a `--session-id <id>` flag for starting a new session with a caller-minted ID.
 * @param sessionId - The raw session ID (will be sanitized)
 */
export function buildSessionIdFlag(sessionId: string): string {
  return `--session-id "${sanitizeSessionId(sessionId)}"`;
}

export interface PromptOptions {
  folder: string;
  promptFile: string;
  sessionId?: string;
  resuming?: boolean;
  unattended?: false | 'auto' | 'dangerous';
  model?: string;
  tier?: 'cheap' | 'standard' | 'premium';
  maxTurns?: number;
  inv?: string;
  agentName?: string;
}

export interface ParsedResponse {
  result: string;
  sessionId?: string;
  isError: boolean;
  raw: string;
  usage?: { input_tokens: number; output_tokens: number };
  /** e.g. 'error_max_turns' -- the CLI result event's own subtype, when present. */
  subtype?: string;
  /** e.g. 'max_turns' -- the CLI result event's own terminal_reason, when present. */
  terminalReason?: string;
}

export interface RegisterMcpEndpointOptions {
  /** e.g. http://<host>:<port>/mcp?member=<member-uuid> */
  url: string;
  /** JWT bearer token for the member's fleet MCP session. */
  token: string;
  workFolder: string;
  scope: 'project' | 'user';
}

export interface RegisterMcpEndpointResult {
  /** e.g. 'cli-verb' (Claude's `claude mcp add`) or 'config-file-merge' (AGY/OpenCode). */
  mechanism: string;
  /** Human-readable detail for logging/audit -- what file or command was used. */
  detail: string;
}

/** Delivery channel for {@link ProviderAdapter.ensureWorkspaceTrusted} -- the SAME
 *  channel compose_permissions' deliverConfigFile already uses (AgentStrategy.execCommand:
 *  SSH for remote members, local shell exec for local members). Kept as a narrow function
 *  type (rather than importing AgentStrategy) so providers.ts has no dependency on
 *  services/strategy.ts. */
export type WorkspaceTrustExecFn = (command: string, timeoutMs?: number) => Promise<SSHExecResult>;

export interface EnsureWorkspaceTrustedResult {
  /** true only when this call just wrote hasTrustDialogAccepted=true because it was
   *  missing. false when the provider no-ops, or when trust was already present. */
  seeded: boolean;
  /** Human-readable detail for logging/audit (apra-fleet-eft.40.1: "log distinctly
   *  when it SEEDS trust vs finds it already present"). */
  detail: string;
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
  /** Returns the CLI flag for unattended='auto', or null if the provider does not support it. */
  permissionModeAutoFlag(): string | null;

  // Response parsing
  parseResponse(result: SSHExecResult): ParsedResponse;

  // Session management
  supportsResume(): boolean;
  supportsMaxTurns(): boolean;
  resumeFlag(sessionId?: string, resuming?: boolean): string;

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
  oauthCredentialFiles(): Array<{ localPath: string; remotePath: string }> | null;
  oauthSettingsMerge(): Record<string, unknown> | null;
  oauthEnvVarsToUnset(): string[];

  /** Returns the correct environment variable name for the given API key/token. */
  authEnvVarForToken(token: string): string;


  // Windows / PowerShell prompt building helpers
  /** On Windows, wrap the command for execution (e.g. via .NET ProcessStartInfo or direct shell). */
  wrapWindowsPrompt(setupCmd: string, filePath: string, argList: string, sessionId?: string, model?: string, tier?: 'cheap' | 'standard' | 'premium'): string;

  /** JSON output flag for the CLI (e.g. --output-format json, --json, --format json) */
  jsonOutputFlag(): string;
  /** Args for headless invocation with a safe literal prompt string.
   *  Returns e.g. `-p "LITERAL"` for Claude/Gemini/Copilot or `exec "LITERAL"` for Codex. */
  headlessInvocation(promptLiteral: string): string;

  /** Register (or update) this member's apra-fleet MCP endpoint using the provider's own
   *  native mechanism (CLI verb, e.g. Claude's `claude mcp add`; or config-file merge, e.g.
   *  AGY/OpenCode). Optional until every provider's mechanism has been investigated and
   *  implemented -- see docs/member-onboarding-journey.md section 3/3a.
   *  Returns what was done, for logging/audit. */
  registerMcpEndpoint?(opts: RegisterMcpEndpointOptions): Promise<RegisterMcpEndpointResult>;

  /** Idempotently ensures `workFolder` is a TRUSTED workspace so this provider honors
   *  composed project-scoped permissions on the member (apra-fleet-eft.40 -- an unattended
   *  member can never click a trust dialog, and its work folder is fleet-managed by
   *  definition, so trust must be seeded programmatically). Scoped STRICTLY to exactly
   *  `workFolder` as resolved on the member -- never a parent directory, never blanket.
   *  `execCommand` is the delivery channel (same one compose_permissions' deliverConfigFile
   *  uses), so this works uniformly for local and remote (SSH) members. Non-Claude
   *  providers no-op -- see each implementation's rationale comment (apra-fleet-eft.40
   *  provider trust matrix). Callers should log distinctly on `seeded: true` vs `false`. */
  ensureWorkspaceTrusted(workFolder: string, execCommand: WorkspaceTrustExecFn, agentOs?: 'linux' | 'macos' | 'windows'): Promise<EnsureWorkspaceTrustedResult>;
}


