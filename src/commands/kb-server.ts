import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { FLEET_DIR } from '../paths.js';
import { getKBService } from '../services/knowledge/kb-service.js';
import { SqliteProvider } from '../services/knowledge/sqlite-provider.js';
import { validateFilePaths } from '../services/knowledge/path-validation.js';
import { encryptPassword, decryptPassword } from '../utils/crypto.js';
import type { KBEntryInput } from '../services/knowledge/types.js';

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

export async function startKbServer(port: number, generateToken: boolean, dbPath?: string): Promise<http.Server> {
  if (generateToken) {
    const token = generateNewToken();
    process.stderr.write(`KB server token: ${token}\n`);
  }

  const serverToken = getOrCreateToken();
  const service = getKBService(dbPath ? { provider: 'sqlite', dbPath } : undefined);
  const provider = service.getProvider();
  await provider.init();
  if (provider instanceof SqliteProvider) {
    process.stderr.write('[kb-server] Using KB: ' + provider.projectSlug + ' at ' + provider.dbPath + '\n');
  }

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

        const result = await provider.query({ query, type, limit, l1_only });
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

        const result = await provider.context(files);
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
