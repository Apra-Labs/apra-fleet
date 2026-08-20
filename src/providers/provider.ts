import path from 'node:path';
import os from 'node:os';
import type { LlmProvider } from '../types.js';
import type { SSHExecResult } from '../types.js';
import type { PromptErrorCategory } from '../utils/prompt-errors.js';
import { sanitizeSessionId } from '../os/os-commands.js';

export type { LlmProvider };

/** The OS of the machine a resolved path will be USED on (the member's own
 *  machine), which is NOT necessarily the OS this hub process runs on. */
export type TargetOS = 'linux' | 'macos' | 'windows';

/**
 * apra-fleet issue #390: join path segments using the TARGET member's OS
 * convention instead of Node's host-dependent `path.join`.
 *
 * Providers previously built member-side log paths with the default `path`
 * module, so a Windows hub produced backslash-joined paths for a Linux member
 * (and vice versa) -- a path that can never exist on the member, which silently
 * disables stall detection (Claude) or manufactures a false-positive
 * stall kill (AGY/OpenCode).
 *
 * `targetOs === undefined` deliberately keeps the legacy host-convention
 * behavior: that is what LOCAL members want (they run as this process's own
 * user on this process's own OS), and it keeps every pre-existing caller
 * byte-identical.
 */
export function joinForOS(targetOs: TargetOS | undefined, ...segments: string[]): string {
  if (targetOs === 'windows') return path.win32.join(...segments);
  if (targetOs === undefined) return path.join(...segments);
  return path.posix.join(...segments);
}

/**
 * apra-fleet issue #390: normalize the `homeDir` argument of
 * resolveSessionLogPath / resolveSessionLogDir.
 *
 *  - `undefined` -> "caller did not say" -> fall back to this process's home
 *    directory (correct for local members; legacy behavior for everyone else).
 *  - `null`      -> "caller TRIED to resolve the member's home directory and
 *    FAILED" -> there is no honest path to build, so return null and let the
 *    provider report an unresolvable path. Callers must degrade gracefully
 *    (no signal) rather than poll a fabricated host-home path on a remote
 *    machine, which is what produced the false kills this fixes.
 */
export function resolveHomeDir(homeDir: string | null | undefined): string | null {
  if (homeDir === null) return null;
  return homeDir ?? os.homedir();
}

export type SessionIdStrategy =
  | { type: 'caller-minted' }
  | { type: 'provider-minted' };

export function encodeClaudeProjectDir(workFolder: string): string {
  return workFolder.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Build a `--resume <id>` flag with session ID sanitization and quoting.
 * Shared by providers that pass session IDs on the command line (Claude).
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

// apra-fleet-iuc.1 / apra-fleet-ekm: single source of truth for classifying a
// parsed response as turn-limit terminated. The claude provider normalizes
// terminalReason to 'max_turns' when the transcript carried the signal via any
// channel, but we also accept the raw `error_max_turns` subtype directly so
// callers cannot regress by keying off only one field.
export function isMaxTurnsResponse(parsed: ParsedResponse | undefined | null): boolean {
  if (!parsed) return false;
  return parsed.terminalReason === 'max_turns' || parsed.subtype === 'error_max_turns';
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
  /** apra-fleet-9oo: names from the project's .mcp.json that this call just ADDED to
   *  projects[<key>].enabledMcpjsonServers (empty/absent when nothing was added).
   *  Optional so the non-Claude no-op adapters need no change. */
  mcpServersSeeded?: string[];
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
  /** apra-fleet-eft.65.1: CLI flag that grants the dispatched agent Edit/Write
   *  parity for its OWN work folder when running headless with no explicit
   *  unattended mode (a headless `-p` dispatch cannot present a permission prompt,
   *  so file edits of a brand-new file would otherwise hard-block). Scoped to
   *  file-edit tools on the working directory -- it must NOT broaden Bash/network
   *  permissions the way skipPermissionsFlag() does. Optional: providers that have
   *  no such surgical flag omit it (undefined), leaving current behavior unchanged. */
  workspaceEditPermissionFlag?(): string | null;
  /** Resolves the full permission-mode flag string to append for a given
   *  unattended setting, encapsulating this provider's own auto/dangerous
   *  fallback and warning semantics (e.g. AGY has no true auto mode and
   *  falls back to its dangerous flag with a warning; OpenCode has no true
   *  dangerous mode and falls back to --auto). Returns '' when no flag
   *  applies. This is the single source of truth for unattended-mode flag
   *  resolution: both buildPromptCommand() (POSIX, via os/linux.ts) and
   *  os/windows.ts call this instead of re-deriving the branching
   *  themselves, so the two dispatch paths cannot diverge. */
  resolvePermissionFlag(unattended: false | 'auto' | 'dangerous' | undefined): string;

  // Response parsing
  parseResponse(result: SSHExecResult): ParsedResponse;

  // Session management
  supportsResume(): boolean;
  supportsMaxTurns(): boolean;
  resumeFlag(sessionId?: string, resuming?: boolean): string;
  /** Defines whether this provider accepts caller-minted UUIDs or generates session IDs natively. */
  sessionIdStrategy(): SessionIdStrategy;
  /** Resolves the session transcript log path for a given session ID, AS IT EXISTS
   *  ON THE MEMBER'S MACHINE.
   *  @param homeDir  The MEMBER's home directory. `undefined` falls back to this
   *                  process's home dir (correct for local members only); `null`
   *                  means "the member's home dir could not be resolved", and the
   *                  provider returns '' rather than fabricating a host-home path.
   *  @param targetOs The MEMBER's OS, used to pick the path-join convention.
   *                  `undefined` keeps this process's host convention. */
  resolveSessionLogPath(sessionId: string, workFolder: string, homeDir?: string | null, targetOs?: TargetOS): string;
  /** Resolves the project/provider root log directory for watching in-flight activity.
   *  Same `homeDir` / `targetOs` semantics as {@link resolveSessionLogPath}. Returns
   *  null when this provider has no pollable log directory at all, or when the
   *  member's home directory could not be resolved. */
  resolveSessionLogDir(workFolder: string, homeDir?: string | null, targetOs?: TargetOS): string | null;

  // Model tier mapping
  modelTiers(): Record<'cheap' | 'standard' | 'premium', string>;
  modelForTier(tier: 'cheap' | 'standard' | 'premium'): string;
  modelFlag(model: string): string;

  // Agent directory resolution
  /** Returns the project-relative and home-relative paths for an agent file.
   *  project: relative to workFolder (e.g. '.claude/agents/doer.md')
   *  home: relative to ~ (e.g. '.claude/agents/doer.md' or '.config/opencode/agents/doer.md') */
  agentDirectories(agentName: string): { project: string; home: string };

  // Agent file transformation
  /** Transforms agent file content for this provider (e.g. frontmatter conversion).
   *  Default: passthrough (return content unchanged). */
  transformAgent(content: string, relPath: string): string;

  // Agent name CLI flag
  /** Returns the CLI flag/prefix for activating a named agent.
   *  Claude/AGY: '--agent "name"'. Others: ''. */
  agentNameFlag(agentName: string): string;

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
   *  Returns e.g. `-p "LITERAL"` for Claude/AGY/Copilot or `exec "LITERAL"` for Codex. */
  headlessInvocation(promptLiteral: string): string;

  /** Register (or update) this member's apra-fleet MCP endpoint using the provider's own
   *  native mechanism (CLI verb, e.g. Claude's `claude mcp add`; or config-file merge, e.g.
   *  AGY/OpenCode). Optional until every provider's mechanism has been investigated and
   *  implemented -- see docs/member-onboarding-journey.md section 3/3a.
   *  Returns what was done, for logging/audit. */
  registerMcpEndpoint?(opts: RegisterMcpEndpointOptions): Promise<RegisterMcpEndpointResult>;

  /** Optional provider-NATIVE usage/quota read for execute_prompt budget
   *  awareness (apra-fleet-eft.80.2). When implemented, this is the PRIMARY
   *  source of "spent so far" for a member/workspace budget, in the requested
   *  unit ('dollars' or 'tokens'). Providers with no headless-readable
   *  usage/quota signal (see docs/execute-prompt-usage-api-survey.md) omit it
   *  entirely -- budget awareness then falls back to the fleet-side estimated
   *  accumulation (source: 'estimated'). An implementation that exists but
   *  cannot answer at runtime (missing Admin credential, endpoint unreachable)
   *  returns null so the same estimated fallback engages. */
  getUsage?(opts: { agent: import('../types.js').Agent; unit: 'dollars' | 'tokens'; scope: string }): Promise<{ spent: number } | null>;

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


