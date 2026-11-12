import http from 'node:http';
import https from 'node:https';
import type { SqliteProvider } from './sqlite-provider.js';
import type {
  MemoryProvider,
  KBEntry,
  KBEntryInput,
  QueryOptions,
  EntryTrustFilter,
  KBResult,
  FileContextResult,
  PrimeOptions,
  PrimedContext,
  SyncOptions,
  SyncResult,
  AudnDecision,
  Confidence,
  ProviderStats,
  DiscardResult,
  RetireOptions,
} from './types.js';

import { DEFAULT_REQUEST_TIMEOUT_MS } from './kb-config.js';
import { lookupServerSecret } from '../credential-store.js';
import { recordKbHttpSuccess, recordKbHttpRejected } from './kb-http-auth-state.js';
import {
  REPOSITORY_HEADER,
  REPOSITORY_COMMIT_HEADER,
  REPOSITORY_BRANCH_HEADER,
  COMMIT_SHA,
  isValidRepositoryValue,
  isValidBranchValue,
  type RepositoryIdentity,
} from './repository-header.js';

export { DEFAULT_REQUEST_TIMEOUT_MS };

const MAX_QUEUE_SIZE = 1000;
// Most entries one owner-tag lookup reads back. An owned entry beyond it is
// reported not-found (a refusal, never a wrong promote).
const OWNED_LOOKUP_LIMIT = 1000;

/**
 * Optional settings for HttpKbProvider. An options object rather than more
 * positional parameters, so new settings can be added without changing the
 * constructor signature.
 */
export interface HttpKbProviderOptions {
  /** Socket idle timeout per request, in ms; absent means DEFAULT_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
  /**
   * Project slug sent as the X-KB-Project header on every request, so a KB
   * server serving a different project refuses with 409 instead of answering
   * with that project's KB. Absent means no header is sent.
   */
  projectSlug?: string;
  /**
   * The repository every request is about, sent as the X-Repository,
   * X-Repository-Commit and X-Repository-Branch headers. Filled only from
   * fleet's resolved KB anchor (kb-providers.ts), never from tool input.
   * Absent: none of these headers is sent.
   */
  repository?: RepositoryIdentity;
}

/**
 * Where the bearer token comes from. A string is a literal token fixed for the
 * provider's lifetime (the behaviour before named secrets). `{ secretName }`
 * names a fleet secret that is looked up on EVERY request, so a secret updated
 * outside fleet is used by the very next call with no restart.
 */
export type KbHttpTokenSource = string | { secretName: string };

export type KbHttpAuthReason = 'missing' | 'expired' | 'rejected' | 'unreadable';

/**
 * E-KB-HTTP-AUTH: the remote KB's token comes from a named fleet secret and
 * that secret is missing, expired, unreadable, or was rejected by the server
 * (HTTP 401) on the request and on one retry after re-reading it. The message
 * names the secret and the reason, never the value. `queued` is true when the
 * operation (a capture, invalidate or feedback) was kept in the offline queue and will
 * be sent once the secret is accepted.
 */
export class KbHttpAuthError extends Error {
  readonly code = 'E-KB-HTTP-AUTH' as const;
  readonly secretName: string;
  readonly reason: KbHttpAuthReason;
  readonly remediation: string;
  readonly queued: boolean;
  /** The problem sentence, without the code prefix and remediation. */
  readonly problem: string;
  constructor(secretName: string, reason: KbHttpAuthReason, problem: string, queued = false) {
    const remediation = `apra-fleet secret --set ${secretName} --persist -y (the next KB call uses the new value; no restart needed)`;
    const queuedNote = queued
      ? ' The operation was queued offline and is sent once the secret is accepted.'
      : '';
    super(`E-KB-HTTP-AUTH: ${problem}${queuedNote} Remediation: ${remediation}`);
    this.name = 'KbHttpAuthError';
    this.secretName = secretName;
    this.reason = reason;
    this.remediation = remediation;
    this.queued = queued;
    this.problem = problem;
  }

  /** The same error, marked as having left its operation in the offline queue. */
  asQueued(): KbHttpAuthError {
    if (this.queued) return this;
    return new KbHttpAuthError(this.secretName, this.reason, this.problem, true);
  }
}

function isAuthError(err: unknown): err is KbHttpAuthError {
  return err instanceof KbHttpAuthError;
}

/**
 * A 5xx or 429: the server (or a gateway in front of it) cannot answer right
 * now. The state of the server, never the fault of the request that got it.
 */
function isServerUnavailable(err: unknown): boolean {
  const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
  return typeof code === 'string' && (code === 'HTTP_429' || /^HTTP_5\d\d$/.test(code));
}

function isHttp401(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'HTTP_401';
}

/** Defensive: a server that echoes the Authorization header must not leak the token into an error. */
function redactToken(text: string, token: string): string {
  return token ? text.split(token).join('[REDACTED]') : text;
}

type QueuedOperation =
  | { op: 'capture'; input: KBEntryInput }
  | { op: 'invalidate'; files: string[] }
  | { op: 'feedback'; id: string; reason: string; role: string };

/**
 * What HttpKbProvider.feedback returns: the remote server's response body as
 * is. The client never invents confidence/stale fields.
 */
export type HttpKbFeedbackResult = Record<string, unknown>;

function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    err.message.includes('ECONNREFUSED') ||
    err.message.includes('ETIMEDOUT') ||
    err.message.includes('socket hang up')
  );
}

/** Longest server error text carried into a tool result. */
export const MAX_ERROR_TEXT_CHARS = 300;

/**
 * Server error text made safe for a tool result: markup stripped, whitespace
 * collapsed, and capped at MAX_ERROR_TEXT_CHARS (a proxy or a crashed server
 * can answer with a whole HTML page).
 */
export function boundErrorText(text: string): string {
  const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (plain.length === 0) return '(empty response body)';
  if (plain.length <= MAX_ERROR_TEXT_CHARS) return plain;
  return `${plain.slice(0, MAX_ERROR_TEXT_CHARS)}... (truncated, ${plain.length} chars)`;
}

/**
 * Human-readable text for an error-status response body. Handles
 * problem+json (title/detail/code), the plain {error} shape, and bodies
 * that are not JSON at all (never a parse failure). Always bounded.
 */
function describeErrorBody(data: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return boundErrorText(data);
  }
  if (parsed === null || typeof parsed !== 'object') return boundErrorText(data);
  const body = parsed as Record<string, unknown>;
  if (typeof body.error === 'string') {
    // A problem+json body that also carries a flat `error` string (a server
    // may send both) keeps its taxonomy `code` in the text too.
    const code = typeof body.code === 'string' && body.code.length > 0 && !body.error.includes(body.code)
      ? ` [${body.code}]` : '';
    return boundErrorText(body.error + code);
  }
  const parts = [body.title, body.code, body.detail]
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  return boundErrorText(parts.length > 0 ? parts.join(' - ') : data);
}

/** The string `code` of a JSON error body, or undefined. */
function bodyCodeOf(data: string): string | undefined {
  try {
    const body = JSON.parse(data) as unknown;
    if (body !== null && typeof body === 'object' && typeof (body as { code?: unknown }).code === 'string') {
      return (body as { code: string }).code;
    }
  } catch {
    // not JSON: no code
  }
  return undefined;
}

/** True when `text` parses as JSON. */
function isJsonText(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** `url` with any user:password removed, for error text. */
export function redactUrlUserinfo(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username === '' && parsed.password === '') return url;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return url.replace(/\/\/[^/@]*@/, '//');
  }
}

/**
 * The two project slugs of a kb-server 409 PROJECT_MISMATCH body, or null for
 * any other 409 (which is then reported as a plain HTTP error).
 */
function projectMismatchOf(data: string): { server: string; client: string } | null {
  try {
    const body = JSON.parse(data) as Record<string, unknown>;
    if (body.code !== 'PROJECT_MISMATCH') return null;
    return { server: String(body.server_project), client: String(body.client_project) };
  } catch {
    return null;
  }
}

/**
 * A promote the server answered 404: the same "Entry not found: <id>" the
 * SQLite provider throws, followed by the server's own answer (whose text
 * already carries the status and the problem+json title/code/detail). The
 * HTTP_404 code is kept.
 */
function entryNotFoundOnServer(id: string, err: NodeJS.ErrnoException): NodeJS.ErrnoException {
  const notFound = new Error(`Entry not found: ${id} (the KB server answered ${err.message})`) as NodeJS.ErrnoException;
  notFound.code = err.code;
  return notFound;
}

/** True when the entry carries `tag`; an entry without a tags array is never owned. */
function hasTag(entry: { tags?: unknown }, tag: string): boolean {
  return Array.isArray(entry.tags) && entry.tags.includes(tag);
}

/**
 * E-KB-HTTP-UNREACHABLE: the KB server could not be reached (connection
 * refused, DNS failure, timeout, reset). Over http the server is the only
 * source of truth, so nothing is answered from a local store or the checkout
 * bible instead. `queued` is true when the operation (a capture, invalidate
 * or feedback) was kept in the offline queue and will be sent once the server
 * answers again.
 */
export class KbHttpUnreachableError extends Error {
  readonly code = 'E-KB-HTTP-UNREACHABLE' as const;
  readonly queued: boolean;
  private readonly serverUrl: string;
  private readonly operation: string;
  /** The connection error text (e.g. "connect ECONNREFUSED ..."). */
  readonly causeText: string;
  constructor(serverUrl: string, operation: string, causeText: string, queued = false) {
    const outcome = queued
      ? 'the operation was queued offline and is sent once the server answers again'
      : 'nothing was read or written';
    super(
      `E-KB-HTTP-UNREACHABLE: ${operation}: the KB server at ${serverUrl} is unreachable (${causeText}); `
      + `${outcome}, and no local store or bible is used instead. `
      + 'Remediation: start the KB server or restore the network path to it, or use a local SQLite KB (kb_setup provider sqlite).',
    );
    this.name = 'KbHttpUnreachableError';
    this.queued = queued;
    this.serverUrl = serverUrl;
    this.operation = operation;
    this.causeText = causeText;
  }

  /** The same error, marked as having left its operation in the offline queue. */
  asQueued(): KbHttpUnreachableError {
    if (this.queued) return this;
    return new KbHttpUnreachableError(this.serverUrl, this.operation, this.causeText, true);
  }
}

/**
 * Typed refusal for an operation the http KB provider does not support (and
 * deliberately does not emulate through a local store).
 */
export class KbHttpUnsupportedError extends Error {
  readonly code = 'E-KB-HTTP-UNSUPPORTED';
  constructor(
    operation: string,
    outcome = 'nothing was discarded',
    remediation = 'run it against a local SQLite KB (kb_setup provider sqlite), or use kb_invalidate with files.',
  ) {
    super(
      `E-KB-HTTP-UNSUPPORTED: ${operation} is not supported by the http KB provider; ${outcome}. `
      + `Remediation: ${remediation}`,
    );
    this.name = 'KbHttpUnsupportedError';
  }
}

/**
 * Typed refusal for a KB server that serves a different project than the one
 * the request is for (HTTP 409). Never answered from a local store: the
 * server is reachable, it is just the wrong one.
 */
export class KbHttpProjectMismatchError extends Error {
  readonly code = 'E-KB-HTTP-PROJECT-MISMATCH';
  constructor(serverUrl: string, serverProject: string, clientProject: string) {
    super(
      `E-KB-HTTP-PROJECT-MISMATCH: the KB server at ${serverUrl} serves project "${serverProject}", `
      + `not "${clientProject}"; nothing was read or written. `
      + 'Remediation: point this repo at the KB server for its own project (kb_setup provider http), '
      + 'or use a local SQLite KB (kb_setup provider sqlite).',
    );
    this.name = 'KbHttpProjectMismatchError';
  }
}

/** Routes every contract KB server serves. */
export const KB_REQUIRED_ROUTES = ['capture', 'query', 'promote'] as const;
/** Routes a contract KB server may leave out; it lists the ones it serves in its capabilities. */
export const KB_OPTIONAL_ROUTES = ['context', 'prime', 'invalidate', 'feedback', 'list', 'demote'] as const;
export type KbRoute = typeof KB_REQUIRED_ROUTES[number] | typeof KB_OPTIONAL_ROUTES[number];
const KNOWN_ROUTES: readonly string[] = [...KB_REQUIRED_ROUTES, ...KB_OPTIONAL_ROUTES];

/** GET /api/kb/capabilities: what a KB server serves. */
export interface KbServerCapabilities {
  /** Contract version the server implements, e.g. "v1". */
  contract: string;
  /** The routes it serves (route names, not paths). */
  routes: KbRoute[];
  /** True when the server keeps entries per branch (X-Repository-Branch decides what is true). */
  branch_aware: boolean;
}

/**
 * Assumed for a server that does not serve GET /api/kb/capabilities (404 or
 * 501): the route set servers had before capabilities existed. demote is not
 * in it.
 */
export const KB_DEFAULT_CAPABILITIES: Readonly<KbServerCapabilities> = Object.freeze({
  contract: 'v1',
  routes: ['capture', 'query', 'promote', 'context', 'prime', 'invalidate', 'feedback', 'list'] as KbRoute[],
  branch_aware: false,
});

function defaultCapabilities(): KbServerCapabilities {
  return { ...KB_DEFAULT_CAPABILITIES, routes: [...KB_DEFAULT_CAPABILITIES.routes] };
}

/** The route a queued write replays through. */
const QUEUED_OP_ROUTE: Record<QueuedOperation['op'], KbRoute> = {
  capture: 'capture',
  invalidate: 'invalidate',
  feedback: 'feedback',
};

/** Body codes meaning "no entry with that id" on a 404 from an id route. */
const ENTRY_NOT_FOUND_CODES = new Set(['ENTRY_NOT_FOUND', 'E-ENTRY-NOT-FOUND']);

/** The `code` field of an HTTP error's server body, when it had one. */
function serverCodeOf(err: unknown): string | undefined {
  return (err as { serverCode?: string }).serverCode;
}

/** kb_list options, shared with SqliteProvider.list so both halves of a split list take one shape. */
export type KbListOptions = Parameters<SqliteProvider['list']>[0];

/** Header carrying the project slug on every request (checked by kb-server). */
export const KB_PROJECT_HEADER = 'X-KB-Project';

export class HttpKbProvider implements MemoryProvider {
  private baseUrl: string;
  /** baseUrl with any user:password removed: the only form put in error text. */
  private readonly displayUrl: string;
  private readonly tokenSource: KbHttpTokenSource;
  private readonly projectSlug: string | undefined;
  private readonly requestTimeoutMs: number;
  private readonly repository: RepositoryIdentity | undefined;
  readonly offlineQueue: QueuedOperation[] = [];
  private readonly beforeExitHandler: () => void;
  /**
   * The server's capabilities, read once per connection: cleared when a
   * request finds the server unreachable, so the first request after a
   * reconnect reads them again.
   */
  private capabilitiesRead: Promise<KbServerCapabilities> | undefined;

  // The KB server is the only source of truth: no local store or checkout
  // bible answers for it, online or offline.
  constructor(url: string, token: KbHttpTokenSource, options: HttpKbProviderOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.repository = options.repository && isValidRepositoryValue(options.repository.remote)
      ? options.repository
      : undefined;
    this.baseUrl = url.replace(/\/$/, '');
    this.displayUrl = redactUrlUserinfo(this.baseUrl);
    this.tokenSource = token;
    this.projectSlug = options.projectSlug;

    this.beforeExitHandler = () => {
      if (this.offlineQueue.length > 0) {
        process.stderr.write(
          `[KB] WARNING: offline queue has ${this.offlineQueue.length} unsaved operations (captures, invalidations, feedback). ` +
          `They never reached the KB server and the queue is lost when this process exits. Repeat them once the KB server is reachable.\n`
        );
      }
    };
    process.on('beforeExit', this.beforeExitHandler);
  }

  dispose(): void {
    process.removeListener('beforeExit', this.beforeExitHandler);
  }

  private enqueue(op: QueuedOperation): void {
    if (this.offlineQueue.length >= MAX_QUEUE_SIZE) {
      this.offlineQueue.shift();
      process.stderr.write('[KB] WARNING: offline queue full (1000), dropping oldest entry\n');
    }
    this.offlineQueue.push(op);
  }

  // The repository headers for one request. The commit and branch are best
  // effort: an unreadable, throwing or malformed value omits that header and
  // never fails the request.
  private repositoryHeaders(): Record<string, string> {
    if (!this.repository) return {};
    const headers: Record<string, string> = { [REPOSITORY_HEADER]: this.repository.remote };
    let commit: string | undefined;
    try {
      commit = this.repository.commitOf?.();
    } catch {
      commit = undefined;
    }
    if (commit && COMMIT_SHA.test(commit)) headers[REPOSITORY_COMMIT_HEADER] = commit;
    let branch: string | undefined;
    try {
      branch = this.repository.branchOf?.();
    } catch {
      branch = undefined;
    }
    if (typeof branch === 'string' && isValidBranchValue(branch)) headers[REPOSITORY_BRANCH_HEADER] = branch;
    return headers;
  }

  /**
   * The token to send now. A literal is returned as is. A secret name is
   * looked up (server-side lookup: allowedMembers does not apply, an expired
   * record is reported and kept) and a missing/expired/unreadable secret
   * raises E-KB-HTTP-AUTH before any request is sent.
   */
  private resolveToken(): string {
    const source = this.tokenSource;
    if (typeof source === 'string') return source;
    const name = source.secretName;
    let found: ReturnType<typeof lookupServerSecret>;
    try {
      found = lookupServerSecret(name);
    } catch {
      // Fixed text: the underlying parser/decrypt error can quote ciphertext.
      throw new KbHttpAuthError(
        name, 'unreadable',
        `the KB server token comes from fleet secret "${name}", which could not be read (credential store unreadable or value could not be decrypted).`,
      );
    }
    if (found.status === 'missing') {
      throw new KbHttpAuthError(name, 'missing', `the KB server token comes from fleet secret "${name}", which does not exist.`);
    }
    if (found.status === 'expired') {
      throw new KbHttpAuthError(
        name, 'expired',
        `the KB server token comes from fleet secret "${name}", which expired at ${found.expiresAt}.`,
      );
    }
    return found.value;
  }

  /**
   * One authenticated request. Literal token: exactly the old behaviour (a
   * 401 is thrown as the plain HTTP_401 error, no retry). Secret name: the
   * secret is looked up for this request; on 401 it is looked up once more
   * and the request retried once; a second 401 raises E-KB-HTTP-AUTH.
   * Records the last success / last 401 for fleet_status either way.
   */
  private async request<T>(
    method: string,
    pathname: string,
    body?: unknown,
    queryParams?: Record<string, string>
  ): Promise<T> {
    const secretName = typeof this.tokenSource === 'string' ? undefined : this.tokenSource.secretName;
    const attempts = secretName === undefined ? 1 : 2;
    // Computed once, after the first secret lookup succeeds: a missing secret
    // fails before the commit and branch are read, and the 401 retry sends the
    // same commit and branch.
    let repoHeaders: Record<string, string> | undefined;
    for (let attempt = 1; ; attempt++) {
      const token = this.resolveToken();
      repoHeaders ??= this.repositoryHeaders();
      try {
        const result = await this.rawRequest<T>(
          token, method, pathname, body, queryParams, secretName !== undefined, repoHeaders,
        );
        recordKbHttpSuccess(this.baseUrl);
        return result;
      } catch (err) {
        if (isConnectionError(err)) {
          this.capabilitiesRead = undefined;
          throw new KbHttpUnreachableError(this.displayUrl, `${method} ${pathname}`, (err as Error).message);
        }
        if (!isHttp401(err)) throw err;
        recordKbHttpRejected(this.baseUrl);
        if (secretName === undefined) throw err;
        if (attempt >= attempts) {
          throw new KbHttpAuthError(
            secretName, 'rejected',
            `the KB server rejected the token from fleet secret "${secretName}" (HTTP 401), also on one retry after re-reading the secret.`,
          );
        }
      }
    }
  }

  private rawRequest<T>(
    token: string,
    method: string,
    pathname: string,
    body?: unknown,
    queryParams?: Record<string, string>,
    nonJson401IsAuth = false,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(this.baseUrl);
      let reqPath = parsedUrl.pathname.replace(/\/$/, '') + pathname;

      if (queryParams && Object.keys(queryParams).length > 0) {
        reqPath += '?' + new URLSearchParams(queryParams).toString();
      }

      const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...extraHeaders,
        // Set last so no extra header can replace the bearer token.
        'Authorization': `Bearer ${token}`,
      };
      if (this.projectSlug !== undefined) headers[KB_PROJECT_HEADER] = this.projectSlug;
      if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr).toString();

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port
          ? parseInt(parsedUrl.port, 10)
          : parsedUrl.protocol === 'https:' ? 443 : 80,
        path: reqPath,
        method,
        headers,
      };

      const transport = parsedUrl.protocol === 'https:' ? https : http;
      const req = transport.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          const status = res.statusCode;
          if (status === 409) {
            const mismatch = projectMismatchOf(data);
            if (mismatch) {
              reject(new KbHttpProjectMismatchError(this.displayUrl, mismatch.server, mismatch.client));
              return;
            }
          }
          if (status !== undefined && status >= 400) {
            // An auth proxy in front of the KB answers 401 with
            // an empty or HTML body. For a named-secret token the message is
            // fixed text, so the proxy's page never reaches the tool result.
            const text = nonJson401IsAuth && status === 401 && !isJsonText(data)
              ? 'KB server rejected the token'
              : describeErrorBody(data);
            const httpErr = new Error(redactToken(`HTTP ${status}: ${text}`, token)) as NodeJS.ErrnoException & { serverCode?: string };
            httpErr.code = `HTTP_${status}`;
            const serverCode = bodyCodeOf(data);
            if (serverCode !== undefined) httpErr.serverCode = serverCode;
            reject(httpErr);
            return;
          }
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            reject(new Error(`Invalid JSON response from KB server`));
          }
        });
        res.on('error', reject);
      });

      req.setTimeout(this.requestTimeoutMs, () => {
        const err = new Error(
          `ETIMEDOUT: KB server request timed out after ${this.requestTimeoutMs} ms`
        ) as NodeJS.ErrnoException;
        err.code = 'ETIMEDOUT';
        req.destroy(err);
      });

      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  /**
   * GET /api/kb/capabilities, read once per connection (again after a
   * reconnect). A server without the route is assumed to serve
   * KB_DEFAULT_CAPABILITIES: it answers 404 or 501, or (a catch-all handler)
   * a body carrying none of contract/routes/branch_aware. Auth,
   * project-mismatch and connection errors are thrown as they are for any
   * route; a body that carries some of those fields but not all, well typed,
   * is E-KB-HTTP-UNSUPPORTED.
   */
  async capabilities(): Promise<KbServerCapabilities> {
    this.capabilitiesRead ??= this.readCapabilities();
    try {
      return await this.capabilitiesRead;
    } catch (err) {
      this.capabilitiesRead = undefined;
      throw err;
    }
  }

  private async readCapabilities(): Promise<KbServerCapabilities> {
    let body: unknown;
    try {
      body = await this.request<unknown>('GET', '/api/kb/capabilities');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'HTTP_404' || code === 'HTTP_501') return defaultCapabilities();
      throw this.capabilitiesHttpError(err);
    }
    const caps = body as Partial<KbServerCapabilities> | null;
    const isObject = caps !== null && typeof caps === 'object' && !Array.isArray(caps);
    if (!isObject || !('contract' in caps || 'routes' in caps || 'branch_aware' in caps)) return defaultCapabilities();
    if (typeof caps.contract !== 'string'
      || !Array.isArray(caps.routes) || !caps.routes.every(r => typeof r === 'string')
      || typeof caps.branch_aware !== 'boolean') {
      throw new KbHttpUnsupportedError(
        `GET /api/kb/capabilities (the KB server at ${this.displayUrl} answered without {contract, routes, branch_aware})`,
        'nothing was sent',
        'fix the KB server so its capabilities answer carries contract (string), routes (array of route names) and branch_aware (boolean).',
      );
    }
    // Unknown route names are ignored: a newer server may list routes this client does not call.
    const routes = caps.routes.filter((r): r is KbRoute => KNOWN_ROUTES.includes(r));
    return { contract: caps.contract, routes, branch_aware: caps.branch_aware };
  }

  /**
   * A failed capabilities read as the typed error callers see. A 401 (literal
   * token) and the already-typed errors pass through as on any route. Any
   * other HTTP status is never a raw HTTP error: a 5xx or 429 (a restarting or
   * rate-limiting server, a gateway with no backend) is E-KB-HTTP-UNREACHABLE
   * naming the status, so a
   * write is queued as on a connection error; any other status (403/405 from
   * a gateway) is E-KB-HTTP-UNSUPPORTED naming the capabilities read.
   */
  private capabilitiesHttpError(err: unknown): unknown {
    const code = (err as NodeJS.ErrnoException).code;
    if (typeof code !== 'string' || !code.startsWith('HTTP_') || code === 'HTTP_401') return err;
    const status = Number(code.slice(5));
    if (isServerUnavailable(err)) {
      return new KbHttpUnreachableError(
        this.displayUrl, 'GET /api/kb/capabilities', `GET /api/kb/capabilities answered ${(err as Error).message}`,
      );
    }
    return new KbHttpUnsupportedError(
      `GET /api/kb/capabilities (the KB server at ${this.displayUrl} answered HTTP ${status})`,
      'nothing was sent',
      'fix the KB server (or the gateway in front of it) so GET /api/kb/capabilities answers {contract, routes, branch_aware}, or 404/501 when it has no such route.',
    );
  }

  /** E-KB-HTTP-UNSUPPORTED naming `route`: the server does not serve it. */
  private routeUnsupported(route: KbRoute, why: string): KbHttpUnsupportedError {
    return new KbHttpUnsupportedError(
      `the ${route} route (the KB server at ${this.displayUrl} ${why})`,
      'nothing was sent',
      `use a KB server that serves the ${route} route, or a local SQLite KB (kb_setup provider sqlite).`,
    );
  }

  /** Throws E-KB-HTTP-UNSUPPORTED naming `route` unless the server's capabilities list it. */
  private async requireRoute(route: KbRoute): Promise<void> {
    const caps = await this.capabilities();
    if (!caps.routes.includes(route)) throw this.routeUnsupported(route, 'does not list it in GET /api/kb/capabilities');
  }

  /** True when the server's capabilities list `route`. */
  async servesRoute(route: KbRoute): Promise<boolean> {
    return (await this.capabilities()).routes.includes(route);
  }

  /**
   * One request to a route: refused before sending when the server's
   * capabilities do not list it. For an optional route a 404 or 501 also means
   * "not served" and becomes E-KB-HTTP-UNSUPPORTED, never a raw HTTP error --
   * except a 404 whose body code says the ENTRY is unknown (ENTRY_NOT_FOUND /
   * E-ENTRY-NOT-FOUND), which is passed on for the caller to report.
   */
  private async routeRequest<T>(
    route: KbRoute,
    method: string,
    pathname: string,
    body?: unknown,
    queryParams?: Record<string, string>,
  ): Promise<T> {
    try {
      await this.requireRoute(route);
    } catch (err) {
      // Name the operation the caller asked for, not the capabilities read.
      if (err instanceof KbHttpUnreachableError) {
        throw new KbHttpUnreachableError(this.displayUrl, `${method} ${pathname}`, err.causeText);
      }
      throw err;
    }
    try {
      return await this.request<T>(method, pathname, body, queryParams);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const optional = (KB_OPTIONAL_ROUTES as readonly string[]).includes(route);
      const entryNotFound = code === 'HTTP_404' && ENTRY_NOT_FOUND_CODES.has(serverCodeOf(err) ?? '');
      if (optional && !entryNotFound && (code === 'HTTP_404' || code === 'HTTP_501')) {
        throw this.routeUnsupported(route, `answered ${method} ${pathname} with HTTP ${code.slice(5)}`);
      }
      throw err;
    }
  }

  // Stops (keeping the queue) on a connection error AND on E-KB-HTTP-AUTH: an
  // auth failure is not the queued op's fault, and dropping it would lose
  // every queued capture the moment the secret goes wrong. The capabilities
  // are read first, on their own: a failed read (5xx, 403, 401, a malformed
  // answer) is the server's state, not any op's fault, so the whole queue is
  // kept; the caller's own request reads the capabilities again and throws
  // that error to the caller. A 5xx or 429 answering a replayed op is the
  // server's state too: the queue is kept. Any other error is specific to that
  // op, which is dropped with a logged warning.
  private async tryFlushQueue(): Promise<void> {
    if (this.offlineQueue.length === 0) return;
    try {
      await this.capabilities();
    } catch {
      return;
    }
    while (this.offlineQueue.length > 0) {
      const op = this.offlineQueue[0];
      try {
        if (op.op === 'capture') {
          await this.routeRequest(QUEUED_OP_ROUTE.capture, 'POST', '/api/kb/capture', op.input);
        } else if (op.op === 'invalidate') {
          await this.routeRequest(QUEUED_OP_ROUTE.invalidate, 'POST', '/api/kb/invalidate', { files: op.files });
        } else if (op.op === 'feedback') {
          await this.routeRequest(QUEUED_OP_ROUTE.feedback, 'POST', '/api/kb/feedback', { id: op.id, reason: op.reason, role: op.role });
        }
        this.offlineQueue.shift();
      } catch (err) {
        // Queued while the server's capabilities were unknown; now known, the
        // server does not serve this op's route. Never sent: dropped, loudly.
        if (err instanceof KbHttpUnsupportedError) {
          process.stderr.write(`[KB] WARNING: dropped a queued ${op.op}: ${err.message}\n`);
          this.offlineQueue.shift();
          continue;
        }
        // Unreachable, or the wrong project's server: keep the queue for the
        // right server rather than dropping what could not be sent.
        if (err instanceof KbHttpUnreachableError || isAuthError(err) || err instanceof KbHttpProjectMismatchError
          || isServerUnavailable(err)) {
          break;
        }
        process.stderr.write(`[KB] WARNING: dropped a queued ${op.op}: ${(err as Error).message}\n`);
        this.offlineQueue.shift();
      }
    }
  }

  // Nothing to open locally: every operation is a request to the server.
  async init(): Promise<void> {}

  async capture(input: KBEntryInput): Promise<{ id: string; audn_decision: AudnDecision }> {
    await this.tryFlushQueue();
    try {
      return await this.routeRequest<{ id: string; audn_decision: AudnDecision }>(
        'capture', 'POST', '/api/kb/capture', input
      );
    } catch (err) {
      // Queued, and the call still fails with the typed error: the caller
      // must not believe the capture reached the KB.
      if (err instanceof KbHttpUnreachableError || isAuthError(err)) {
        this.enqueue({ op: 'capture', input });
        throw err.asQueued();
      }
      throw err;
    }
  }

  async query(opts: QueryOptions): Promise<KBResult> {
    await this.tryFlushQueue();
    const params: Record<string, string> = {};
    if (opts.query) params.query = opts.query;
    if (opts.type) params.type = opts.type;
    if (opts.limit !== undefined) params.limit = String(opts.limit);
    if (opts.l1_only) params.l1_only = 'true';
    if (opts.include_stale) params.include_stale = 'true';
    if (opts.include_superseded) params.include_superseded = 'true';
    if (opts.confidence?.length) params.confidence = opts.confidence.join(',');
    if (opts.exclude_disputed) params.exclude_disputed = 'true';
    if (opts.flagged_only) params.flagged_only = 'true';
    // Discrete FTS terms travel as a JSON array (a term may contain a comma).
    if (opts.fts_terms?.length) params.fts_terms = JSON.stringify(opts.fts_terms);
    // Exact-id lookup (kb_query's L2 fetch), also a JSON array.
    if (opts.ids?.length) params.ids = JSON.stringify(opts.ids);
    // MEMBER own-scope: the server narrows on the owner tag when the caller
    // set no tag of its own; the result is re-filtered below either way, at
    // every tier. A MEMBER mixed-tier read gets the other members' CONFIRMED
    // entries from its CONFIRMED half (kb-self.ts getMemberSplitRead), never
    // from an owner-tagged read.
    const tag = opts.tag ?? opts.owner_tag;
    if (tag) params.tag = tag;

    const result = await this.routeRequest<KBResult>('query', 'GET', '/api/kb/query', undefined, params);
    return opts.owner_tag ? this.keepOwned(result, opts.owner_tag, opts.tag) : result;
  }

  async context(
    files: string[],
    confidence?: Confidence[],
    excludeDisputed?: boolean,
    ownerTag?: string,
  ): Promise<FileContextResult[]> {
    await this.tryFlushQueue();
    const ctxParams: Record<string, string> = { files: files.join(',') };
    if (confidence?.length) ctxParams.confidence = confidence.join(',');
    if (excludeDisputed) ctxParams.exclude_disputed = 'true';
    // MEMBER own-scope: the server picks each file's newest entry among the
    // caller's own (as the SQLite provider does in SQL), so another member's
    // newer entry cannot hide it; ownership is re-checked below.
    if (ownerTag) ctxParams.tag = ownerTag;
    const result = await this.routeRequest<{ results: FileContextResult[] }>(
      'context', 'GET', '/api/kb/context', undefined, ctxParams
    );
    if (!ownerTag) return result.results;
    return this.keepOwnedSummaries(result.results, await this.ownedIds(ownerTag));
  }

  async discard(_ids: string[], _opts?: RetireOptions): Promise<DiscardResult> {
    throw new KbHttpUnsupportedError('kb_invalidate {ids} (id-level discard)');
  }

  async invalidate(files: string[]): Promise<{ invalidated: number }> {
    await this.tryFlushQueue();
    try {
      return await this.routeRequest<{ invalidated: number }>(
        'invalidate', 'POST', '/api/kb/invalidate', { files }
      );
    } catch (err) {
      if (err instanceof KbHttpUnreachableError || isAuthError(err)) {
        this.enqueue({ op: 'invalidate', files });
        throw err.asQueued();
      }
      throw err;
    }
  }

  /**
   * kb_feedback over the remote KB: POST /api/kb/feedback with the
   * memory-contract v1 kb_feedback request body {id, reason, role} (role
   * carries the already-validated author). The server owns the entry, so the
   * server decides stale/flagged; this method returns its response as is and
   * never writes or invents confidence, and never touches a local store.
   * Server unreachable (E-KB-HTTP-UNREACHABLE) or token refused
   * (E-KB-HTTP-AUTH): the feedback is queued offline (replayed in order with
   * queued captures/invalidates) and the error is rethrown as queued.
   */
  async feedback(id: string, reason: string, author: string): Promise<HttpKbFeedbackResult> {
    await this.tryFlushQueue();
    const body = { id, reason, role: author };
    try {
      return await this.routeRequest<Record<string, unknown>>('feedback', 'POST', '/api/kb/feedback', body);
    } catch (err) {
      if (err instanceof KbHttpUnreachableError || isAuthError(err)) {
        this.enqueue({ op: 'feedback', ...body });
        throw err.asQueued();
      }
      throw err;
    }
  }

  // No remote route for the entry graph, and no local store stands in for the
  // server: an entry's links are not known here.
  async getLinked(_id: string): Promise<KBEntry[]> {
    return [];
  }

  // Delivery telemetry has no remote route. Nothing is written locally: the
  // per-repo DB is not this KB.
  async touch(_ids: string[]): Promise<number> {
    return 0;
  }

  // "Is the row I hold still live CONFIRMED" is a question about a local
  // store; over http there is none. The prime cold seed (the only caller)
  // never runs under an http provider, so reaching this is a bug: refuse
  // rather than answer from a local store.
  getLiveConfirmedState(_ids: string[]): Map<string, boolean> {
    throw new KbHttpUnsupportedError('the bible liveness check', 'nothing was read', 'this is an internal call that must not run under the http KB provider; report it.');
  }

  // No remote route for related claims: degrade to "no related claims"
  // rather than reading a local store.
  async relatedClaims(_ids: string[], _limit?: number, _filter?: EntryTrustFilter): Promise<KBEntry[]> {
    return [];
  }

  async prime(opts: PrimeOptions): Promise<PrimedContext> {
    await this.tryFlushQueue();
    // owner_tag is internal (never part of the contract body); it is applied
    // to the server's answer here instead.
    const { owner_tag: ownerTag, ...body } = opts;
    const primed = await this.routeRequest<PrimedContext>('prime', 'POST', '/api/kb/prime', body);
    if (!ownerTag) return primed;
    const owned = await this.ownedIds(ownerTag);
    return {
      ...primed,
      top_entries: (primed.top_entries ?? []).filter(e => hasTag(e, ownerTag)),
      fresh_summaries: this.keepOwnedSummaries(primed.fresh_summaries ?? [], owned),
    };
  }

  // Remote-only: the id exists on the server, so a connection error is
  // surfaced instead of falling back to the local store or queueing.
  // Promote by id, with no list lookup first: the server refuses an unknown,
  // superseded or out-of-scope id itself, and that refusal is surfaced (a 404
  // as the same "Entry not found: <id>" the SQLite provider throws, any other
  // status with the server's own title/code/detail). opts.ownerTag (MEMBER
  // own-scope) is not checked here: which entries a caller may promote is the
  // server's scope decision, not a fleet-side tag check.
  async promote(
    id: string,
    reason?: string,
    opts?: { ownerTag?: string },
  ): Promise<{ id: string; confidence_before: Confidence; confidence_after: Confidence }> {
    const body: { id: string; reason?: string } = { id };
    if (reason !== undefined) body.reason = reason;
    let result: Record<string, unknown>;
    try {
      result = await this.routeRequest<Record<string, unknown>>('promote', 'POST', '/api/kb/promote', body);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'HTTP_404') {
        throw entryNotFoundOnServer(id, err as NodeJS.ErrnoException);
      }
      throw err;
    }
    const before = result?.previous_confidence;
    const after = result?.new_confidence;
    if (typeof before !== 'string' || typeof after !== 'string') {
      throw new Error(
        `kb_promote: KB server at ${this.displayUrl} returned a promote response without `
        + `previous_confidence/new_confidence: ${JSON.stringify(result)}`,
      );
    }
    return {
      id: typeof result.id === 'string' ? result.id : id,
      confidence_before: before as Confidence,
      confidence_after: after as Confidence,
    };
  }

  /**
   * GET /api/kb/list, an optional route: a server that does not list it, or
   * answers it 404/501, is E-KB-HTTP-UNSUPPORTED rather than a bare HTTP error.
   */
  private async listRequest(params: Record<string, string>): Promise<{ results?: KBEntry[] }> {
    return this.routeRequest<{ results?: KBEntry[] }>('list', 'GET', '/api/kb/list', undefined, params);
  }

  /**
   * Every live entry the server holds with `ownerTag`, any tier. Reads the
   * no-bump list route, so an ownership check is not counted as a retrieval.
   * Asks the server to narrow on the tag and re-checks each entry, so a server
   * that ignores the tag parameter cannot widen the result. Throws
   * KbHttpUnsupportedError when the server returns entries without a tags
   * array: ownership cannot be decided then.
   */
  private async ownedEntries(ownerTag: string): Promise<KBEntry[]> {
    const result = await this.listRequest({
      tag: ownerTag,
      confidence: 'CONFIRMED,INFERRED,UNVERIFIED',
      include_stale: 'true',
      limit: String(OWNED_LOOKUP_LIMIT),
    });
    const entries = result.results ?? [];
    if (entries.some(e => !Array.isArray((e as { tags?: unknown }).tags))) {
      throw new KbHttpUnsupportedError(
        'member own-scope (the server returned entries without tags)',
        'nothing was read',
        'use a KB server that returns entry tags, or a local SQLite KB (kb_setup provider sqlite).',
      );
    }
    return entries.filter(e => hasTag(e, ownerTag));
  }

  private async ownedIds(ownerTag: string): Promise<Set<string>> {
    return new Set((await this.ownedEntries(ownerTag)).map(e => e.id));
  }

  /**
   * kb_list over the server's no-bump GET /api/kb/list route, with the same
   * options as SqliteProvider.list. A MEMBER own-scope read (owner_tag) asks
   * the server to narrow on that tag when the caller set no tag of its own,
   * and is re-filtered on the entries' tags either way. Remote-only: the
   * listing is not answered from a local store when the server is down.
   */
  async list(opts: KbListOptions): Promise<KBEntry[]> {
    const params: Record<string, string> = {};
    if (opts.confidence?.length) params.confidence = opts.confidence.join(',');
    if (opts.type) params.type = opts.type;
    if (opts.module) params.module = opts.module;
    if (opts.symbol) params.symbol = opts.symbol;
    if (opts.exclude_disputed) params.exclude_disputed = 'true';
    if (opts.include_stale) params.include_stale = 'true';
    const tag = opts.tag ?? opts.owner_tag;
    if (tag) params.tag = tag;
    // A limit is only exact when the server applied every filter itself: with
    // both a caller tag and an owner tag, the owner filter runs here, after.
    const filteredHere = opts.owner_tag !== undefined && opts.tag !== undefined;
    if (opts.limit !== undefined && !filteredHere) params.limit = String(opts.limit);
    const result = await this.listRequest(params);
    const entries = result.results ?? [];
    if (opts.owner_tag === undefined) return entries;
    const owned = entries.filter(e => hasTag(e, opts.owner_tag!) && (opts.tag === undefined || hasTag(e, opts.tag)));
    return opts.limit !== undefined ? owned.slice(0, opts.limit) : owned;
  }

  /**
   * Query results restricted to entries carrying ownerTag (and the caller's
   * own tag filter, when it set one). Filtering happens after the server's
   * limit, so a member can get fewer results than it asked for.
   */
  private keepOwned(result: KBResult, ownerTag: string, tag?: string): KBResult {
    const results = (result.results ?? [])
      .filter(e => hasTag(e, ownerTag) && (tag === undefined || hasTag(e, tag)));
    return { ...result, results, total: results.length };
  }

  /**
   * Context summaries carry only an entry id, so ownership is decided against
   * the caller's own entry ids. A summary from another member's entry, or one
   * with no entry id (ownership unknown), is reported as missing for that
   * file, as the SQLite provider does when the caller has no entry for it.
   */
  private keepOwnedSummaries(results: FileContextResult[], owned: Set<string>): FileContextResult[] {
    return results.map(r =>
      r.entry_id === undefined || !owned.has(r.entry_id) ? { file: r.file, status: 'missing' as const } : r);
  }

  /**
   * POST /api/kb/demote {id, reason, evidence_files}: an OPTIONAL route. Only
   * sent when the server's capabilities list demote; otherwise (or on a 404 /
   * 501 from the route) E-KB-HTTP-UNSUPPORTED naming the route, and nothing
   * is changed. Like promote(), sent by id with no fleet-side tag check: the
   * server enforces which ids the caller may demote (opts.ownerTag is not
   * sent). An entry the server does not know is "Entry not found".
   */
  async demote(
    id: string,
    reason: string,
    evidenceFiles: string[],
    _opts?: { ownerTag?: string },
  ): Promise<{ id: string; confidence_before: Confidence; confidence_after: Confidence }> {
    let result: Record<string, unknown>;
    try {
      result = await this.routeRequest<Record<string, unknown>>('demote', 'POST', '/api/kb/demote', {
        id, reason, evidence_files: evidenceFiles,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'HTTP_404') {
        throw entryNotFoundOnServer(id, err as NodeJS.ErrnoException);
      }
      throw err;
    }
    const before = result?.previous_confidence;
    const after = result?.new_confidence;
    if (typeof before !== 'string' || typeof after !== 'string') {
      throw new Error(
        `kb_demote: KB server at ${this.displayUrl} returned a demote response without `
        + `previous_confidence/new_confidence: ${JSON.stringify(result)}`,
      );
    }
    return {
      id: typeof result.id === 'string' ? result.id : id,
      confidence_before: before as Confidence,
      confidence_after: after as Confidence,
    };
  }

  async sync(_opts?: SyncOptions): Promise<SyncResult> {
    return { synced: false, reason: 'local-only provider' };
  }

  // T2.1 (F5, D4): no /api/kb/stats route exists on the remote KB server yet,
  // so this is a documented not-supported result -- NEVER throw. Returns a
  // shape-complete ProviderStats (all-zero/null) so callers do not need a
  // separate branch just to render an unsupported provider.
  async stats(_opts?: { symbols?: string[] }): Promise<ProviderStats> {
    return {
      supported: false,
      reason: 'kb_stats is not supported over the remote HTTP KB provider',
      totals: {
        by_confidence: { CONFIRMED: 0, INFERRED: 0, UNVERIFIED: 0 },
        by_type: { 'context-cache': 0, learning: 0, knowledge: 0, runbook: 0, 'user-directive': 0 },
        total: 0,
      },
      stale: 0,
      flagged: 0,
      superseded: 0,
      retrieval: { entries_retrieved: 0, total_uses: 0, hit_rate: null },
      promote_ratio: null,
    };
  }
}
