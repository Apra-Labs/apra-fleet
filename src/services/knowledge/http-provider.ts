import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { SqliteProvider } from './sqlite-provider.js';
import type {
  MemoryProvider,
  KBEntry,
  KBEntryInput,
  QueryOptions,
  KBResult,
  FileContextResult,
  PrimeOptions,
  PrimedContext,
  SyncOptions,
  SyncResult,
  AudnDecision,
  Confidence,
  ProviderStats,
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

export class HttpKbProvider implements MemoryProvider {
  private baseUrl: string;
  private readonly token: string;
  private readonly fallback: SqliteProvider;
  readonly offlineQueue: QueuedOperation[] = [];
  private readonly beforeExitHandler: () => void;

  constructor(url: string, token: string, fallback?: SqliteProvider) {
    this.baseUrl = url.replace(/\/$/, '');
    this.token = token;
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

  private rawRequest<T>(
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
        'Authorization': `Bearer ${this.token}`,
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
              const httpErr = new Error(
                `HTTP ${res.statusCode}: ${(parsed as Record<string, string>).error ?? data}`
              ) as NodeJS.ErrnoException;
              httpErr.code = `HTTP_${res.statusCode}`;
              reject(httpErr);
            } else {
              resolve(parsed as T);
            }
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
        if (isConnectionError(err)) {
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

    try {
      return await this.rawRequest<KBResult>('GET', '/api/kb/query', undefined, params);
    } catch (err) {
      if (isConnectionError(err)) {
        return this.fallback.query(opts);
      }
      throw err;
    }
  }

  async context(files: string[]): Promise<FileContextResult[]> {
    await this.tryFlushQueue();
    try {
      const result = await this.rawRequest<{ results: FileContextResult[] }>(
        'GET', '/api/kb/context', undefined, { files: files.join(',') }
      );
      return result.results;
    } catch (err) {
      if (isConnectionError(err)) {
        return this.fallback.context(files);
      }
      throw err;
    }
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
