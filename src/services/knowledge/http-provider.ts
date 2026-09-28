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

  // apra-fleet-i9ag.15.13: a configured-but-unreachable remote must produce an
  // observable signal, not a silent local read. `degraded` is the state a
  // fallback-serving call flips on; `degradedReason`/`degradedSince` are
  // surfaced through stats() (kb_stats) so the degradation is inspectable
  // outside the process, not just in stderr. `hasWarnedDegraded` gates the
  // stderr warning so a single lost connection does not spam every call, but
  // is reset on reconnect so a LATER drop warns again ("at least once per
  // session" per drop, not once ever).
  private degraded = false;
  private degradedReason?: string;
  private degradedSince?: string;
  private hasWarnedDegraded = false;

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

  // apra-fleet-i9ag.15.13: called from every fallback branch (read AND write)
  // so a team that loses connectivity to its remote KB server has a signal on
  // every surface that matters -- stderr for a human watching the process, and
  // stats() (below) for a caller inspecting it programmatically. Naming the
  // configured remote URL and the actual connection error (not just "offline")
  // is the point: this is explicit configuration plus loud failure, not the
  // silent local read this bead replaces.
  private markDegraded(err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err);
    if (!this.degraded) {
      this.degraded = true;
      this.degradedSince = new Date().toISOString();
    }
    this.degradedReason = reason;
    if (!this.hasWarnedDegraded) {
      this.hasWarnedDegraded = true;
      process.stderr.write(
        `[KB] WARNING: remote KB server at ${this.baseUrl} is unreachable (${reason}). ` +
        `Serving reads from the local fallback KB and queuing writes -- team-shared truth ` +
        `is NOT being consulted until connectivity is restored.\n`
      );
    }
  }

  // Flips the degraded state back off on the first request that actually
  // succeeds, and re-arms the stderr warning so a LATER disconnect is
  // reported again rather than staying silent for the rest of the session.
  private markConnected(): void {
    if (this.degraded) {
      this.degraded = false;
      this.degradedReason = undefined;
      this.degradedSince = undefined;
      this.hasWarnedDegraded = false;
      process.stderr.write(`[KB] Reconnected to remote KB server at ${this.baseUrl}.\n`);
    }
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
        this.markConnected();
      } catch (err) {
        if (isConnectionError(err)) {
          this.markDegraded(err);
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
      const result = await this.rawRequest<{ id: string; audn_decision: AudnDecision }>(
        'POST', '/api/kb/capture', input
      );
      this.markConnected();
      return result;
    } catch (err) {
      if (isConnectionError(err)) {
        this.markDegraded(err);
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
      const result = await this.rawRequest<KBResult>('GET', '/api/kb/query', undefined, params);
      this.markConnected();
      return result;
    } catch (err) {
      if (isConnectionError(err)) {
        this.markDegraded(err);
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
      this.markConnected();
      return result.results;
    } catch (err) {
      if (isConnectionError(err)) {
        this.markDegraded(err);
        return this.fallback.context(files);
      }
      throw err;
    }
  }

  async invalidate(files: string[]): Promise<{ invalidated: number }> {
    await this.tryFlushQueue();
    try {
      const result = await this.rawRequest<{ invalidated: number }>(
        'POST', '/api/kb/invalidate', { files }
      );
      this.markConnected();
      return result;
    } catch (err) {
      if (isConnectionError(err)) {
        this.markDegraded(err);
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
  async relatedClaims(ids: string[], limit?: number): Promise<KBEntry[]> {
    try {
      return await this.fallback.relatedClaims(ids, limit);
    } catch {
      return [];
    }
  }

  async prime(opts: PrimeOptions): Promise<PrimedContext> {
    await this.tryFlushQueue();
    try {
      const result = await this.rawRequest<PrimedContext>('POST', '/api/kb/prime', opts);
      this.markConnected();
      return result;
    } catch (err) {
      if (isConnectionError(err)) {
        this.markDegraded(err);
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
  //
  // apra-fleet-i9ag.15.13: `supported: false` is a static property of this
  // provider kind (kb_stats has no remote route at all) and is orthogonal to
  // `degraded`, which reflects whether the remote configured via kb_setup is
  // CURRENTLY reachable. Surfacing degraded/degraded_reason/remote_url here
  // means a caller can inspect "am I silently reading local data instead of
  // the team-shared KB" without watching stderr for the one-time warning.
  async stats(_opts?: { symbols?: string[] }): Promise<ProviderStats> {
    return {
      supported: false,
      reason: 'kb_stats is not supported over the remote HTTP KB provider',
      degraded: this.degraded,
      degraded_reason: this.degradedReason,
      degraded_since: this.degradedSince,
      remote_url: this.baseUrl,
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
