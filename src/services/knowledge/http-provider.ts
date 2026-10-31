import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { SqliteProvider } from './sqlite-provider.js';
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

export { DEFAULT_REQUEST_TIMEOUT_MS };

const MAX_QUEUE_SIZE = 1000;

/**
 * Optional settings for HttpKbProvider. An options object rather than more
 * positional parameters, so new settings can be added without changing the
 * constructor signature.
 */
export interface HttpKbProviderOptions {
  /** Socket idle timeout per request, in ms; absent means DEFAULT_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
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
 * operation (a capture or invalidate) was kept in the offline queue and will
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

function isHttp401(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'HTTP_401';
}

/** Defensive: a server that echoes the Authorization header must not leak the token into an error. */
function redactToken(text: string, token: string): string {
  return token ? text.split(token).join('[REDACTED]') : text;
}

type QueuedOperation =
  | { op: 'capture'; input: KBEntryInput }
  | { op: 'invalidate'; files: string[] };

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

export class HttpKbProvider implements MemoryProvider {
  private baseUrl: string;
  private readonly tokenSource: KbHttpTokenSource;
  private readonly fallback: SqliteProvider;
  private readonly requestTimeoutMs: number;
  readonly offlineQueue: QueuedOperation[] = [];
  private readonly beforeExitHandler: () => void;

  constructor(url: string, token: KbHttpTokenSource, fallback?: SqliteProvider, options: HttpKbProviderOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.baseUrl = url.replace(/\/$/, '');
    this.tokenSource = token;
    this.fallback = fallback ?? new SqliteProvider();

    this.beforeExitHandler = () => {
      if (this.offlineQueue.length > 0) {
        process.stderr.write(
          `[KB] WARNING: offline queue has ${this.offlineQueue.length} unsaved captures. ` +
          `Reconnect to the KB server and run kb_harvest to recover from the session transcript.\n`
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
    for (let attempt = 1; ; attempt++) {
      const token = this.resolveToken();
      try {
        const result = await this.rawRequest<T>(token, method, pathname, body, queryParams, secretName !== undefined);
        recordKbHttpSuccess(this.baseUrl);
        return result;
      } catch (err) {
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
        'Authorization': `Bearer ${token}`,
      };
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
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode !== undefined && res.statusCode >= 400) {
              const httpErr = new Error(redactToken(
                `HTTP ${res.statusCode}: ${(parsed as Record<string, string>).error ?? data}`, token,
              )) as NodeJS.ErrnoException;
              httpErr.code = `HTTP_${res.statusCode}`;
              reject(httpErr);
            } else {
              resolve(parsed as T);
            }
          } catch {
            // An auth proxy in front of the KB (e.g. Entra) answers 401 with
            // an empty or HTML body. For a named-secret token that must still
            // count as a 401 so the re-read-and-retry runs. A literal token
            // keeps the old error unchanged.
            if (nonJson401IsAuth && res.statusCode === 401) {
              const authErr = new Error('HTTP 401: KB server rejected the token') as NodeJS.ErrnoException;
              authErr.code = 'HTTP_401';
              reject(authErr);
              return;
            }
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

  // Stops (keeping the queue) on a connection error AND on E-KB-HTTP-AUTH: an
  // auth failure is not the queued op's fault, and dropping it would lose
  // every queued capture the moment the secret goes wrong. Any other error is
  // specific to that op, which is dropped as before.
  private async tryFlushQueue(): Promise<void> {
    while (this.offlineQueue.length > 0) {
      const op = this.offlineQueue[0];
      try {
        if (op.op === 'capture') {
          await this.request('POST', '/api/kb/capture', op.input);
        } else if (op.op === 'invalidate') {
          await this.request('POST', '/api/kb/invalidate', { files: op.files });
        }
        this.offlineQueue.shift();
      } catch (err) {
        if (isConnectionError(err) || isAuthError(err)) {
          break;
        }
        this.offlineQueue.shift();
      }
    }
  }

  async init(): Promise<void> {
    await this.fallback.init();
  }

  async capture(input: KBEntryInput): Promise<{ id: string; audn_decision: AudnDecision }> {
    await this.tryFlushQueue();
    try {
      return await this.request<{ id: string; audn_decision: AudnDecision }>(
        'POST', '/api/kb/capture', input
      );
    } catch (err) {
      if (isConnectionError(err)) {
        this.enqueue({ op: 'capture', input });
        return { id: `offline-${randomBytes(8).toString('hex')}`, audn_decision: 'add' };
      }
      if (isAuthError(err)) {
        // Queued exactly as for server-down, but the call still fails with
        // E-KB-HTTP-AUTH: unlike an outage, this needs the operator to act.
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

    try {
      return await this.request<KBResult>('GET', '/api/kb/query', undefined, params);
    } catch (err) {
      if (isConnectionError(err)) {
        return this.fallback.query(opts);
      }
      throw err;
    }
  }

  async context(files: string[], confidence?: Confidence[], excludeDisputed?: boolean): Promise<FileContextResult[]> {
    await this.tryFlushQueue();
    try {
      const ctxParams: Record<string, string> = { files: files.join(',') };
      if (confidence?.length) ctxParams.confidence = confidence.join(',');
      if (excludeDisputed) ctxParams.exclude_disputed = 'true';
      const result = await this.request<{ results: FileContextResult[] }>(
        'GET', '/api/kb/context', undefined, ctxParams
      );
      return result.results;
    } catch (err) {
      if (isConnectionError(err)) {
        return this.fallback.context(files, confidence, excludeDisputed);
      }
      throw err;
    }
  }

  async discard(_ids: string[], _opts?: RetireOptions): Promise<DiscardResult> {
    throw new Error('kb_invalidate {ids} (id-level discard) is not supported by the HTTP KB provider');
  }

  async invalidate(files: string[]): Promise<{ invalidated: number }> {
    await this.tryFlushQueue();
    try {
      return await this.request<{ invalidated: number }>(
        'POST', '/api/kb/invalidate', { files }
      );
    } catch (err) {
      if (isConnectionError(err)) {
        this.enqueue({ op: 'invalidate', files });
        return { invalidated: 0 };
      }
      if (isAuthError(err)) {
        this.enqueue({ op: 'invalidate', files });
        throw err.asQueued();
      }
      throw err;
    }
  }

  async getLinked(id: string): Promise<KBEntry[]> {
    return this.fallback.getLinked(id);
  }

  // Delegated to the local fallback store like getLinked: delivery telemetry is
  // a property of the KB the entries were read out of, and there is no remote
  // route for it. Never throws -- a telemetry write must not fail a prime.
  async touch(ids: string[]): Promise<number> {
    try {
      return await this.fallback.touch(ids);
    } catch {
      return 0;
    }
  }

  // Delegated to the local fallback store like touch: "is the row I hold still
  // live CONFIRMED" is a question about the LOCAL store by definition, and
  // there is no remote route for it. An unreadable local store degrades to an
  // empty map, i.e. "no local row for any of these" -- the cold seed then
  // behaves exactly as it did before this predicate existed.
  getLiveConfirmedState(ids: string[]): Map<string, boolean> {
    try {
      return this.fallback.getLiveConfirmedState(ids);
    } catch {
      return new Map();
    }
  }

  // Delegated to the local store like getLinked: the graph lives alongside the
  // entries, and there is no remote route for it. Never throws -- a graph miss
  // must degrade to "no related claims", not fail a prime.
  async relatedClaims(ids: string[], limit?: number, filter?: EntryTrustFilter): Promise<KBEntry[]> {
    try {
      return await this.fallback.relatedClaims(ids, limit, filter);
    } catch {
      return [];
    }
  }

  async prime(opts: PrimeOptions): Promise<PrimedContext> {
    await this.tryFlushQueue();
    try {
      return await this.request<PrimedContext>('POST', '/api/kb/prime', opts);
    } catch (err) {
      if (isConnectionError(err)) {
        return this.fallback.prime(opts);
      }
      throw err;
    }
  }

  async promote(
    id: string,
    reason?: string
  ): Promise<{ id: string; confidence_before: Confidence; confidence_after: Confidence }> {
    return this.fallback.promote(id, reason);
  }

  /**
   * kb_demote is NOT delegated to the local fallback the way promote() is, and
   * that asymmetry is deliberate. A demotion's whole value is its
   * demoted_basis_hashes snapshot of the cited files as they are on disk at
   * demote time; the fallback store is this host's local cache, not the remote
   * KB that owns the entry, so a "successful" demote here would stamp a basis
   * taken from the wrong tree onto a row nobody else ever sees. Refuse loudly
   * and write NOTHING, as discard() does for the same class of operation.
   */
  async demote(
    _id: string,
    _reason: string,
    _evidenceFiles: string[],
    _opts?: { ownerTag?: string },
  ): Promise<{ id: string; confidence_before: Confidence; confidence_after: Confidence }> {
    throw new Error('kb_demote is not supported for an HTTP KB: the remote provider has no demote route, and demoting against the local fallback store would snapshot the wrong tree. Nothing was changed.');
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
