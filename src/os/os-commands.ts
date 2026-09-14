import { escapeDoubleQuoted, escapeWindowsArg, escapeGrepPattern, sanitizeSessionId } from '../utils/shell-escape.js';
import type { ProviderAdapter, PromptOptions as BasePromptOptions } from '../providers/provider.js';
import type { Agent } from '../types.js';

export { escapeDoubleQuoted, escapeWindowsArg, escapeGrepPattern, sanitizeSessionId };
export type { ProviderAdapter };

/**
 * apra-fleet-lmtg.2: fork descriptor threaded through buildAgentPromptCommand
 * so both POSIX and Windows builders can emit a provider's fork invocation
 * (source-seeded, new-session-id output) instead of the ordinary
 * resume/fresh-session flags that `sessionId`/`resuming` would otherwise
 * produce.
 */
export interface ForkDescriptor {
  /** Existing session id to seed context from -- fed to the provider's
   *  forkFlag() (analogous to the source id a resume flag would reuse). */
  sourceSessionId: string;
  /** Newly minted output session id for the forked conversation, tracked by
   *  the caller (e.g. execute-prompt.ts, for recordKnownSession/bookkeeping).
   *  Passed to the provider's forkFlag() so it is emitted as an explicit
   *  --session-id flag alongside --resume/--fork-session -- the CLI honors a
   *  caller-supplied session id even in fork mode, so we pre-mint it rather
   *  than scraping the id back out of the CLI's response afterward. */
  newSessionId: string;
}

/**
 * PromptOptions extended with an optional fork descriptor. When `fork` is
 * present and the provider is fork-capable (`provider.supportsFork?.()`),
 * buildAgentPromptCommand emits the provider's fork invocation in place of
 * the resume/session-id flags `sessionId`/`resuming` would otherwise
 * produce. When `fork` is absent, generated commands are unchanged.
 */
export interface PromptOptions extends BasePromptOptions {
  fork?: ForkDescriptor;
}

/**
 * The shell a member's OS commands target. Derived from the Agent schema so
 * there is exactly one source of truth for the allowed values (src/types.ts);
 * only meaningful for Windows members today.
 */
export type MemberShell = NonNullable<Agent['shell']>;

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
  gitCredentialHelperWrite(host: string, username: string, token: string, label?: string, scopeUrl?: string): string;
  gitCredentialHelperRemove(host: string, label?: string, scopeUrl?: string): string;

  /** Delete ONLY the pre-label, single-file credential helper
   *  (`.fleet-git-credential`, no label suffix) left behind by installs that
   *  predate labeled credentials. Touches NO git config: the credential-helper
   *  config key is host/scope-scoped rather than label-scoped, so unsetting it
   *  here would clobber whatever credential is CURRENTLY registered for that
   *  host -- see provision-vcs-auth.ts's legacy-migration call site. */
  gitCredentialHelperRemoveLegacyFile(): string;

  /** Log the `gh` CLI itself into GitHub with `token` (persists to gh's own config,
   *  e.g. ~/.config/gh/hosts.yml), independent of the git credential helper above --
   *  `gh` never reads that file. No-ops (does not throw) when `gh` is not installed;
   *  callers should treat this as best-effort. */
  ghAuthLogin(token: string, hostname?: string): string;

  // --- SSH key deployment ---
  deploySSHPublicKey(publicKeyLine: string): string[];

  // --- Local exec ---
  cleanExec(command: string): { command: string; env?: Record<string, string>; shell?: string };

  // --- Shell ---
  wrapInWorkFolder(folder: string, command: string): string;

  /**
   * Wrap a command so it echoes its own root PID (the `FLEET_PID:<pid>`
   * marker already understood by ssh.ts/strategy.ts's stdout scanners) before
   * running. Lets a caller that needs to tree-kill a stuck remote command
   * (apra-fleet-kwx's LocalStrategy fix, mirrored for SSH members) recover a
   * PID to kill even for a plain command that has no PID protocol of its own
   * (unlike buildAgentPromptCommand's provider launches, which already emit
   * this marker).
   */
  wrapPidCapture(command: string): string;

  // --- Prompt building ---
  buildAgentPromptCommand(provider: ProviderAdapter, opts: PromptOptions): string;

  // --- Process management ---
  killPid(pid: number): string;

  // --- Git ---
  gitCurrentBranch(folder: string): string;

  /**
   * Print the `origin` remote's URL for a checkout at `folder`, or NOTHING at
   * all when there is no git repo / no `origin` (an expected, common case --
   * e.g. a member registered before anything was cloned into its work folder).
   * Never fails the command: callers treat empty output as "unknown", not as
   * an error. Falls back to `git config --get remote.origin.url` for the older
   * git builds that predate `remote get-url`.
   */
  gitRemoteOrigin(folder: string): string;

  // --- GPU activity ---
  gpuProcessCheck(): string;  // outputs "busy"|"idle", exits 2 if nvidia-smi not available
  gpuUtilization(): string;   // outputs GPU utilization 0-100 (integer), or empty if unavailable

  // --- Resource output parsing ---
  parseMemory(stdout: string): string;
  parseDisk(stdout: string): string;

  // --- Agent provisioning ---
  /** List "<sha256>  ./<relpath>" for every file under a home-relative dir (recursive). Empty output if dir is missing/empty. */
  hashFilesRecursive(dir: string): string;
}