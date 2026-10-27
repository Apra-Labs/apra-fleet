import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { FLEET_DIR } from '../paths.js';
import { createKbProviders } from '../services/knowledge/kb-providers.js';
import { KB_CONFIG_PATH } from '../services/knowledge/kb-config.js';
import { HttpKbProvider } from '../services/knowledge/http-provider.js';
import { validateFilePaths } from '../services/knowledge/path-validation.js';
import { encryptPassword, decryptPassword } from '../utils/crypto.js';
import { KbCaptureRejected } from '../services/knowledge/types.js';
import { isSqliteProject } from '../services/knowledge/require-sqlite-project.js';
import type { KBEntryInput, Confidence } from '../services/knowledge/types.js';

// my-beads-db-0cd.15 (reopened): startKbServer is an exported library function
// that tests/knowledge/kb-server.test.ts imports and calls IN-PROCESS. The
// http-provider refusal used to call process.exit(1) directly, which would
// kill the vitest worker mid-suite on any host whose KB config selects
// provider=http, instead of failing a test. Throwing a named error (mirroring
// SelfHostedProductionDeployRefusedError, packages/apra-fleet-se/fleet-sprint/
// phases/deploy.mjs) keeps the refusal testable in-process while the CLI
// entry point (src/index.ts's `kb-server` branch) still exits nonzero before
// binding via its existing .catch(err => { ...; process.exit(1); }).
export class KbServerHttpProviderRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KbServerHttpProviderRefusedError';
  }
}

const MAX_BODY_SIZE = 1_048_576; // 1MB

/** Header every HttpKbProvider request carries: the project slug it is for. */
export const KB_PROJECT_HEADER = 'x-kb-project';
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 100;

const TOKEN_DIR = path.join(FLEET_DIR, 'knowledge');
const TOKEN_PATH = path.join(TOKEN_DIR, 'kb-server.token');

// --- Rate limiter ---
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  return bucket.count <= RATE_LIMIT_MAX;
}

// --- Token management ---
function getOrCreateToken(): string {
  if (!fs.existsSync(TOKEN_DIR)) {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
  }
  if (fs.existsSync(TOKEN_PATH)) {
    const encrypted = fs.readFileSync(TOKEN_PATH, 'utf-8').trim();
    return decryptPassword(encrypted);
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_PATH, encryptPassword(token), { mode: 0o600 });
  return token;
}

function generateNewToken(): string {
  if (!fs.existsSync(TOKEN_DIR)) {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_PATH, encryptPassword(token), { mode: 0o600 });
  return token;
}

// --- Helpers ---
function jsonResponse(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('BODY_TOO_LARGE'));
      }
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function getClientIp(req: http.IncomingMessage): string {
  return req.socket.remoteAddress || '0.0.0.0';
}

export async function startKbServer(port: number, generateToken: boolean, dbPath?: string): Promise<http.Server> {
  if (generateToken) {
    const token = generateNewToken();
    process.stderr.write(`KB server token: ${token}\n`);
  }

  const serverToken = getOrCreateToken();
  const providers = await createKbProviders();
  // KB server is a server, not a client: it must never silently become a
  // self-proxying HttpKbProvider just because the local KB config selects
  // provider=http. Fail fast with a single named error before binding rather
  // than accept remote hop behavior no caller of this server asked for.
  //
  // my-beads-db-u00.2: --db is a DELIBERATE escape hatch. An explicit --db
  // names the local database to serve, so the server serves that sqlite file
  // and never self-proxies -- the hazard this refusal exists for cannot arise.
  // The check therefore reads the CONFIG-selected provider, before the --db
  // override replaces it, and only refuses when there is no --db. Either way
  // the HttpKbProvider createKbProviders() already built is disposed first:
  // its constructor registers a process 'beforeExit' listener that only
  // dispose() removes, so dropping it undisposed would leak one per start.
  if (providers.project instanceof HttpKbProvider) {
    providers.project.dispose();
    if (!dbPath) {
      throw new KbServerHttpProviderRefusedError(
        `KB server refuses an http project provider: the KB config at ${KB_CONFIG_PATH} ` +
        `selects provider "http", and kb serve must serve a local database rather than ` +
        `proxy to a remote one. To proceed, either set provider to "sqlite" in that file ` +
        `(or re-run kb_setup with provider=sqlite), or pass --db <path> to serve an ` +
        `explicit local database.`,
      );
    }
  }
  if (dbPath) {
    const { SqliteProvider } = await import('../services/knowledge/sqlite-provider.js');
    // Anchor capture basis checks at process.cwd(), the same repo root
    // createKbProviders() defaults to, so capture behaves identically with
    // and without --db.
    const overrideProvider = new SqliteProvider(dbPath, process.cwd());
    await overrideProvider.init();
    (providers as any).project = overrideProvider;
  }
  const provider = providers.project;
  const serverProject = providers.projectSlug;
  process.stderr.write('[kb-server] project=' + serverProject + '\n');

  const server = http.createServer(async (req, res) => {
    const ip = getClientIp(req);
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method || 'GET';

    // Rate limiting
    if (!checkRateLimit(ip)) {
      res.setHeader('Retry-After', '60');
      return jsonResponse(res, 429, { error: 'Rate limit exceeded', code: 'RATE_LIMIT' });
    }

    // Health check (no auth required)
    if (pathname === '/health' && method === 'GET') {
      return jsonResponse(res, 200, { status: 'ok' });
    }

    // Auth check for all other routes
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return jsonResponse(res, 401, { error: 'Missing or invalid Authorization header', code: 'UNAUTHORIZED' });
    }
    const token = authHeader.slice(7);
    if (token !== serverToken) {
      return jsonResponse(res, 401, { error: 'Invalid token', code: 'UNAUTHORIZED' });
    }

    // One server serves one project. A request for another project (or one
    // that names none) is refused on every route, so a client pointed at the
    // wrong server never reads or writes another repo's KB.
    const clientProject = req.headers[KB_PROJECT_HEADER];
    if (clientProject !== serverProject) {
      const named = typeof clientProject === 'string' ? clientProject : '(none)';
      return jsonResponse(res, 409, {
        error: `KB project mismatch: this server serves "${serverProject}", the request is for "${named}"`,
        code: 'PROJECT_MISMATCH',
        server_project: serverProject,
        client_project: named,
      });
    }

    try {
      // POST /api/kb/capture
      if (pathname === '/api/kb/capture' && method === 'POST') {
        const body = await readBody(req);
        const input = JSON.parse(body) as KBEntryInput;

        if (input.source_files?.length) validateFilePaths(input.source_files);

        const result = await provider.capture(input);
        return jsonResponse(res, 201, result);
      }

      // GET /api/kb/query
      if (pathname === '/api/kb/query' && method === 'GET') {
        const query = url.searchParams.get('query') || undefined;
        const type = url.searchParams.get('type') as any || undefined;
        const limit = url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!, 10) : undefined;
        const l1_only = url.searchParams.get('l1_only') === 'true';
        const confidence = url.searchParams.get('confidence')
          ?.split(',')
          .filter((c): c is Confidence => c === 'CONFIRMED' || c === 'INFERRED' || c === 'UNVERIFIED');
        const exclude_disputed = url.searchParams.get('exclude_disputed') === 'true';
        // tag: exact-match tag filter (HttpKbProvider uses it for the member
        // own-scope lookup, tag=member:<uuid>); a tag alone lists every entry
        // carrying it. include_stale / include_superseded as in kb_query.
        const tag = url.searchParams.get('tag') || undefined;
        const include_stale = url.searchParams.get('include_stale') === 'true';
        const include_superseded = url.searchParams.get('include_superseded') === 'true';
        // flagged_only: list only contradiction-flagged entries (the
        // kb_query flagged_only branch); the trust filters are ignored then.
        const flagged_only = url.searchParams.get('flagged_only') === 'true';

        // fts_terms: JSON array of discrete terms, OR-joined as an FTS match
        // (the kb_session_prime neighbour query sends only these).
        let fts_terms: string[] | undefined;
        const ftsRaw = url.searchParams.get('fts_terms');
        if (ftsRaw) {
          let parsed: unknown;
          try { parsed = JSON.parse(ftsRaw); } catch { parsed = undefined; }
          if (!Array.isArray(parsed) || !parsed.every(t => typeof t === 'string')) {
            return jsonResponse(res, 400, { error: 'fts_terms must be a JSON array of strings', code: 'BAD_REQUEST' });
          }
          fts_terms = parsed;
        }

        const result = await provider.query({
          query, type, tag, limit, l1_only, confidence, exclude_disputed, include_stale, include_superseded,
          flagged_only, fts_terms,
        });
        return jsonResponse(res, 200, result as unknown as Record<string, unknown>);
      }

      // GET /api/kb/list -- the no-bump read (provider.list): use_count and
      // last_accessed are left alone. HttpKbProvider's member own-scope lookup
      // uses it, so checking ownership is not counted as a retrieval.
      if (pathname === '/api/kb/list' && method === 'GET') {
        if (!isSqliteProject(provider)) {
          return jsonResponse(res, 501, { error: 'list is served only from a local SQLite KB', code: 'NOT_IMPLEMENTED' });
        }
        const confidence = url.searchParams.get('confidence')
          ?.split(',')
          .filter((c): c is Confidence => c === 'CONFIRMED' || c === 'INFERRED' || c === 'UNVERIFIED');
        const results = await provider.list({
          tag: url.searchParams.get('tag') || undefined,
          confidence,
          limit: url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!, 10) : undefined,
          include_stale: url.searchParams.get('include_stale') === 'true',
        });
        return jsonResponse(res, 200, { results, total: results.length });
      }

      // POST /api/kb/promote  {id, reason} -> {id, previous_confidence, new_confidence}
      // Same reply shape as the kb_promote tool. An unknown id is 404; any
      // other refusal of the promote ladder (reason, superseded, directive,
      // unresolved basis) is 422 with the provider's message.
      if (pathname === '/api/kb/promote' && method === 'POST') {
        const { id, reason } = JSON.parse(await readBody(req)) as { id?: unknown; reason?: unknown };
        if (typeof id !== 'string' || id.length === 0) {
          return jsonResponse(res, 400, { error: 'id must be a non-empty string', code: 'BAD_REQUEST' });
        }
        if (reason !== undefined && typeof reason !== 'string') {
          return jsonResponse(res, 400, { error: 'reason must be a string', code: 'BAD_REQUEST' });
        }
        try {
          const result = await provider.promote(id, reason);
          return jsonResponse(res, 200, {
            id: result.id,
            previous_confidence: result.confidence_before,
            new_confidence: result.confidence_after,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.startsWith('Entry not found')) {
            return jsonResponse(res, 404, { error: message, code: 'NOT_FOUND' });
          }
          return jsonResponse(res, 422, { error: message, code: 'PROMOTE_REFUSED' });
        }
      }

      // POST /api/kb/invalidate
      if (pathname === '/api/kb/invalidate' && method === 'POST') {
        const body = await readBody(req);
        const { files } = JSON.parse(body) as { files: string[] };

        if (!Array.isArray(files)) {
          return jsonResponse(res, 400, { error: 'files must be an array', code: 'BAD_REQUEST' });
        }
        validateFilePaths(files);

        const result = await provider.invalidate(files);
        return jsonResponse(res, 200, result as unknown as Record<string, unknown>);
      }

      // GET /api/kb/context
      if (pathname === '/api/kb/context' && method === 'GET') {
        const filesParam = url.searchParams.get('files');
        if (!filesParam) {
          return jsonResponse(res, 400, { error: 'files query parameter required', code: 'BAD_REQUEST' });
        }
        const files = filesParam.split(',');
        validateFilePaths(files);

        const ctxConfidence = url.searchParams.get('confidence')
          ?.split(',')
          .filter((c): c is Confidence => c === 'CONFIRMED' || c === 'INFERRED' || c === 'UNVERIFIED');
        const result = await provider.context(files, ctxConfidence, url.searchParams.get('exclude_disputed') === 'true');
        return jsonResponse(res, 200, { results: result });
      }

      // POST /api/kb/prime
      if (pathname === '/api/kb/prime' && method === 'POST') {
        const body = await readBody(req);
        const opts = JSON.parse(body);

        if (opts.session_files?.length) validateFilePaths(opts.session_files);

        const result = await provider.prime(opts);
        return jsonResponse(res, 200, result as unknown as Record<string, unknown>);
      }

      return jsonResponse(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
    } catch (err: unknown) {
      // KB-TRUST PHASE 1: a capture refused for having no checkable basis is a
      // bad request, not a server fault. This route calls provider.capture()
      // directly, bypassing the kb_capture handler entirely, which is why the
      // rule lives in the provider and only its presentation lives here.
      if (err instanceof KbCaptureRejected) {
        return jsonResponse(res, 400, { error: err.message, code: 'CAPTURE_REJECTED', reason: err.reason });
      }
      // A request body that is not JSON is the caller's fault, on every route.
      if (err instanceof SyntaxError) {
        return jsonResponse(res, 400, { error: 'Request body is not valid JSON', code: 'BAD_REQUEST' });
      }
      if (err instanceof Error) {
        if (err.message === 'BODY_TOO_LARGE') {
          return jsonResponse(res, 413, { error: 'Request body too large (max 1MB)', code: 'PAYLOAD_TOO_LARGE' });
        }
        if (err.message.startsWith('Path traversal')) {
          return jsonResponse(res, 400, { error: err.message, code: 'PATH_TRAVERSAL' });
        }
      }
      return jsonResponse(res, 500, { error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        process.stderr.write(`KB server failed to start: port ${port} is already in use. Try --port ${port + 1}\n`);
        process.exit(1);
      }
      reject(err);
    });

    server.listen(port, () => {
      process.stderr.write(`KB server listening on port ${port}\n`);
      resolve(server);
    });
  });
}

export function parseKbServerArgs(argv: string[]): { port: number; generateToken: boolean; dbPath?: string } {
  let port = 7878;
  let generateToken = false;
  let dbPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) {
      port = parseInt(argv[i + 1], 10);
      i++;
    }
    if (argv[i] === '--generate-token') {
      generateToken = true;
    }
    if (argv[i] === '--db' && argv[i + 1]) {
      dbPath = argv[i + 1];
      i++;
    }
  }
  return { port, generateToken, dbPath };
}
