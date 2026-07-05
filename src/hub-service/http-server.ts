/**
 * Hub HTTP server (apra-fleet-us9.4): wires the already-tested data layer
 * (members.ts, machines.ts, workspaces.ts, projects.ts, member-view.ts,
 * project-view.ts) into the routes from packages/fleet-api-contract's
 * Endpoints map that don't require human-user OAuth (apra-fleet-us9.16,
 * not yet built) -- currently GET/POST /ws/:id/members, GET/POST
 * /ws/:id/projects, PATCH/DELETE /ws/:id/projects/:pid, POST
 * /ws/:id/projects/:pid/members, and GET /installers.
 *
 * Auth: a Bearer JWT (hub-jwt.ts -- an MVP stopgap; apra-fleet-us9.5 owns
 * the real cloud-issuance design) whose `workspace_id` claim must match the
 * `:id` path param. This is the same "iron wall" pattern used throughout
 * the local server (session-registry.ts, jwt.ts): a token for workspace A
 * can never act on workspace B's resources, and a mismatch is
 * indistinguishable from "not authorized" -- it never leaks whether the
 * target workspace exists.
 *
 * GET member/project list endpoints return the full dashboard-facing
 * view-models (member-view.ts/project-view.ts, contract-validated); POST
 * returns the raw created row (creation doesn't need the joined view --
 * there's no presence/other-relation state to join yet for a brand-new row).
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { verify as verifyHubJwt, type HubJwtClaims } from './hub-jwt.js';
import { createMember, type MemberRow } from './members.js';
import { listMemberViews } from './member-view.js';
import { createProject, updateProject, deleteProject, addProjectMember, type ProjectRow } from './projects.js';
import { listProjectViews } from './project-view.js';
import { getInstallersHandler } from './handlers/installers.js';

function authorize(req: http.IncomingMessage, workspaceId: string): HubJwtClaims | null {
  const token = extractBearer(req);
  const claims = token ? verifyHubJwt(token) : null;
  if (!claims || claims.workspace_id !== workspaceId) return null;
  return claims;
}

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
      if (!authorize(req, workspaceId)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      if (req.method === 'GET') {
        const members = await listMemberViews(workspaceId);
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

    // /ws/:id/projects
    if (segments[0] === 'ws' && segments[2] === 'projects' && segments.length === 3) {
      const workspaceId = segments[1];
      if (!authorize(req, workspaceId)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      if (req.method === 'GET') {
        sendJson(res, 200, await listProjectViews(workspaceId));
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
        const input = body as { name?: unknown; desc?: unknown; members?: unknown };
        if (typeof input?.name !== 'string') {
          sendJson(res, 400, { error: 'name is required' });
          return;
        }
        const created: ProjectRow = await createProject(crypto.randomUUID(), workspaceId, {
          name: input.name,
          description: typeof input.desc === 'string' ? input.desc : undefined,
          memberIds: Array.isArray(input.members) ? input.members.filter((m): m is string => typeof m === 'string') : undefined,
        });
        sendJson(res, 201, created);
        return;
      }
    }

    // /ws/:id/projects/:pid
    if (segments[0] === 'ws' && segments[2] === 'projects' && segments.length === 4) {
      const workspaceId = segments[1];
      const projectId = segments[3];
      if (!authorize(req, workspaceId)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      if (req.method === 'PATCH') {
        let body: unknown;
        try {
          body = await parseBody(req);
        } catch {
          sendJson(res, 400, { error: 'invalid JSON body' });
          return;
        }
        const input = body as { name?: unknown; desc?: unknown; status?: unknown };
        const updated = await updateProject(workspaceId, projectId, {
          name: typeof input?.name === 'string' ? input.name : undefined,
          description: typeof input?.desc === 'string' ? input.desc : undefined,
          status: input?.status === 'active' || input?.status === 'paused' ? input.status : undefined,
        });
        if (!updated) {
          sendJson(res, 404, { error: 'project not found' });
          return;
        }
        sendJson(res, 200, updated);
        return;
      }

      if (req.method === 'DELETE') {
        const deleted = await deleteProject(workspaceId, projectId);
        if (!deleted) {
          sendJson(res, 404, { error: 'project not found' });
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    // /ws/:id/projects/:pid/members
    if (segments[0] === 'ws' && segments[2] === 'projects' && segments[4] === 'members' && segments.length === 5 && req.method === 'POST') {
      const workspaceId = segments[1];
      const projectId = segments[3];
      if (!authorize(req, workspaceId)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      let body: unknown;
      try {
        body = await parseBody(req);
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const input = body as { memberId?: unknown };
      if (typeof input?.memberId !== 'string') {
        sendJson(res, 400, { error: 'memberId is required' });
        return;
      }
      const added = await addProjectMember(workspaceId, projectId, input.memberId);
      if (!added) {
        sendJson(res, 404, { error: 'project not found' });
        return;
      }
      const view = await listProjectViews(workspaceId);
      sendJson(res, 200, view.find(p => p.id === projectId));
      return;
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
