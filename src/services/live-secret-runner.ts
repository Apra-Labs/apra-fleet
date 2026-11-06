import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gitBashCandidates } from '../os/git-bash-candidates.js';
import {
  defaultIsFile,
  envValue,
  resolveGitBashExecutable,
  windowsSystemTool,
  type WindowsSystemTool,
} from '../os/windows-executable.js';
import { formatSecretToken } from './secret-token.js';

/**
 * Runs a live secret's script once and returns the token it mints.
 *
 * Contract: the script gets FLEET_CREDENTIAL (its own name) plus one env var per
 * bound secret, and stdin is closed. It prints
 * {"token":"...","expires_at":"<ISO 8601 with zone>"} on stdout and exits 0.
 *
 * A bound value only ever travels in the child's environment: inline scripts
 * reference it through an env var, and script files receive it in the env var
 * named at registration. It is never on a command line.
 *
 * Every failure is a LiveSecretError that names the secret and a fixed reason.
 * Neither the token, the script's stdout nor its stderr ever reaches an error or
 * a log line: stderr is drained and discarded.
 *
 * Carried over from the TokenSource runner (commit 0f7e129a).
 */

export const E_LIVE_SECRET = 'E-LIVE-SECRET';

export const DEFAULT_LIVE_SECRET_TIMEOUT_MS = 30_000;
/** Largest stdout a script may print. A token response is a few KB at most. */
export const DEFAULT_LIVE_SECRET_MAX_OUTPUT_BYTES = 64 * 1024;
const KILL_TREE_TIMEOUT_MS = 10_000;

/** ISO 8601 date-time with an explicit zone (Z or +hh:mm), so it is never read as local time. */
const ISO_8601_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

export type LiveSecretReasonCode =
  | 'timeout'
  | 'output-too-large'
  | 'exit-nonzero'
  | 'killed'
  | 'start-failed'
  | 'output-not-json'
  | 'output-not-object'
  | 'no-token'
  | 'bad-token'
  | 'no-expiry'
  | 'bad-expiry'
  | 'past-expiry'
  | 'bound-secret-missing'
  | 'bound-secret-unreadable'
  | 'backoff'
  | 'unexpected';

export class LiveSecretError extends Error {
  readonly code = E_LIVE_SECRET;

  constructor(
    readonly credential: string,
    readonly reasonCode: LiveSecretReasonCode,
    readonly reason: string,
    /** The script's exit code, when it ran to an exit. */
    readonly exitCode: number | null = null,
  ) {
    super(`${E_LIVE_SECRET}: live secret '${credential}' failed: ${reason}`);
    this.name = 'LiveSecretError';
  }
}

export interface LiveToken {
  token: string;
  /** The script's expires_at, as printed (ISO 8601 with a zone). */
  expiresAt: string;
}

/** One bound secret: the env var that carries it into the script, and its name. */
export interface LiveSecretBinding {
  env: string;
  secret: string;
}

/** What to run: an inline script, or a program plus argv. */
export interface LiveSecretSource {
  inline?: string;
  program?: string;
  args?: string[];
  bindings: LiveSecretBinding[];
}

export interface LiveInvocation {
  file: string;
  args: string[];
  /** Windows only: hand args to cmd.exe as-is (the command line is already quoted). */
  windowsVerbatimArguments: boolean;
  /** With verbatim arguments, the program as it appears first on the command line. */
  argv0?: string;
  /** Env vars the launcher itself needs. Never a bound secret. */
  env?: Record<string, string>;
}

export interface RunLiveSecretOptions {
  /** Live secret name: passed as FLEET_CREDENTIAL and named in every error. */
  credential: string;
  invocation: LiveInvocation;
  /** Env vars added for this run (the bound secrets). */
  env?: Record<string, string>;
  /** The script's working folder. */
  cwd?: string;
  /** Kills the whole process tree after this long. Default 30000. */
  timeoutMs?: number;
  /** Stdout beyond this many bytes kills the tree and fails. Default 64 KiB. */
  maxOutputBytes?: number;
}

/**
 * The env var that carries bound secret `name` into an inline script: a `-`,
 * legal in a secret name but not in a shell variable name, becomes `_`.
 */
export function envVarForSecret(name: string): string {
  return `FLEET_SECRET_${name.replace(/-/g, '_')}`;
}

/**
 * Rewrite each {{secret.R}} in an inline script to a reference to its env var.
 * The result holds no value, so it needs no escaping and is safe on a command line.
 */
export function rewriteInlineScript(script: string, bindings: LiveSecretBinding[], platform: NodeJS.Platform): string {
  let out = script;
  for (const { env, secret } of bindings) {
    // Braced on PowerShell: `$env:NAME_x` would read a different variable when a
    // word character follows the placeholder. The bash form is delimited by its quote.
    const reference = platform === 'win32' ? `\${env:${env}}` : `"$${env}"`;
    out = out.replaceAll(formatSecretToken(secret), reference);
  }
  return out;
}

/** True for a program Windows can only start through cmd.exe. */
export function isBatchProgram(program: string): boolean {
  return /\.(cmd|bat)$/i.test(program);
}

/**
 * Quote one argument (or the program path) for a cmd.exe /c command line that
 * starts a .cmd/.bat file which may forward its arguments (%*) to a native
 * program. The only quoting function for that path: no text reaches cmd.exe
 * except through it.
 *
 * - Always wrapped in double quotes, so & | < > ( ) ^ ! and spaces are inert
 *   for cmd.exe -- both on the /c line and when the batch file re-parses %*.
 * - An embedded " becomes "" so cmd.exe's quote state never flips (a \" would
 *   flip it and expose what follows); the receiving program's argv parser
 *   reads "" inside quotes as one literal ".
 * - % becomes %%cd:~,% : cmd.exe expands %NAME% even inside quotes, and the
 *   inserted empty expansion %cd:~,% splits any variable name so the % stays
 *   literal.
 * - Backslashes are literal unless they precede a " (embedded or the closing
 *   one), where they are doubled (argv-parser rule), so a trailing backslash
 *   cannot escape the closing quote.
 * - CR, LF and NUL cannot be carried through cmd.exe at all and throw.
 *
 * The same scheme Rust's std uses for batch files after CVE-2024-24576. ! is
 * neutralised by launching cmd.exe with /v:off (see buildProgramInvocation).
 */
export function quoteCmdArg(arg: string): string {
  if (/[\r\n\0]/.test(arg)) {
    throw new Error('an argument for a .cmd/.bat script must not contain a line break or NUL');
  }
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2) + '""';
    } else if (ch === '%') {
      out += '\\'.repeat(backslashes) + '%%cd:~,%';
    } else {
      out += '\\'.repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  return out + '\\'.repeat(backslashes * 2) + '"';
}

/**
 * Quote one argument for the command line of an MSYS program started from a
 * Windows process, as Git for Windows' bash parses it: inside double quotes "" is
 * a literal " and \\ a literal \, and * and ? stay literal. Node's own quoting
 * (\") splits an argument there.
 */
export function quoteMsysArg(arg: string): string {
  return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '""')}"`;
}

/** The absolute system tools an invocation may need. Injected by tests. */
export type ToolResolver = (tool: WindowsSystemTool) => string | null;

function requireTool(tool: WindowsSystemTool, resolve: ToolResolver): string {
  const found = resolve(tool);
  if (!found) throw new Error(`${tool}.exe was not found under SystemRoot or on an absolute PATH entry`);
  return found;
}

const POWERSHELL_FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

export type LiveLauncherReason = 'script-type-unsupported' | 'launcher-not-found' | 'script-not-executable';

/** A script file this OS cannot start. The message names the requirement, never a value. */
export class LiveLauncherError extends Error {
  constructor(readonly reasonCode: LiveLauncherReason, message: string) {
    super(message);
    this.name = 'LiveLauncherError';
  }
}

/** What starting a script file depends on, beyond the system tools. Injected by tests. */
export interface ScriptLaunchers {
  /** Windows: Git for Windows' bash, as an absolute path. */
  gitBash: () => string | null;
  /** Linux/macOS: pwsh, as an absolute path. */
  pwsh: () => string | null;
  /** Linux/macOS: true for an existing file with no execute permission for this user. */
  lacksExecuteBit: (p: string) => boolean;
}

/** An absolute pwsh: the usual install folders, else an absolute PATH entry. */
export function resolvePosixPwsh(
  envPath: string | undefined = process.env.PATH,
  isFile: (p: string) => boolean = fileExists,
): string | null {
  const dirs = ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/opt/microsoft/powershell/7', ...(envPath ?? '').split(':').filter((d) => path.posix.isAbsolute(d))];
  for (const dir of dirs) {
    const candidate = path.posix.join(dir, 'pwsh');
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function lacksExecuteBit(p: string): boolean {
  if (!fileExists(p)) return false;
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return false;
  } catch {
    return true;
  }
}

const DEFAULT_LAUNCHERS: ScriptLaunchers = {
  gitBash: () => resolveGitBashExecutable({
    candidates: gitBashCandidates(envValue(process.env, 'LOCALAPPDATA')),
    pathValue: envValue(process.env, 'PATH'),
    isFile: defaultIsFile,
  }),
  pwsh: () => resolvePosixPwsh(),
  lacksExecuteBit,
};

function requireLauncher(found: string | null, message: string): string {
  if (!found) throw new LiveLauncherError('launcher-not-found', message);
  return found;
}

/**
 * How to start a script file. Platform is a parameter so every branch is
 * unit-testable on any host. Bound secrets reach every form the same way, in the
 * child's env; args stay a list, and go through no shell parsing of their text
 * except where quoteCmdArg says.
 *
 * Windows:
 * - .cmd/.bat: cmd.exe /d /v:off /s /c "<quoted line>" with verbatim arguments.
 *   Node will not spawn a batch file without a shell (CVE-2024-27980), so every
 *   piece goes through quoteCmdArg. /d skips AutoRun, /v:off disables delayed (!)
 *   expansion, /s strips exactly the outer quote pair.
 * - .ps1: powershell.exe -File.
 * - .sh: Git for Windows' bash, never the WSL launcher, with a command line from
 *   quoteMsysArg, because MSYS parses its own command line differently from
 *   every other Windows program.
 *
 * Linux and macOS:
 * - .cmd/.bat: refused.
 * - .ps1: pwsh -File.
 * - .sh without the execute bit: /bin/sh. With it: started directly, so its
 *   shebang decides.
 * - Any other file without the execute bit: refused, instead of a bare EACCES.
 *
 * Anything else (.exe, POSIX programs and scripts): spawned directly with argv,
 * no shell.
 */
export function buildProgramInvocation(
  program: string,
  args: string[],
  platform: NodeJS.Platform,
  resolveTool: ToolResolver = windowsSystemTool,
  launchers: ScriptLaunchers = DEFAULT_LAUNCHERS,
): LiveInvocation {
  const isPs1 = /\.ps1$/i.test(program);
  const isSh = /\.sh$/i.test(program);
  if (platform === 'win32') {
    if (isBatchProgram(program)) {
      const line = [program, ...args].map(quoteCmdArg).join(' ');
      return {
        file: requireTool('cmd', resolveTool),
        args: ['/d', '/v:off', '/s', '/c', `"${line}"`],
        windowsVerbatimArguments: true,
      };
    }
    if (isPs1) {
      return {
        file: requireTool('powershell', resolveTool),
        args: [...POWERSHELL_FLAGS, '-File', program, ...args],
        windowsVerbatimArguments: false,
      };
    }
    if (isSh) {
      const bash = requireLauncher(launchers.gitBash(), 'a .sh script on Windows needs Git for Windows (its bash.exe); the WSL bash is not used. Install it, or use a .ps1, .bat or .cmd script');
      const msys = envValue(process.env, 'MSYS');
      return {
        file: bash,
        args: [[program, ...args].map(quoteMsysArg).join(' ')],
        windowsVerbatimArguments: true,
        argv0: `"${bash}"`,
        // quoteMsysArg relies on this parsing mode, which noglob turns off.
        ...(msys ? { env: { MSYS: msys.split(/\s+/).filter((o) => o !== 'noglob').join(' ') } } : {}),
      };
    }
    return { file: program, args: [...args], windowsVerbatimArguments: false };
  }
  if (isBatchProgram(program)) {
    throw new LiveLauncherError('script-type-unsupported', 'a .bat or .cmd script runs only on Windows: use a .sh script here');
  }
  if (isPs1) {
    return {
      file: requireLauncher(launchers.pwsh(), 'a .ps1 script here needs pwsh (PowerShell 7), which was not found in the usual folders or on an absolute PATH entry. Install it, or use a .sh script'),
      args: ['-NoProfile', '-NonInteractive', '-File', program, ...args],
      windowsVerbatimArguments: false,
    };
  }
  if (launchers.lacksExecuteBit(program)) {
    if (isSh) return { file: '/bin/sh', args: [program, ...args], windowsVerbatimArguments: false };
    throw new LiveLauncherError('script-not-executable', 'the script file has no execute permission for this user: chmod +x it');
  }
  return { file: program, args: [...args], windowsVerbatimArguments: false };
}

/** An absolute bash for an inline script on POSIX; the PATH fallback takes absolute entries only. */
export function resolvePosixBash(
  envPath: string | undefined = process.env.PATH,
  isFile: (p: string) => boolean = fileExists,
): string | null {
  const dirs = ['/bin', '/usr/bin', ...(envPath ?? '').split(':').filter((d) => path.posix.isAbsolute(d))];
  for (const dir of dirs) {
    const candidate = path.posix.join(dir, 'bash');
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * How to start a live secret. An inline script runs in the orchestrator's shell
 * (bash, or PowerShell on Windows), with placeholders rewritten to env var
 * references; a script file goes through buildProgramInvocation.
 */
export function buildLiveInvocation(
  source: LiveSecretSource,
  platform: NodeJS.Platform,
  resolveTool: ToolResolver = windowsSystemTool,
  resolveBash: () => string | null = resolvePosixBash,
): LiveInvocation {
  if (source.inline === undefined) {
    return buildProgramInvocation(source.program as string, source.args ?? [], platform, resolveTool);
  }
  const script = rewriteInlineScript(source.inline, source.bindings, platform);
  if (platform === 'win32') {
    return {
      file: requireTool('powershell', resolveTool),
      args: [...POWERSHELL_FLAGS, '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      windowsVerbatimArguments: false,
    };
  }
  const bash = resolveBash();
  if (!bash) throw new Error('bash was not found in /bin, /usr/bin or on an absolute PATH entry');
  return { file: bash, args: ['-c', script], windowsVerbatimArguments: false };
}

/** Kill the script's whole process tree. Best-effort: it may already be gone. */
export function killProcessTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      const taskkill = windowsSystemTool('taskkill');
      if (!taskkill) {
        process.kill(pid);
        return;
      }
      execFileSync(taskkill, ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore', windowsHide: true, timeout: KILL_TREE_TIMEOUT_MS,
      });
    } else {
      // Spawned detached, so the script leads its own process group.
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // ESRCH / taskkill "not found": the tree already exited -- nothing to kill.
  }
}

/**
 * Parse and validate the script's stdout. Throws a LiveSecretError whose reason
 * never quotes the output (JSON.parse messages can echo it).
 */
export function parseLiveOutput(credential: string, stdout: string, nowMs: number = Date.now()): LiveToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new LiveSecretError(credential, 'output-not-json', 'output is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LiveSecretError(credential, 'output-not-object', 'output is not a JSON object');
  }
  const { token, expires_at: expiresAt } = parsed as Record<string, unknown>;
  if (typeof token !== 'string' || token === '') {
    throw new LiveSecretError(credential, 'no-token', 'output has no token');
  }
  if (/\s/.test(token)) {
    throw new LiveSecretError(credential, 'bad-token', 'token must be a single line with no whitespace');
  }
  if (typeof expiresAt !== 'string' || expiresAt === '') {
    throw new LiveSecretError(credential, 'no-expiry', 'output has no expires_at');
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (!ISO_8601_WITH_ZONE.test(expiresAt) || !Number.isFinite(expiresAtMs)) {
    throw new LiveSecretError(credential, 'bad-expiry', 'expires_at is not an ISO 8601 date-time with a time zone');
  }
  if (expiresAtMs <= nowMs) {
    throw new LiveSecretError(credential, 'past-expiry', 'expires_at is not in the future');
  }
  return { token, expiresAt };
}

function positiveOrDefault(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!(resolved > 0)) throw new Error(`runLiveSecret: ${label} must be > 0 (got ${resolved})`);
  return resolved;
}

/**
 * Run the script once and return its token. The timeout and the output cap kill
 * the whole process tree and settle immediately, so a grandchild holding stdout
 * open cannot hang the call.
 */
export function runLiveSecret(opts: RunLiveSecretOptions): Promise<LiveToken> {
  const { credential, invocation } = opts;
  const timeoutMs = positiveOrDefault(opts.timeoutMs, DEFAULT_LIVE_SECRET_TIMEOUT_MS, 'timeoutMs');
  const maxOutputBytes = positiveOrDefault(opts.maxOutputBytes, DEFAULT_LIVE_SECRET_MAX_OUTPUT_BYTES, 'maxOutputBytes');

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.file, invocation.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...invocation.env, ...opts.env, FLEET_CREDENTIAL: credential },
        cwd: opts.cwd,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        ...(invocation.argv0 ? { argv0: invocation.argv0 } : {}),
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
      reject(new LiveSecretError(credential, 'start-failed', `could not start the script (${code})`));
      return;
    }

    let settled = false;
    let stdoutBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const settle = (err: LiveSecretError | undefined, result?: LiveToken): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(result as LiveToken);
    };
    const abort = (reasonCode: LiveSecretReasonCode, reason: string): void => {
      if (child.pid !== undefined) killProcessTree(child.pid);
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle(new LiveSecretError(credential, reasonCode, reason));
    };

    const timer = setTimeout(() => abort('timeout', `timed out after ${timeoutMs}ms`), timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        abort('output-too-large', `output exceeded ${maxOutputBytes} bytes`);
        return;
      }
      stdoutChunks.push(chunk);
    });
    // Drained and discarded: stderr may echo secrets and must never surface.
    child.stderr?.on('data', () => {});

    child.on('error', (spawnErr: NodeJS.ErrnoException) => {
      settle(new LiveSecretError(credential, 'start-failed', `could not start the script (${spawnErr.code ?? 'unknown error'})`));
    });

    child.on('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (exitCode === null) {
        settle(new LiveSecretError(credential, 'killed', `killed by signal ${signal ?? 'unknown'}`));
        return;
      }
      if (exitCode !== 0) {
        settle(new LiveSecretError(credential, 'exit-nonzero', `exit code ${exitCode}`, exitCode));
        return;
      }
      try {
        settle(undefined, parseLiveOutput(credential, Buffer.concat(stdoutChunks).toString('utf8')));
      } catch (err) {
        settle(err as LiveSecretError);
      }
    });
  });
}
