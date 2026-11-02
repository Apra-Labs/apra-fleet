import { spawn, execFileSync } from 'node:child_process';

/**
 * Runs a registered credential helper (a program plus argv, never a shell
 * string) and returns the token it mints.
 *
 * Protocol: fleet writes {"credential":"<name>","audience":"<url>"} to the
 * helper's stdin and closes it; the helper prints
 * {"token":"...","expires_at":"<ISO 8601>"} on stdout and exits 0.
 *
 * Every failure is a CredentialHelperError that names the credential and the
 * cause only. Neither the token, the helper's stdout nor its stderr ever
 * reaches an error or a log line: stderr is drained and discarded.
 *
 * Carried over from the TokenSource runner (commit 0f7e129a), adapted from a
 * shell command line to program + argv with a JSON stdin/stdout protocol.
 */

export const CREDENTIAL_HELPER_FAILED = 'CREDENTIAL_HELPER_FAILED';

export const DEFAULT_HELPER_TIMEOUT_MS = 30_000;
/** Largest stdout a helper may print. A token response is a few KB at most. */
export const DEFAULT_HELPER_MAX_OUTPUT_BYTES = 64 * 1024;
const KILL_TREE_TIMEOUT_MS = 10_000;

/** ISO 8601 date-time with an explicit zone (Z or +hh:mm), so it is never read as local time. */
const ISO_8601_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

export class CredentialHelperError extends Error {
  readonly code = CREDENTIAL_HELPER_FAILED;

  constructor(readonly credential: string, readonly reason: string) {
    super(`credential helper for '${credential}' failed: ${reason}`);
    this.name = 'CredentialHelperError';
  }
}

export interface HelperToken {
  token: string;
  /** The helper's expires_at, as printed (ISO 8601 with a zone). */
  expiresAt: string;
}

export interface RunCredentialHelperOptions {
  /** Credential name: sent to the helper and named in every error. */
  credential: string;
  /** The URL the token is for, sent to the helper. */
  audience: string;
  /** Absolute path of the helper program. */
  program: string;
  args: string[];
  /** Kills the whole process tree after this long. Default 30000. */
  timeoutMs?: number;
  /** Stdout beyond this many bytes kills the tree and fails. Default 64 KiB. */
  maxOutputBytes?: number;
}

export interface HelperInvocation {
  file: string;
  args: string[];
  /** Windows only: hand args to cmd.exe as-is (the command line is already quoted). */
  windowsVerbatimArguments: boolean;
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
 * neutralised by launching cmd.exe with /v:off (see buildHelperInvocation).
 */
export function quoteCmdArg(arg: string): string {
  if (/[\r\n\0]/.test(arg)) {
    throw new Error('an argument for a .cmd/.bat helper must not contain a line break or NUL');
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
 * How to start a helper. Platform is a parameter so every branch is
 * unit-testable on any host.
 *
 * - A .cmd/.bat program on Windows: cmd.exe /d /v:off /s /c "<quoted line>"
 *   with verbatim arguments. Node will not spawn a batch file without a shell
 *   (CVE-2024-27980), so every piece goes through quoteCmdArg. /d skips
 *   AutoRun, /v:off disables delayed (!) expansion, /s strips exactly the
 *   outer quote pair.
 * - Anything else (.exe, POSIX programs and scripts): spawned directly with
 *   argv, no shell.
 */
export function buildHelperInvocation(
  program: string,
  args: string[],
  platform: NodeJS.Platform,
  comSpec: string | undefined = process.env.ComSpec,
): HelperInvocation {
  if (platform === 'win32' && isBatchProgram(program)) {
    const line = [program, ...args].map(quoteCmdArg).join(' ');
    return {
      file: comSpec || 'cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', `"${line}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { file: program, args: [...args], windowsVerbatimArguments: false };
}

/** Kill the helper's whole process tree. Best-effort: it may already be gone. */
export function killProcessTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore', windowsHide: true, timeout: KILL_TREE_TIMEOUT_MS,
      });
    } else {
      // Spawned detached, so the helper leads its own process group.
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // ESRCH / taskkill "not found": the tree already exited -- nothing to kill.
  }
}

/**
 * Parse and validate the helper's stdout. Throws a CredentialHelperError whose
 * reason never quotes the output (JSON.parse messages can echo it).
 */
export function parseHelperOutput(credential: string, stdout: string, nowMs: number = Date.now()): HelperToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CredentialHelperError(credential, 'output is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CredentialHelperError(credential, 'output is not a JSON object');
  }
  const { token, expires_at: expiresAt } = parsed as Record<string, unknown>;
  if (typeof token !== 'string' || token === '') {
    throw new CredentialHelperError(credential, 'output has no token');
  }
  if (/\s/.test(token)) {
    throw new CredentialHelperError(credential, 'token must be a single line with no whitespace');
  }
  if (typeof expiresAt !== 'string' || expiresAt === '') {
    throw new CredentialHelperError(credential, 'output has no expires_at');
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (!ISO_8601_WITH_ZONE.test(expiresAt) || !Number.isFinite(expiresAtMs)) {
    throw new CredentialHelperError(credential, 'expires_at is not an ISO 8601 date-time with a time zone');
  }
  if (expiresAtMs <= nowMs) {
    throw new CredentialHelperError(credential, 'expires_at is not in the future');
  }
  return { token, expiresAt };
}

function positiveOrDefault(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!(resolved > 0)) throw new Error(`runCredentialHelper: ${label} must be > 0 (got ${resolved})`);
  return resolved;
}

/**
 * Run the helper once and return its token. The timeout and the output cap
 * kill the whole process tree and settle immediately, so a grandchild holding
 * stdout open cannot hang the call.
 */
export function runCredentialHelper(opts: RunCredentialHelperOptions): Promise<HelperToken> {
  const { credential, audience, program, args } = opts;
  const timeoutMs = positiveOrDefault(opts.timeoutMs, DEFAULT_HELPER_TIMEOUT_MS, 'timeoutMs');
  const maxOutputBytes = positiveOrDefault(opts.maxOutputBytes, DEFAULT_HELPER_MAX_OUTPUT_BYTES, 'maxOutputBytes');

  return new Promise((resolve, reject) => {
    let invocation: HelperInvocation;
    try {
      invocation = buildHelperInvocation(program, args, process.platform);
    } catch (err) {
      reject(new CredentialHelperError(credential, `cannot launch: ${(err as Error).message}`));
      return;
    }

    const child = spawn(invocation.file, invocation.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      detached: process.platform !== 'win32',
    });

    let settled = false;
    let stdoutBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const settle = (err: CredentialHelperError | undefined, result?: HelperToken): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(result as HelperToken);
    };
    const abort = (reason: string): void => {
      if (child.pid !== undefined) killProcessTree(child.pid);
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle(new CredentialHelperError(credential, reason));
    };

    const timer = setTimeout(() => abort(`timed out after ${timeoutMs}ms`), timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        abort(`output exceeded ${maxOutputBytes} bytes`);
        return;
      }
      stdoutChunks.push(chunk);
    });
    // Drained and discarded: stderr may echo secrets and must never surface.
    child.stderr?.on('data', () => {});

    // A helper that exits without reading stdin closes the pipe under us
    // (EPIPE); its exit code decides the outcome, so the write error is moot.
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify({ credential, audience }));

    child.on('error', (spawnErr: NodeJS.ErrnoException) => {
      settle(new CredentialHelperError(credential, `could not start the helper (${spawnErr.code ?? 'unknown error'})`));
    });

    child.on('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (exitCode !== 0) {
        const cause = exitCode === null ? `killed by signal ${signal ?? 'unknown'}` : `exit code ${exitCode}`;
        settle(new CredentialHelperError(credential, cause));
        return;
      }
      try {
        settle(undefined, parseHelperOutput(credential, Buffer.concat(stdoutChunks).toString('utf8')));
      } catch (err) {
        settle(err as CredentialHelperError);
      }
    });
  });
}
