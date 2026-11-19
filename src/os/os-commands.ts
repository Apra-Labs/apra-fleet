import { escapeDoubleQuoted, escapeWindowsArg, escapeGrepPattern, sanitizeSessionId } from '../utils/shell-escape.js';
import type { ProviderAdapter, PromptOptions as BasePromptOptions } from '../providers/provider.js';
import type { Agent } from '../types.js';

export { escapeDoubleQuoted, escapeWindowsArg, escapeGrepPattern, sanitizeSessionId };
export type { ProviderAdapter };

/** The line gitLsRemoteNonInteractive() prints after a successful ls-remote. */
export const GIT_LS_REMOTE_OK_MARKER = 'FLEET_GIT_LS_REMOTE_OK';

/**
 * Trailing comment on every shell-profile export line the fleet writes
 * (POSIX profiles: linux, macOS, Windows Git Bash). It tells a fleet-written
 * `export NAME=...` line apart from one the machine's owner wrote by hand.
 */
export const FLEET_ENV_MARKER = 'apra-fleet-managed';

export interface UnsetEnvOptions {
  /**
   * Remove EVERY `export NAME=` profile line, marked or not. Only for an
   * explicit act of delivering/replacing that variable (provision_llm_auth).
   * Default (false): remove only the lines the fleet marked as its own.
   */
  all?: boolean;
}

/**
 * The sed address+command unsetEnv uses on POSIX profiles. POSIX bracket
 * classes only (no \s, \+, \?) so GNU sed and BSD sed accept the same text.
 * The marker is not anchored with `$`: a profile an editor turned CRLF would
 * otherwise never match.
 */
export function unsetEnvSedExpr(name: string, opts?: UnsetEnvOptions): string {
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) throw new Error('Invalid env var name: ' + name);
  return opts?.all
    ? `/export ${name}=/d`
    : `/^[[:space:]]*export ${name}=.*# ${FLEET_ENV_MARKER}/d`;
}

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
  /** @deprecated carries `content` in the command line -- use credentialFileInstall. */
  credentialFileWrite(content: string, destPath: string): string;
  /**
   * Move a credential file already staged on the member (strategy.writeSecretFile,
   * owner-only) to `destPath`, owner-only. Carries only paths, never content.
   */
  credentialFileInstall(stagedPath: string, destPath: string): string;
  credentialFileRemove(destPath: string): string;
  /** Rename destPath to destPath+suffix when it exists (reversible removal); prints "moved" when it did. */
  credentialFileMoveAside(destPath: string, suffix: string): string;
  apiKeyCheck(envVarName?: string): string;
  /**
   * Persisting an env var on the member is two-step so the VALUE never sits
   * in a command line: persistEnvFileContent() renders the file content
   * (delivered over SFTP/fs, owner-only), then persistEnvFromFile() returns
   * the command that applies it and deletes the file -- it carries only the
   * file path.
   */
  persistEnvFileContent(name: string, value: string): string;
  persistEnvFromFile(name: string, filePath: string): string;
  /**
   * Commands that remove a persisted env var. POSIX shells: by default only
   * the profile lines carrying FLEET_ENV_MARKER (a hand-written export of the
   * same NAME is left in place); `{ all: true }` removes every
   * `export NAME=` line. Windows PowerShell persists to a User env var, which
   * cannot carry a marker -- `all` has no effect there and the caller must
   * decide (from its own delivery record) whether to unset at all.
   */
  unsetEnv(name: string, opts?: UnsetEnvOptions): string[];

  // --- Git credential helper ---
  //
  // The helper FILE is per member AND label (gitCredentialHelperStem) and is
  // never registered in any git config file: no --global, no --local. A
  // per-OS-user (global) registration was shared by every member running as
  // that user and was overwritten by each provision; a clone-local one is
  // invisible to git processes that run in another repository (e.g. bd/dolt
  // pushing through its own bare cache repo). Git finds the helper through
  // gitCredentialEnvPrefix(), which every fleet dispatch to the member
  // prepends (src/services/vcs-git-env.ts).
  /** Write the helper file for (label, memberId). File only -- touches no git config. */
  gitCredentialHelperWrite(host: string, username: string, token: string, label?: string, scopeUrl?: string, memberId?: string): string;
  /** Delete the helper file for (label, memberId). File only -- touches no git config. */
  gitCredentialHelperRemove(host: string, label?: string, scopeUrl?: string, memberId?: string): string;
  /**
   * Remove a LEGACY helper registered by releases that wrote the per-OS-user
   * global git config: the shared `.fleet-git-credential-<label>` file and its
   * `credential.<scope>.helper` key in the global config. Only for a legacy
   * entry the member's own record names, and only when no other member runs as
   * the same user on the same host (the entry is shared by all of them).
   */
  gitCredentialHelperRemoveLegacyGlobal(host: string, label?: string, scopeUrl?: string): string;
  /**
   * A statement to prepend to a member command (it ends with its own
   * separator) that makes every git process the command starts use exactly the
   * given fleet helpers for their scopes, through the GIT_CONFIG_PARAMETERS
   * environment variable (the form `git -c` itself uses). Per scope an empty
   * value first resets the inherited helper list, then the helpers follow in
   * the given order -- git uses the first that answers. '' for no helpers.
   */
  gitCredentialEnvPrefix(helpers: GitCredentialHelperRegistration[], memberId: string): string;
  /**
   * Runs the credential helper gitCredentialHelperWrite() deployed, so its
   * `password=<token>` line reaches stdout (apra-fleet-3swo.7.3). `path` is the
   * human-readable helper location for error messages.
   *
   * This command's output carries the PLAINTEXT token and is therefore only
   * ever safe to run server-side (strategy.execCommand inside one tool call).
   * It must never be handed to a caller-visible dispatch -- that stdout
   * round-trip is exactly what the server-side credential handoff replaces.
   */
  gitCredentialHelperRead(label?: string, memberId?: string): { command: string; path: string };

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
  /**
   * One command that deletes every authorized_keys line containing `keyMatch`
   * (matched as a fixed string, never a regex) from `<memberHome>/.ssh/authorized_keys`
   * and, on Windows administrator accounts, from ProgramData ssh
   * administrators_authorized_keys -- the same files deploySSHPublicKey writes.
   * `memberHome` is the member's home directory resolved in JS
   * (getMemberHomeDir); the command never expands ~ or a home env var for it.
   * `keyMatch` is untrusted: exactly "<type> <base64>" of a real public key
   * (one space, no comment). Every builder throws on anything else
   * (assertAuthorizedKeyMatch) -- an empty or type-only match would delete
   * every line, or every key of that type.
   */
  removeSSHPublicKey(keyMatch: string, memberHome: string): string;

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

  /**
   * `git ls-remote <url> HEAD` that can never block on a prompt: terminal
   * prompts and Git Credential Manager's interactive UI are both disabled
   * for this one command (GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=never), so
   * a missing or rejected credential fails fast instead of hanging. On
   * success the output ends with the line GIT_LS_REMOTE_OK_MARKER; a caller
   * must treat its absence (or a throw) as a failure. `url` must already be
   * validated by the caller -- it is quoted, not trusted.
   */
  gitLsRemoteNonInteractive(url: string): string;

  /**
   * Authenticated HTTPS GET of `url` with `Authorization: Bearer <token>`.
   * Prints ONLY the numeric HTTP status code (e.g. 200, 401) -- never the
   * response body and never the token. On POSIX the header is fed to curl on
   * stdin from the shell's builtin printf, so the token is not on curl's
   * argv; on PowerShell the request runs in-process (no child argv). The
   * command string itself carries the token, so it IS on the argv of the
   * outer `bash -c` / powershell process that runs it, for the length of the
   * request -- the same exposure as gitCredentialHelperWrite. A transport
   * failure prints a non-numeric line or exits non-zero. Only ever run
   * server-side via strategy.execCommand.
   */
  httpGetStatusWithBearer(url: string, token: string): string;

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
// --- Git credential helper naming / registration (shared by every OS) ---

/** One fleet helper to register for a credential scope URL. */
export interface GitCredentialHelperRegistration {
  scopeUrl: string;
  label: string;
}

const HELPER_LABEL_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HELPER_MEMBER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * File name (no directory, no extension) of the helper deployed for one member
 * and label: `.fleet-git-credential-<label>.<memberId>`. Labels never contain
 * '.', so the name is unambiguous. Without a member id it is the legacy
 * per-OS-user name `.fleet-git-credential-<label>` (or `.fleet-git-credential`
 * with no label either), which several members running as one user shared.
 */
export function gitCredentialHelperStem(label?: string, memberId?: string): string {
  if (label !== undefined && !HELPER_LABEL_RE.test(label)) {
    throw new Error(`Refusing to build a credential helper path for unsafe VCS credential label '${label}' (allowed: letters, digits, '_', '-').`);
  }
  if (memberId !== undefined && !HELPER_MEMBER_ID_RE.test(memberId)) {
    throw new Error(`Refusing to build a credential helper path for unsafe member id '${memberId}' (allowed: letters, digits, '_', '-').`);
  }
  const base = label ? `.fleet-git-credential-${label}` : '.fleet-git-credential';
  return memberId ? `${base}.${memberId}` : base;
}

/**
 * A credential scope URL must survive three quoting layers in
 * gitCredentialEnvPrefix (the member shell's double quotes, the single quotes
 * of GIT_CONFIG_PARAMETERS and git's own `key=value` split), so anything but a
 * plain scheme://host[:port][/path] is refused rather than escaped.
 */
export const SAFE_GIT_CREDENTIAL_SCOPE_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[A-Za-z0-9._~:/@%+,;!*()[\]-]+$/;

export function isSafeGitCredentialScope(scopeUrl: string): boolean {
  return SAFE_GIT_CREDENTIAL_SCOPE_RE.test(scopeUrl);
}

/**
 * Group helpers by scope URL, keeping the given order of scopes and of the
 * helpers inside each scope, and validate every scope and label.
 */
export function groupGitCredentialHelpers(helpers: GitCredentialHelperRegistration[]): Array<{ scopeUrl: string; labels: string[] }> {
  const groups: Array<{ scopeUrl: string; labels: string[] }> = [];
  for (const h of helpers) {
    if (!isSafeGitCredentialScope(h.scopeUrl)) {
      throw new Error(`Refusing to register a git credential helper for unsafe scope URL '${h.scopeUrl}' (expected scheme://host[:port][/path] with no quotes, spaces, '$', '=' or backslashes).`);
    }
    gitCredentialHelperStem(h.label);
    let g = groups.find(x => x.scopeUrl === h.scopeUrl);
    if (!g) { g = { scopeUrl: h.scopeUrl, labels: [] }; groups.push(g); }
    if (!g.labels.includes(h.label)) g.labels.push(h.label);
  }
  return groups;
}
