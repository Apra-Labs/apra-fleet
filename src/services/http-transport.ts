import http from 'node:http';
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { fleetEvents, FleetEventMap } from './event-bus.js';
import { getOrCreateKey, type JwtClaims } from './jwt.js';
import { getTokenIssuer, localWorkspaceId } from './token-issuer.js';
import { sessionRegistry } from './session-registry.js';
import { getAgent, findAgentByName } from './registry.js';
import { DEFAULT_PORT, DEFAULT_HOST } from '../paths.js';
import { serverVersion } from '../version.js';
import { logLine } from '../utils/log-helpers.js';

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  /** Workspace this session belongs to: from the JWT claim when authenticated,
   *  else the local workspace (127.0.0.1-only trust boundary). Event broadcast
   *  is scoped by this -- events never cross a workspace wall. */
  workspaceId: string;
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
      // Admin-only endpoint: require the local signing key (~/.apra-fleet/fleet.key,
      // mode 0o600) as a bearer token. This is not a member JWT -- it's proof the
      // caller can read a file only the same OS user can read, matching this
      // server's existing 127.0.0.1-only trust boundary. See apra-fleet-2xs.11.
      const rawToken = extractBearer(req);
      if (rawToken === null || rawToken !== getOrCreateKey()) {
        logLine('session', 'unauthorized /shutdown attempt rejected');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
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
        postClaims = getTokenIssuer().verify(rawToken);
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

        // Identity keying is unified on the member UUID. The URL ?member= param
        // (unauthenticated local fallback) historically carried the friendly
        // name; new URLs carry the UUID, and legacy friendly names are resolved
        // to the UUID via the agent registry here.
        let fallbackMemberId: string | null = null;
        let fallbackWorkFolder = '';
        if (postClaims === null && memberParam !== null) {
          const agent = getAgent(memberParam) ?? findAgentByName(memberParam);
          fallbackMemberId = agent?.id ?? memberParam;
          fallbackWorkFolder = agent?.workFolder ?? '';
          if (agent && agent.id !== memberParam) {
            logLine('session', `resolved URL member param '${memberParam}' to member_id=${agent.id}`);
          }
        }
        // Unauthenticated sessions (PM/tools, URL-param fallback) can only come
        // from this machine (server binds 127.0.0.1), so they belong to the
        // local workspace. Authenticated sessions use the JWT's workspace_id.
        const sessionWorkspaceId = postClaims?.workspace_id ?? localWorkspaceId();

        const sessionServer = new McpServer(
          { name: `apra fleet server ${serverVersion}`, version: serverVersion },
          { capabilities: { logging: {}, experimental: { 'claude/channel': {} } } }
        );
        const sessionTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { server: sessionServer, transport: sessionTransport, workspaceId: sessionWorkspaceId });
            const hasMember = !!(postClaims || fallbackMemberId);
            logLine('session', `new sid=${sid} client=${clientInfo.name ?? 'unknown'}/${clientInfo.version ?? 'unknown'} caps=${capKeys || 'none'} member=${hasMember}`);
            // Register interactive member session when JWT claims are present.
            //
            // apra-fleet-eft.28.5: carry forward the launch-time pid captured
            // by register_member (which registered `server: null, pid: <proc>`
            // before this connect-back). Without this, the connect-back
            // registration overwrote that entry with pid=undefined, so the
            // execute_prompt interactive liveness check (eft.28.1) had no PID to
            // test and a dead-but-connected session hung the dispatch for the
            // full timeout_s -- the exact real-fleet repro in eft.28. Preserving
            // the pid lets the liveness check detect the dead backing process
            // and re-dispatch fresh instead of blocking.
            if (postClaims) {
              // apra-fleet-eft.50.1: fall back to the durable launch-pid anchor
              // when the live SessionState was already unregistered before this
              // connect-back (so get()?.pid is undefined). Without this last
              // fallback a reconnect on a dispatch RETRY re-registered with
              // pid=undefined, blinding the interactive liveness check on
              // attempt 2+ and reproducing eft.28's silent hang.
              const priorPid = sessionRegistry.get(postClaims.workspace_id, postClaims.member_id)?.pid
                ?? sessionRegistry.lastKnownPid(postClaims.workspace_id, postClaims.member_id);
              sessionRegistry.register({
                ...postClaims,
                server: sessionServer,
                sessionId: sid,
                status: 'online',
                pid: (postClaims as any).pid ?? priorPid,
              });
              logLine('session', `registered member member_id=${postClaims.member_id} workspace_id=${postClaims.workspace_id} via JWT sid=${sid}`);
            } else if (fallbackMemberId) {
              // apra-fleet-eft.50.1: same durable launch-pid fallback as the
              // JWT branch above, so a URL-param reconnect on a retry keeps a
              // pid for the interactive liveness check to test.
              const priorPid = sessionRegistry.get(sessionWorkspaceId, fallbackMemberId)?.pid
                ?? sessionRegistry.lastKnownPid(sessionWorkspaceId, fallbackMemberId);
              sessionRegistry.register({
                member_id: fallbackMemberId,
                workspace_id: sessionWorkspaceId,
                role: 'doer',
                work_folder: fallbackWorkFolder,
                server: sessionServer,
                sessionId: sid,
                status: 'online',
                pid: priorPid,
              });
              logLine('session', `registered member member_id=${fallbackMemberId} workspace_id=${sessionWorkspaceId} via URL param sid=${sid}`);
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
            // Unregister interactive member session -- but only if the registry
            // entry still points at THIS session. If the member reconnected
            // (new sid) before this stale session's close event fired, the
            // registry now holds the NEW session's sessionId and must not be
            // clobbered by the old one closing late (apra-fleet-2xs.10).
            if (postClaims) {
              const current = sessionRegistry.get(postClaims.workspace_id, postClaims.member_id);
              if (current?.sessionId === sid) {
                sessionRegistry.unregister(postClaims.workspace_id, postClaims.member_id);
                logLine('session', `unregistered member member_id=${postClaims.member_id} sid=${sid}`);
              } else {
                logLine('session', `skipped stale unregister member_id=${postClaims.member_id} sid=${sid} (superseded by sid=${current?.sessionId ?? 'none'})`);
              }
            } else if (fallbackMemberId) {
              const current = sessionRegistry.get(sessionWorkspaceId, fallbackMemberId);
              if (current?.sessionId === sid) {
                sessionRegistry.unregister(sessionWorkspaceId, fallbackMemberId);
                logLine('session', `unregistered member member_id=${fallbackMemberId} sid=${sid}`);
              } else {
                logLine('session', `skipped stale unregister member_id=${fallbackMemberId} sid=${sid} (superseded by sid=${current?.sessionId ?? 'none'})`);
              }
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

  // Subscribe to fleet events and broadcast to connected sessions in the SAME
  // workspace only. All events on this bus originate from the local
  // orchestrator, i.e. from the local workspace -- a session authenticated
  // with a foreign workspace_id must never see them.
  const fleetEventTypes: (keyof FleetEventMap)[] = [
    'credential:stored',
    'task:completed',
    'member:status-changed',
    'stall:detected',
  ];

  for (const eventType of fleetEventTypes) {
    const handler = (payload: FleetEventMap[typeof eventType]) => {
      const data = { event: eventType, ...(payload as object) };
      const eventWorkspaceId = localWorkspaceId();
      for (const [, session] of sessions) {
        if (session.workspaceId !== eventWorkspaceId) continue;
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

  // Start listening: try preferred port, fall back to OS-assigned port.
  // Bind host is configurable (APRA_FLEET_HOST, default 127.0.0.1) --
  // apra-fleet-fnz.4/us9.6. Binding beyond loopback is an explicit,
  // logged opt-in: several unauthenticated code paths in this file (the
  // ?member= URL-param fallback, /shutdown's admin-key check) were
  // written assuming only same-machine callers can reach this server.
  const targetPort = preferredPort ?? DEFAULT_PORT;
  const bindHost = DEFAULT_HOST;
  if (bindHost !== '127.0.0.1') {
    logLine('session', `WARNING: binding to ${bindHost} (not loopback-only) -- unauthenticated requests (the ?member= URL-param fallback, /shutdown) are now reachable from any host that can route to this address, not just this machine. Set APRA_FLEET_HOST=127.0.0.1 (or unset it) to restore the loopback-only default.`);
  }
  let port: number;
  try {
    port = await listenOnPort(httpServer, targetPort, bindHost);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      port = await listenOnPort(httpServer, 0, bindHost);
    } else {
      throw err;
    }
  }

  // Same-machine callers (register_member's own local MCP connection) always
  // use loopback -- valid regardless of bindHost, since binding to 0.0.0.0
  // still accepts loopback connections. This is not "the LAN address";
  // fnz.4's enrollment flow is responsible for advertising a reachable
  // LAN/host address to the JOINING machine separately.
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
