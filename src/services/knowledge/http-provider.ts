import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { SqliteProvider } from './sqlite-provider.js';
import { logWarn } from '../../utils/log-helpers.js';
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

/**
 * Typed refusal for a KB server that serves a different project than the one
 * the request is for (HTTP 409). Never answered from the local fallback store:
 * the server is reachable, it is just the wrong one.
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

/** Header carrying the project slug on every request (checked by kb-server). */
export const KB_PROJECT_HEADER = 'X-KB-Project';

export class HttpKbProvider implements MemoryProvider {
  private baseUrl: string;
  /** baseUrl with any user:password removed: the only form put in error text. */
  private readonly displayUrl: string;
  private readonly token: string;
  private readonly projectSlug: string | undefined;
  private readonly fallback: SqliteProvider;
  private readonly requestTimeoutMs: number;
  readonly offlineQueue: QueuedOperation[] = [];
  private readonly beforeExitHandler: () => void;
  /**
   * Where query/context/prime are answered when the server is unreachable:
   * the per-repo fallback store, unless withOfflineReads() replaced it.
   */
  private offlineReads: () => Promise<MemoryProvider>;
  private offlineReadWarning: string | undefined;

  constructor(url: string, token: string, fallback?: SqliteProvider, options: HttpKbProviderOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.baseUrl = url.replace(/\/$/, '');
    this.displayUrl = redactUrlUserinfo(this.baseUrl);
    this.token = token;
    this.projectSlug = options.projectSlug;
    this.fallback = fallback ?? new SqliteProvider();
    const fallbackStore = this.fallback;
    this.offlineReads = async () => fallbackStore;

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

  /**
   * This provider, with query/context/prime answered by `reads` (and a
   * warning logged) when the server is unreachable, instead of by the per-repo
   * fallback store. Used for MEMBER CONFIRMED reads, whose offline answer is
   * the checkout bible. The view shares this provider's connection settings,
   * offline queue and exit hook (prototype delegation), so it is not a second
   * client.
   */
  withOfflineReads(reads: () => Promise<MemoryProvider>, warning: string): HttpKbProvider {
    const view = Object.create(this) as HttpKbProvider;
    view.offlineReads = reads;
    view.offlineReadWarning = warning;
    return view;
  }

  private async offlineReadProvider(): Promise<MemoryProvider> {
    if (this.offlineReadWarning !== undefined) logWarn('kb-http', this.offlineReadWarning);
    return this.offlineReads();
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
        // Unreachable, or the wrong project's server: keep the queue for the
        // right server rather than dropping what could not be sent.
        if (isConnectionError(err) || err instanceof KbHttpProjectMismatchError) {
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
    if (opts.flagged_only) params.flagged_only = 'true';
    // MEMBER own-scope: the server narrows on the owner tag when the caller
    // set no tag of its own; the result is re-filtered below either way.
    // A mixed-tier read that names CONFIRMED must get the server's full
    // CONFIRMED set, so the owner tag is not sent then; keepOwned narrows the
    // other tiers fleet-side.
    const ownerNarrowsServer = opts.owner_tag !== undefined && !opts.confidence?.includes('CONFIRMED');
    const tag = opts.tag ?? (ownerNarrowsServer ? opts.owner_tag : undefined);
    if (tag) params.tag = tag;

    try {
      const result = await this.rawRequest<KBResult>('GET', '/api/kb/query', undefined, params);
      return opts.owner_tag ? this.keepOwned(result, opts.owner_tag, opts.tag, opts.confidence) : result;
    } catch (err) {
      if (isConnectionError(err)) {
        return (await this.offlineReadProvider()).query(opts);
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
      return this.keepOwnedSummaries(
        result.results, await this.ownedIds(ownerTag), await this.confirmedIdsIfRequested(confidence));
    } catch (err) {
      if (isConnectionError(err)) {
        return (await this.offlineReadProvider()).context(files, confidence, excludeDisputed, ownerTag);
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
      const confirmed = await this.confirmedIdsIfRequested(opts.confidence);
      return {
        ...primed,
        top_entries: (primed.top_entries ?? []).filter(e => this.visibleToOwner(e, ownerTag, opts.confidence)),
        fresh_summaries: this.keepOwnedSummaries(primed.fresh_summaries ?? [], owned, confirmed),
      };
    } catch (err) {
      if (isConnectionError(err)) {
        return (await this.offlineReadProvider()).prime(opts);
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
          `kb_promote failed: KB server at ${this.displayUrl} is unreachable (${(err as Error).message}); `
          + 'nothing was promoted and no offline fallback is used for promote.',
        );
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
   * Every live entry the server holds with `ownerTag`, any tier. Reads the
   * no-bump list route, so an ownership check is not counted as a retrieval.
   * Asks the server to narrow on the tag and re-checks each entry, so a server
   * that ignores the tag parameter cannot widen the result. Throws
   * KbHttpUnsupportedError when the server returns entries without a tags
   * array: ownership cannot be decided then.
   */
  private async ownedEntries(ownerTag: string): Promise<KBEntry[]> {
    const result = await this.rawRequest<{ results?: KBEntry[] }>('GET', '/api/kb/list', undefined, {
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
   * MEMBER mixed-tier visibility, matching the SQLite split read: a CONFIRMED
   * entry is visible to every member when the read named the CONFIRMED tier;
   * any other tier is visible only to the member whose owner tag it carries.
   */
  private visibleToOwner(e: KBEntry, ownerTag: string, confidence?: Confidence[]): boolean {
    return (e.confidence === 'CONFIRMED' && confidence?.includes('CONFIRMED') === true) || hasTag(e, ownerTag);
  }

  /** Ids of every CONFIRMED entry on the server, or none when CONFIRMED was not requested. */
  private async confirmedIdsIfRequested(confidence?: Confidence[]): Promise<Set<string>> {
    if (!confidence?.includes('CONFIRMED')) return new Set();
    const result = await this.rawRequest<{ results?: KBEntry[] }>('GET', '/api/kb/list', undefined, {
      confidence: 'CONFIRMED',
      limit: String(OWNED_LOOKUP_LIMIT),
    });
    return new Set((result.results ?? []).filter(e => e.confidence === 'CONFIRMED').map(e => e.id));
  }

  /**
   * Query results restricted to entries carrying ownerTag (and the caller's
   * own tag filter, when it set one). Filtering happens after the server's
   * limit, so a member can get fewer results than it asked for.
   */
  private keepOwned(result: KBResult, ownerTag: string, tag?: string, confidence?: Confidence[]): KBResult {
    const results = (result.results ?? [])
      .filter(e => this.visibleToOwner(e, ownerTag, confidence) && (tag === undefined || hasTag(e, tag)));
    return { ...result, results, total: results.length };
  }

  /**
   * Context summaries carry only an entry id, so ownership is decided against
   * the caller's own entry ids. A summary from another member's entry, or one
   * with no entry id (ownership unknown), is reported as missing for that
   * file, as the SQLite provider does when the caller has no entry for it.
   */
  private keepOwnedSummaries(
    results: FileContextResult[], owned: Set<string>, confirmed: Set<string> = new Set(),
  ): FileContextResult[] {
    return results.map(r =>
      r.entry_id === undefined || !(owned.has(r.entry_id) || confirmed.has(r.entry_id)) ? { file: r.file, status: 'missing' as const } : r);
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
