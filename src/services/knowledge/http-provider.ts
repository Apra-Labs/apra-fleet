import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { SqliteProvider } from './sqlite-provider.js';
import { StaticTokenSource, TOKEN_SOURCE_FAILED, type TokenSource } from './token-source.js';
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

const MAX_QUEUE_SIZE = 1000;
const REQUEST_TIMEOUT_MS = 5000;

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

function errorCode(err: unknown): string | undefined {
  return err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
}

/** HTTP_<status> error. Uses the body's JSON `error` field when there is one, else the raw body. */
function httpStatusError(statusCode: number, body: string): NodeJS.ErrnoException {
  let detail = body;
  try {
    const parsed: unknown = JSON.parse(body);
    const field = parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>).error
      : undefined;
    if (typeof field === 'string') detail = field;
  } catch {
    // Empty or non-JSON error body: keep the raw text as the detail.
  }
  const err = new Error(`HTTP ${statusCode}: ${detail}`) as NodeJS.ErrnoException;
  err.code = `HTTP_${statusCode}`;
  return err;
}

export class HttpKbProvider implements MemoryProvider {
  private baseUrl: string;
  private readonly tokenSource: TokenSource;
  private readonly fallback: SqliteProvider;
  readonly offlineQueue: QueuedOperation[] = [];
  private readonly beforeExitHandler: () => void;

  /** A string token is wrapped in a StaticTokenSource (it can never refresh). */
  constructor(url: string, token: string | TokenSource, fallback?: SqliteProvider) {
    this.baseUrl = url.replace(/\/$/, '');
    this.tokenSource = typeof token === 'string' ? new StaticTokenSource(token) : token;
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
   * One authenticated request. The token is fetched from the source BEFORE the
   * HTTP request exists, so a slow token command never runs under the request
   * timeout. On HTTP 401 a refreshable source is forced to refresh once and the
   * request is retried once; a second 401 (or any 401 with a static token)
   * rejects with HTTP_401. A TOKEN_SOURCE_FAILED error from the source
   * propagates unchanged.
   */
  private async rawRequest<T>(
    method: string,
    pathname: string,
    body?: unknown,
    queryParams?: Record<string, string>
  ): Promise<T> {
    const token = await this.tokenSource.getToken();
    try {
      return await this.sendRequest<T>(token, method, pathname, body, queryParams);
    } catch (err) {
      if (errorCode(err) !== 'HTTP_401' || !this.tokenSource.canRefresh) throw err;
    }
    const refreshed = await this.tokenSource.refresh();
    return this.sendRequest<T>(refreshed, method, pathname, body, queryParams);
  }

  private sendRequest<T>(
    token: string,
    method: string,
    pathname: string,
    body?: unknown,
    queryParams?: Record<string, string>
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
          // Status before parse: an error status with an empty or non-JSON
          // body must still surface as HTTP_<status>, not as invalid JSON.
          if (res.statusCode !== undefined && res.statusCode >= 400) {
            reject(httpStatusError(res.statusCode, data));
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

      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        const err = new Error('ETIMEDOUT: KB server request timed out') as NodeJS.ErrnoException;
        err.code = 'ETIMEDOUT';
        req.destroy(err);
      });

      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  private async tryFlushQueue(): Promise<void> {
    while (this.offlineQueue.length > 0) {
      const op = this.offlineQueue[0];
      try {
        if (op.op === 'capture') {
          await this.rawRequest('POST', '/api/kb/capture', op.input);
        } else if (op.op === 'invalidate') {
          await this.rawRequest('POST', '/api/kb/invalidate', { files: op.files });
        }
        this.offlineQueue.shift();
      } catch (err) {
        // A token that could not be fetched says nothing about the queued op:
        // keep the queue, exactly as for an unreachable server.
        if (isConnectionError(err) || errorCode(err) === TOKEN_SOURCE_FAILED) {
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
      return await this.rawRequest<{ id: string; audn_decision: AudnDecision }>(
        'POST', '/api/kb/capture', input
      );
    } catch (err) {
      if (isConnectionError(err)) {
        this.enqueue({ op: 'capture', input });
        return { id: `offline-${randomBytes(8).toString('hex')}`, audn_decision: 'add' };
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
      return await this.rawRequest<KBResult>('GET', '/api/kb/query', undefined, params);
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
      const result = await this.rawRequest<{ results: FileContextResult[] }>(
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
      return await this.rawRequest<{ invalidated: number }>(
        'POST', '/api/kb/invalidate', { files }
      );
    } catch (err) {
      if (isConnectionError(err)) {
        this.enqueue({ op: 'invalidate', files });
        return { invalidated: 0 };
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
      return await this.rawRequest<PrimedContext>('POST', '/api/kb/prime', opts);
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
