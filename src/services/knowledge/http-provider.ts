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

const MAX_QUEUE_SIZE = 1000;
const REQUEST_TIMEOUT_MS = 5000;
// Most entries one owner-tag lookup reads back. An owned entry beyond it is
// reported not-found (a refusal, never a wrong promote).
const OWNED_LOOKUP_LIMIT = 1000;

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
  if (typeof body.error === 'string') return boundErrorText(body.error);
  const parts = [body.title, body.code, body.detail]
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  return boundErrorText(parts.length > 0 ? parts.join(' - ') : data);
}

/** True when the entry carries `tag`; an entry without a tags array is never owned. */
function hasTag(entry: { tags?: unknown }, tag: string): boolean {
  return Array.isArray(entry.tags) && entry.tags.includes(tag);
}

/**
 * Typed refusal for an operation the http KB provider does not support (and
 * deliberately does not emulate through the local fallback store).
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
          const status = res.statusCode;
          if (status !== undefined && status >= 400) {
            const httpErr = new Error(`HTTP ${status}: ${describeErrorBody(data)}`) as NodeJS.ErrnoException;
            httpErr.code = `HTTP_${status}`;
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
    if (opts.confidence?.length) params.confidence = opts.confidence.join(',');
    if (opts.exclude_disputed) params.exclude_disputed = 'true';
    // MEMBER own-scope: the server narrows on the owner tag when the caller
    // set no tag of its own; the result is re-filtered below either way.
    const tag = opts.tag ?? opts.owner_tag;
    if (tag) params.tag = tag;

    try {
      const result = await this.rawRequest<KBResult>('GET', '/api/kb/query', undefined, params);
      return opts.owner_tag ? this.keepOwned(result, opts.owner_tag, opts.tag) : result;
    } catch (err) {
      if (isConnectionError(err)) {
        return this.fallback.query(opts);
      }
      throw err;
    }
  }

  async context(
    files: string[],
    confidence?: Confidence[],
    excludeDisputed?: boolean,
    ownerTag?: string,
  ): Promise<FileContextResult[]> {
    await this.tryFlushQueue();
    try {
      const ctxParams: Record<string, string> = { files: files.join(',') };
      if (confidence?.length) ctxParams.confidence = confidence.join(',');
      if (excludeDisputed) ctxParams.exclude_disputed = 'true';
      const result = await this.rawRequest<{ results: FileContextResult[] }>(
        'GET', '/api/kb/context', undefined, ctxParams
      );
      if (!ownerTag) return result.results;
      return this.keepOwnedSummaries(result.results, await this.ownedIds(ownerTag));
    } catch (err) {
      if (isConnectionError(err)) {
        return this.fallback.context(files, confidence, excludeDisputed, ownerTag);
      }
      throw err;
    }
  }

  async discard(_ids: string[], _opts?: RetireOptions): Promise<DiscardResult> {
    throw new KbHttpUnsupportedError('kb_invalidate {ids} (id-level discard)');
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
    // owner_tag is internal (never part of the contract body); it is applied
    // to the server's answer here instead.
    const { owner_tag: ownerTag, ...body } = opts;
    try {
      const primed = await this.rawRequest<PrimedContext>('POST', '/api/kb/prime', body);
      if (!ownerTag) return primed;
      const owned = await this.ownedIds(ownerTag);
      return {
        ...primed,
        top_entries: (primed.top_entries ?? []).filter(e => hasTag(e, ownerTag)),
        fresh_summaries: this.keepOwnedSummaries(primed.fresh_summaries ?? [], owned),
      };
    } catch (err) {
      if (isConnectionError(err)) {
        return this.fallback.prime(opts);
      }
      throw err;
    }
  }

  // Remote-only: the id exists on the server, so a connection error is
  // surfaced instead of falling back to the local store or queueing.
  // opts.ownerTag (MEMBER own-scope): the entry must carry that tag, checked
  // fleet-side before the promote is sent; any other id is the same
  // not-found the SQLite provider gives.
  async promote(
    id: string,
    reason?: string,
    opts?: { ownerTag?: string },
  ): Promise<{ id: string; confidence_before: Confidence; confidence_after: Confidence }> {
    const body: { id: string; reason?: string } = { id };
    if (reason !== undefined) body.reason = reason;
    let result: Record<string, unknown>;
    try {
      if (opts?.ownerTag) await this.requireOwnedEntry(id, opts.ownerTag);
      result = await this.rawRequest<Record<string, unknown>>('POST', '/api/kb/promote', body);
    } catch (err) {
      if (isConnectionError(err)) {
        throw new Error(
          `kb_promote failed: KB server at ${this.baseUrl} is unreachable (${(err as Error).message}); `
          + 'nothing was promoted and no offline fallback is used for promote.',
        );
      }
      throw err;
    }
    const before = result?.previous_confidence;
    const after = result?.new_confidence;
    if (typeof before !== 'string' || typeof after !== 'string') {
      throw new Error(
        `kb_promote: KB server at ${this.baseUrl} returned a promote response without `
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
   * Every live entry the server holds with `ownerTag`, any tier. Asks the
   * server to narrow on the tag and re-checks each entry, so a server that
   * ignores the tag parameter cannot widen the result. Throws
   * KbHttpUnsupportedError when the server returns entries without a tags
   * array: ownership cannot be decided then.
   */
  private async ownedEntries(ownerTag: string): Promise<KBEntry[]> {
    const result = await this.rawRequest<KBResult>('GET', '/api/kb/query', undefined, {
      tag: ownerTag,
      confidence: 'CONFIRMED,INFERRED,UNVERIFIED',
      include_stale: 'true',
      limit: String(OWNED_LOOKUP_LIMIT),
    });
    const entries = result.results ?? [];
    if (entries.some(e => !Array.isArray((e as { tags?: unknown }).tags))) {
      throw new KbHttpUnsupportedError(
        'member own-scope (the server returned entries without tags)',
        'nothing was promoted or read',
        'use a KB server that returns entry tags, or a local SQLite KB (kb_setup provider sqlite).',
      );
    }
    return entries.filter(e => hasTag(e, ownerTag));
  }

  private async ownedIds(ownerTag: string): Promise<Set<string>> {
    return new Set((await this.ownedEntries(ownerTag)).map(e => e.id));
  }

  private async requireOwnedEntry(id: string, ownerTag: string): Promise<void> {
    const owned = await this.ownedIds(ownerTag);
    if (!owned.has(id)) throw new Error(`Entry not found: ${id}`);
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
   * the caller's own entry ids. A summary from another member's entry is
   * reported as missing for that file, as the SQLite provider does when the
   * caller has no entry for it.
   */
  private keepOwnedSummaries(results: FileContextResult[], owned: Set<string>): FileContextResult[] {
    return results.map(r =>
      r.entry_id !== undefined && !owned.has(r.entry_id) ? { file: r.file, status: 'missing' as const } : r);
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
