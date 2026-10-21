import { spawn, execFileSync } from 'node:child_process';

/**
 * Where the HTTP KB provider gets its bearer token from.
 *
 * - getToken(): the current token (cached by sources that can refresh).
 * - refresh(): force a fresh token, bypassing any cache.
 * - canRefresh: false when refresh() can only ever return the same token, so a
 *   caller must not bother retrying an auth failure with it.
 */
export interface TokenSource {
  getToken(): Promise<string>;
  refresh(): Promise<string>;
  readonly canRefresh: boolean;
}

export const TOKEN_SOURCE_FAILED = 'TOKEN_SOURCE_FAILED';

const DEFAULT_TTL_SECONDS = 2700;
const DEFAULT_TIMEOUT_MS = 30_000;
/** A JWT is treated as stale when fewer than this many seconds remain before exp. */
const JWT_REFRESH_MARGIN_SECONDS = 300;
const KILL_TREE_TIMEOUT_MS = 10_000;

/** A fixed token: today's behaviour. It can never refresh. */
export class StaticTokenSource implements TokenSource {
  readonly canRefresh = false;

  constructor(private readonly token: string) {}

  async getToken(): Promise<string> {
    return this.token;
  }

  async refresh(): Promise<string> {
    return this.token;
  }
}

export interface ShellInvocation {
  file: string;
  args: string[];
  /** Windows only: pass args to cmd.exe unescaped (the command is already quoted for /s). */
  windowsVerbatimArguments: boolean;
}

/**
 * How to run `command` through the platform shell. Platform is a parameter so
 * both branches are unit-testable on any host.
 *
 * Windows: cmd.exe /d /s /c "<command>" with verbatim arguments -- the same
 * shape Node itself uses for `shell: true`. /s strips exactly the outer quote
 * pair, so a command that itself starts with a quoted path still works.
 * Elsewhere: /bin/sh -c <command>.
 */
export function buildShellInvocation(command: string, platform: NodeJS.Platform): ShellInvocation {
  if (platform === 'win32') {
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true };
  }
  return { file: '/bin/sh', args: ['-c', command], windowsVerbatimArguments: false };
}

/**
 * The exp claim (seconds since epoch) of a JWT, or undefined when the token is
 * not a JWT or carries no numeric exp. The signature is NOT verified: this is
 * used for refresh timing only, never for trust.
 */
export function jwtExpirySeconds(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload === null || typeof payload !== 'object') return undefined;
    const exp = (payload as Record<string, unknown>).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : undefined;
  } catch {
    // Not decodable as a JWT payload -- treat it as an opaque token.
    return undefined;
  }
}

/** An error whose message names the cause only -- never output, token or command line. */
function tokenSourceError(cause: string): NodeJS.ErrnoException {
  const err = new Error(`token command failed: ${cause}`) as NodeJS.ErrnoException;
  err.code = TOKEN_SOURCE_FAILED;
  return err;
}

/** Kill the command's whole process tree. Best-effort: it may already be gone. */
function killProcessTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore', windowsHide: true, timeout: KILL_TREE_TIMEOUT_MS,
      });
    } else {
      // Spawned detached, so the child leads its own process group.
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // ESRCH / taskkill "not found": the tree already exited.
  }
}

/**
 * Run `command` through the platform shell with stdin closed and return its
 * trimmed stdout. Rejects with code TOKEN_SOURCE_FAILED on a non-zero exit,
 * a timeout or empty output. The timeout kills the whole process tree and
 * settles on the timer itself, so a grandchild holding stdout open cannot
 * hang the call.
 */
export function runTokenCommand(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const posix = process.platform !== 'win32';
    const shell = buildShellInvocation(command, process.platform);
    const child = spawn(shell.file, shell.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: shell.windowsVerbatimArguments,
      detached: posix,
    });

    let settled = false;
    const stdoutChunks: Buffer[] = [];
    const settle = (err: Error | undefined, token?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(token as string);
    };

    const timer = setTimeout(() => {
      if (child.pid !== undefined) killProcessTree(child.pid);
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle(tokenSourceError(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => { stdoutChunks.push(chunk); });
    // stderr is drained and discarded: it may echo secrets and must never surface.
    child.stderr?.on('data', () => {});

    child.on('error', (spawnErr: NodeJS.ErrnoException) => {
      settle(tokenSourceError(`could not start the shell (${spawnErr.code ?? 'unknown error'})`));
    });

    child.on('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (exitCode !== 0) {
        const cause = exitCode === null ? `killed by signal ${signal ?? 'unknown'}` : `exit code ${exitCode}`;
        settle(tokenSourceError(cause));
        return;
      }
      const token = Buffer.concat(stdoutChunks).toString('utf8').trim();
      if (token === '') {
        settle(tokenSourceError('empty output'));
        return;
      }
      settle(undefined, token);
    });
  });
}

export interface CommandTokenSourceOptions {
  command: string;
  /** Cache lifetime for a token that is not a JWT with an exp claim. Default 2700. */
  ttlSeconds?: number;
  /** Per-run timeout. Default 30000. */
  timeoutMs?: number;
}

/**
 * Gets its token by running a command that prints one. The token is cached:
 * a JWT with a numeric exp is stale once fewer than 300 s remain; any other
 * token is stale ttlSeconds after it was fetched. Concurrent getToken() and
 * refresh() calls share a single in-flight command run.
 *
 * Never logs the token, the command line or the command output.
 */
export class CommandTokenSource implements TokenSource {
  readonly canRefresh = true;
  private readonly command: string;
  private readonly ttlSeconds: number;
  private readonly timeoutMs: number;
  private cached: { token: string; staleAtMs: number } | undefined;
  private inFlight: Promise<string> | undefined;

  constructor(opts: CommandTokenSourceOptions) {
    if (typeof opts.command !== 'string' || opts.command.trim() === '') {
      throw new Error('CommandTokenSource: command must be a non-empty string');
    }
    const ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!(ttlSeconds > 0)) throw new Error(`CommandTokenSource: ttlSeconds must be > 0 (got ${ttlSeconds})`);
    if (!(timeoutMs > 0)) throw new Error(`CommandTokenSource: timeoutMs must be > 0 (got ${timeoutMs})`);
    this.command = opts.command;
    this.ttlSeconds = ttlSeconds;
    this.timeoutMs = timeoutMs;
  }

  async getToken(): Promise<string> {
    if (this.cached && Date.now() < this.cached.staleAtMs) return this.cached.token;
    return this.refresh();
  }

  refresh(): Promise<string> {
    if (!this.inFlight) {
      this.inFlight = this.fetchToken().finally(() => { this.inFlight = undefined; });
    }
    return this.inFlight;
  }

  private async fetchToken(): Promise<string> {
    const fetchedAtMs = Date.now();
    const token = await runTokenCommand(this.command, this.timeoutMs);
    this.cached = { token, staleAtMs: this.staleAtMs(token, fetchedAtMs) };
    return token;
  }

  private staleAtMs(token: string, fetchedAtMs: number): number {
    const exp = jwtExpirySeconds(token);
    if (exp !== undefined) return (exp - JWT_REFRESH_MARGIN_SECONDS) * 1000;
    return fetchedAtMs + this.ttlSeconds * 1000;
  }
}
