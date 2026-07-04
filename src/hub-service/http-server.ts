/**
 * Hub HTTP server (apra-fleet-us9.4): wires the already-tested data layer
 * (members.ts, machines.ts, workspaces.ts) into the routes from
 * packages/fleet-api-contract's Endpoints map that don't require human-user
 * OAuth (apra-fleet-us9.16, not yet built) -- currently GET/POST
 * /ws/:id/members and GET /installers.
 *
 * Auth: a Bearer JWT (hub-jwt.ts -- an MVP stopgap; apra-fleet-us9.5 owns
 * the real cloud-issuance design) whose `workspace_id` claim must match the
 * `:id` path param. This is the same "iron wall" pattern used throughout
 * the local server (session-registry.ts, jwt.ts): a token for workspace A
 * can never act on workspace B's resources, and a mismatch is
 * indistinguishable from "not authorized" -- it never leaks whether the
 * target workspace exists.
 *
 * Deliberately NOT the full dashboard-facing Member view-model (computed
 * status/lastSeen/jwtExp fields) -- these routes return the raw CRUD row
 * shape from members.ts. Assembling the full view-model (joining
 * presence.ts/relay_queue.ts) is separate follow-on work.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { verify as verifyHubJwt } from './hub-jwt.js';
import { createMember, listMembers, type MemberRow } from './members.js';
import { getInstallersHandler } from './handlers/installers.js';

export interface HttpServerHandle {
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(text);
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

function extractBearer(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

export function createHttpServer(): HttpServerHandle {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const segments = url.pathname.split('/').filter(Boolean);

    if (url.pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (url.pathname === '/installers' && req.method === 'GET') {
      sendJson(res, 200, getInstallersHandler());
      return;
    }

    // /ws/:id/members
    if (segments[0] === 'ws' && segments[2] === 'members' && segments.length === 3) {
      const workspaceId = segments[1];
      const token = extractBearer(req);
      const claims = token ? verifyHubJwt(token) : null;
      if (!claims || claims.workspace_id !== workspaceId) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      if (req.method === 'GET') {
        const members = await listMembers(workspaceId);
        sendJson(res, 200, members);
        return;
      }

      if (req.method === 'POST') {
        let body: unknown;
        try {
          body = await parseBody(req);
        } catch {
          sendJson(res, 400, { error: 'invalid JSON body' });
          return;
        }
        const input = body as { name?: unknown; provider?: unknown; machine?: unknown; folder?: unknown };
        if (typeof input?.name !== 'string' || typeof input?.provider !== 'string') {
          sendJson(res, 400, { error: 'name and provider are required' });
          return;
        }
        const created: MemberRow = await createMember(crypto.randomUUID(), workspaceId, {
          name: input.name,
          provider: input.provider,
          workFolder: typeof input.folder === 'string' ? input.folder : null,
        });
        sendJson(res, 201, created);
        return;
      }
    }

    sendJson(res, 404, { error: 'not found' });
  });

  return {
    server,
    get port(): number {
      const addr = server.address();
      return typeof addr === 'object' && addr ? addr.port : 0;
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

export function listen(handle: HttpServerHandle, port: number, host = '0.0.0.0'): Promise<number> {
  return new Promise((resolve, reject) => {
    handle.server.listen(port, host, () => resolve(handle.port));
    handle.server.once('error', reject);
  });
}
