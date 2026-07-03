import http from 'node:http';
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { fleetEvents, FleetEventMap } from './event-bus.js';
import { verify as verifyJwt, type JwtClaims } from './jwt.js';
import { sessionRegistry } from './session-registry.js';
import { DEFAULT_PORT } from '../paths.js';
import { serverVersion } from '../version.js';
import { logLine } from '../utils/log-helpers.js';

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export interface HttpTransportOptions {
  registerTools: (server: McpServer) => void | Promise<void>;
  preferredPort?: number;
}

export interface HttpTransportHandle {
  httpServer: http.Server;
  port: number;
  url: string;
  sessions: Map<string, Session>;
  close(): Promise<void>;
}

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : undefined);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function listenOnPort(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      const addr = server.address() as { port: number };
      resolve(addr.port);
    });
    server.once('error', reject);
  });
}

function isInitializeRequest(body: unknown): boolean {
  if (!body) return false;
  if (Array.isArray(body)) {
    return body.some((msg: unknown) => (msg as { method?: string }).method === 'initialize');
  }
  return (body as { method?: string }).method === 'initialize';
}

function extractBearer(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

export async function createHttpTransport(options: HttpTransportOptions): Promise<HttpTransportHandle> {
  const { registerTools, preferredPort } = options;
  const sessions = new Map<string, Session>();
  const startedAt = Date.now();

  // LOW-1: Track event listener references for cleanup in close()
  const eventCleanups: Array<() => void> = [];

  async function handleSessionRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      res.writeHead(400);
      res.end('Missing mcp-session-id header');
      return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      res.writeHead(404);
      res.end('Session not found');
      return;
    }
    await session.transport.handleRequest(req, res);
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = req.url ?? '/';

    if (url === '/health' && req.method === 'GET') {
      const body = JSON.stringify({
        status: 'ok',
        version: serverVersion,
        pid: process.pid,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        sessions: sessions.size,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    if (url === '/shutdown' && req.method === 'POST') {
      const body = JSON.stringify({ status: 'shutting-down' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      setTimeout(() => {
        process.emit('SIGINT');
      }, 100);
      return;
    }

    if (url !== '/mcp' && !url.startsWith('/mcp?')) {
      res.writeHead(404);
      res.end();
      return;
    }

    if (req.method === 'POST') {
      // JWT auth: verify Bearer token if present; unauthenticated (PM/tool) connections pass through
      const rawToken = extractBearer(req);
      const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
      const memberParam = parsedUrl.searchParams.get('member');
      let postClaims: JwtClaims | null = null;
      if (rawToken !== null) {
        postClaims = verifyJwt(rawToken);
        if (!postClaims) {
          logLine('session', `jwt verify failed for member_param=${memberParam ?? 'none'} url=${req.url}`);
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid token' }));
          return;
        }
      }
      if (rawToken === null && memberParam !== null) {
        logLine('session', 'member identity from URL param: ' + memberParam);
      }

      let parsedBody: unknown;
      try {
        parsedBody = await parseBody(req);
      } catch {
        res.writeHead(400);
        res.end('Bad request body');
        return;
      }

      if (isInitializeRequest(parsedBody)) {
        logLine('session', `initialize jwt=${rawToken !== null} jwt_valid=${postClaims !== null} member_param=${memberParam ?? 'none'}`);
        const body = parsedBody as {
          params?: {
            clientInfo?: { name?: string; version?: string };
            capabilities?: Record<string, unknown>;
          };
        };
        const clientInfo = body?.params?.clientInfo ?? {};
        const clientCaps = body?.params?.capabilities ?? {};
        const capKeys = Object.keys(clientCaps).join(',');


        const sessionServer = new McpServer(
          { name: `apra fleet server ${serverVersion}`, version: serverVersion },
          { capabilities: { logging: {}, experimental: { 'claude/channel': {} } } }
        );
        const sessionTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { server: sessionServer, transport: sessionTransport });
            const hasMember = !!(postClaims || memberParam);
            logLine('session', `new sid=${sid} client=${clientInfo.name ?? 'unknown'}/${clientInfo.version ?? 'unknown'} caps=${capKeys || 'none'} member=${hasMember}`);
            // Register interactive member session when JWT claims are present
            if (postClaims) {
              sessionRegistry.register(postClaims.member_id, {
                ...postClaims,
                server: sessionServer,
                sessionId: sid,
                status: 'online',
              });
              logLine('session', `registered member member_id=${postClaims.member_id} via JWT sid=${sid}`);
            } else if (memberParam) {
              sessionRegistry.register(memberParam, {
                member_id: memberParam,
                project_id: 'default',
                role: 'doer',
                work_folder: '',
                server: sessionServer,
                sessionId: sid,
                status: 'online',
              });
              logLine('session', `registered member member_id=${memberParam} via URL param sid=${sid}`);
            }
          },
          onsessionclosed: (sid) => {
            logLine('session', `closed sid=${sid}`);
            // LOW-2: Close the McpServer when its session closes
            const s = sessions.get(sid);
            if (s) {
              (s.server as any).server?.close().catch(() => {});
            }
            sessions.delete(sid);
            // Unregister interactive member session
            if (postClaims) {
              sessionRegistry.unregister(postClaims.member_id);
              logLine('session', `unregistered member member_id=${postClaims.member_id} sid=${sid}`);
            } else if (memberParam) {
              sessionRegistry.unregister(memberParam);
              logLine('session', `unregistered member member_id=${memberParam} sid=${sid}`);
            }
          },
        });
        await registerTools(sessionServer);
        await sessionServer.connect(sessionTransport);
        await sessionTransport.handleRequest(req, res, parsedBody);
        return;
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId) {
        res.writeHead(400);
        res.end('Missing mcp-session-id header');
        return;
      }
      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404);
        res.end('Session not found');
        return;
      }
      await session.transport.handleRequest(req, res, parsedBody);
      return;
    }

    // GET and DELETE: look up session and delegate
    if (req.method === 'GET' || req.method === 'DELETE') {
      await handleSessionRequest(req, res);
      return;
    }

    res.writeHead(405);
    res.end('Method not allowed');
  });

  // Subscribe to fleet events and broadcast to all connected sessions
  const fleetEventTypes: (keyof FleetEventMap)[] = [
    'credential:stored',
    'task:completed',
    'member:status-changed',
    'stall:detected',
  ];

  for (const eventType of fleetEventTypes) {
    const handler = (payload: FleetEventMap[typeof eventType]) => {
      const data = { event: eventType, ...(payload as object) };
      for (const [, session] of sessions) {
        session.server.sendLoggingMessage({
          level: 'info',
          logger: 'apra-fleet-events',
          data,
        }).catch(() => {});
      }
    };
    fleetEvents.on(eventType, handler);
    // LOW-1: Store cleanup so close() can unsubscribe
    eventCleanups.push(() => fleetEvents.off(eventType, handler));
  }

  // Start listening: try preferred port, fall back to OS-assigned port
  const targetPort = preferredPort ?? DEFAULT_PORT;
  let port: number;
  try {
    port = await listenOnPort(httpServer, targetPort, '127.0.0.1');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      port = await listenOnPort(httpServer, 0, '127.0.0.1');
    } else {
      throw err;
    }
  }

  const url = `http://127.0.0.1:${port}/mcp`;

  return {
    httpServer,
    port,
    url,
    sessions,
    close(): Promise<void> {
      // LOW-1: Unsubscribe all fleet event listeners
      for (const cleanup of eventCleanups) cleanup();
      // LOW-2: Close all active session McpServers before shutting down
      for (const [, session] of sessions) {
        (session.server as any).server?.close().catch(() => {});
      }
      sessions.clear();
      return new Promise((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
