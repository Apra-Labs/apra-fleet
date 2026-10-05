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

export async function startKbServer(port: number, generateToken: boolean, dbPath?: string, host?: string): Promise<http.Server> {
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
  process.stderr.write('[kb-server] project=' + providers.projectSlug + '\n');

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

        const result = await provider.query({ query, type, limit, l1_only, confidence, exclude_disputed });
        return jsonResponse(res, 200, result as unknown as Record<string, unknown>);
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

  // apra-fleet-i9ag.15.11: bind an EXPLICIT address with `exclusive: true`,
  // never the OS wildcard -- same defect class as apra-fleet-i9ag.15.9 (see
  // the comment block at packages/apra-fleet-workflow/src/viewer/index.mjs
  // around its server.listen() call).
  //
  // `server.listen(port, cb)` with no host binds the wildcard address. That
  // does NOT give this process exclusive ownership of `127.0.0.1:<port>`:
  // another process can still bind the same port on loopback specifically,
  // that bind succeeds, and because the kernel routes to the most specific
  // match, the newcomer then silently receives every loopback request meant
  // for this KB server -- neither side errors, and clients get the
  // impostor's answers instead of a loud failure. It also exposes this
  // Bearer-token-guarded local surface on every network interface by
  // default, which the supervisor (src/supervisor/server.mjs, bindHost
  // default 127.0.0.1) and the workflow viewer both deliberately refuse to
  // do.
  //
  // Binding loopback explicitly (with an opt-in override for a caller that
  // genuinely wants this reachable off-box) inverts that: a second loopback
  // bind on this port now fails loudly with EADDRINUSE via the 'error'
  // handler below, instead of silently splitting traffic.
  const bindHost = typeof host === 'string' && host.length > 0 ? host : '127.0.0.1';

  return new Promise((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        process.stderr.write(`KB server failed to start: port ${port} is already in use. Try --port ${port + 1}\n`);
        process.exit(1);
      }
      reject(err);
    });

    server.listen({ port, host: bindHost, exclusive: true }, () => {
      process.stderr.write(`KB server listening on http://${bindHost}:${port}\n`);
      resolve(server);
    });
  });
}

// apra-fleet-i9ag.15.11 (rework): kb-server had no discoverable help text at
// all -- `--host` (the escape hatch this bead added for the team-shared
// topology) was only visible by reading source. Exported so src/index.ts's
// `kb-server` branch can print it on `--help`/`-h` before parsing/starting.
export const KB_SERVER_USAGE = `apra-fleet kb-server -- run the team-shared KB server (HTTP REST relay over a SqliteProvider)

Usage:
  apra-fleet kb-server [options]

Options:
  --port <n>          Port to listen on (default: 7878)
  --host <address>    Bind address (default: 127.0.0.1, loopback-only). A
                       team-shared deployment (see docs/knowledge-layer.md,
                       "Central server") MUST pass an address reachable from
                       client machines here -- e.g. --host 0.0.0.0 to bind
                       every interface, or the server's specific LAN/VPN IP.
                       The loopback default means every remote client gets
                       ECONNREFUSED.
  --db <path>         Serve this local SQLite database file instead of the
                       project/global KB the local config would otherwise
                       select. Required if the local KB config itself selects
                       provider=http, since kb-server must never self-proxy
                       to a remote server.
  --generate-token    Generate a new bearer token, print it, and store it
                       (encrypted) for the server to authenticate clients
                       against. Run this once before distributing the token.
  --help, -h          Show this help`;

export function parseKbServerArgs(argv: string[]): { port: number; generateToken: boolean; dbPath?: string; host?: string } {
  let port = 7878;
  let generateToken = false;
  let dbPath: string | undefined;
  // apra-fleet-i9ag.15.11: opt-in escape hatch for a caller that genuinely
  // wants this server reachable off-box (e.g. --host 0.0.0.0). Left
  // undefined by default so startKbServer's own 127.0.0.1 default applies.
  let host: string | undefined;
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
    if (argv[i] === '--host' && argv[i + 1]) {
      host = argv[i + 1];
      i++;
    }
  }
  return { port, generateToken, dbPath, host };
}
