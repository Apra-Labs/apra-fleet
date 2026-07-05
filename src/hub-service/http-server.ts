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
import { verify as verifyHubJwt, sign as signHubJwt, type HubJwtClaims } from './hub-jwt.js';
import { createMember, listMembers, type MemberRow } from './members.js';
import { listMemberViews, getMemberView } from './member-view.js';
import { createProject, updateProject, deleteProject, addProjectMember, listProjects, type ProjectRow } from './projects.js';
import { listProjectViews } from './project-view.js';
import { getCostResponse } from './usage.js';
import { getActivityFeed } from './activity.js';
import { issueMemberToken, rotateMemberToken } from './member-tokens.js';
import { isRevoked } from './jwt-revocation.js';
import { getInstallersHandler } from './handlers/installers.js';
import { signSession, verifySession } from './session-jwt.js';
import {
  findOrCreateUser, getUser, listUsers, approveUser,
  updateUserRole, deleteUser, listUserWorkspaceIds, hasWorkspaceAccess,
  type UserRow,
} from './users.js';
import { getWorkspace } from './workspaces.js';
import { generateEnrollmentToken, exchangeEnrollmentToken } from './enrollment.js';
import { submitEnvelope, type InboundEnvelope } from './envelope-routes.js';
import { ack as ackRelay, fetchDeliverable } from './relay-queue.js';
import { listForMachine } from './presence.js';
import { getPool } from './db/pool.js';

/** apra-fleet-b55: how often the SSE stream route polls relay_queue for
 *  anything newly deliverable to a member on this machine. */
const STREAM_POLL_INTERVAL_MS = 1000;

/** Verifies the bearer token, its workspace match, AND that its jti hasn't
 *  been revoked (apra-fleet-us9.5: rotation revokes the prior token's jti,
 *  so a caller still holding it must be rejected immediately, not just
 *  once it naturally expires). */
async function authorize(req: http.IncomingMessage, workspaceId: string): Promise<HubJwtClaims | null> {
  const token = extractBearer(req);
  const claims = token ? verifyHubJwt(token) : null;
  if (!claims || claims.workspace_id !== workspaceId) return null;
  if (await isRevoked(claims.jti)) return null;
  return claims;
}

/** Verifies a dashboard OAuth session token (apra-fleet-us9.16) and its
 *  revocation status. Identity-only -- no workspace_id, see session-jwt.ts. */
async function authorizeSession(req: http.IncomingMessage): Promise<{ sub: string } | null> {
  const token = extractBearer(req);
  const claims = token ? verifySession(token) : null;
  if (!claims) return null;
  if (await isRevoked(claims.jti)) return null;
  return claims;
}

/**
 * A session token's user must be status='approved' AND is_platform_admin
 * to reach /admin/users/* -- both checked here, not just token validity.
 * A pending/rejected user must never reach a real route just because a
 * session token exists (docs/dashboard-oauth-rbac-design.md section 3).
 */
async function requirePlatformAdmin(req: http.IncomingMessage): Promise<UserRow | null> {
  const session = await authorizeSession(req);
  if (!session) return null;
  const user = await getUser(session.sub);
  if (!user || user.status !== 'approved' || !user.is_platform_admin) return null;
  return user;
}

function secondsSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
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
      if (!(await authorize(req, workspaceId))) {
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
        // Matches MemberTokenResponseSchema: {member, jwt} -- the jwt is
        // shown exactly once at issuance, never re-returned by any GET.
        const jwt = await issueMemberToken(workspaceId, created.id);
        const memberView = await getMemberView(workspaceId, created.id);
        sendJson(res, 201, { member: memberView, jwt });
        return;
      }
    }

    // /ws/:id/members/:mid/rotate
    if (segments[0] === 'ws' && segments[2] === 'members' && segments[4] === 'rotate' && segments.length === 5 && req.method === 'POST') {
      const workspaceId = segments[1];
      const memberId = segments[3];
      if (!(await authorize(req, workspaceId))) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }

      const jwt = await rotateMemberToken(workspaceId, memberId);
      if (!jwt) {
        sendJson(res, 404, { error: 'member not found' });
        return;
      }
      const memberView = await getMemberView(workspaceId, memberId);
      sendJson(res, 200, { member: memberView, jwt });
      return;
    }

    // /ws/:id/stream (apra-fleet-b55: hub -> spoke SSE delivery push,
    // docs/hub-spoke-wire-protocol.md section 5 step 4). One stream per
    // machine JWT; polls every POLL_INTERVAL_MS for anything deliverable to
    // any member currently announced (presence.ts) on this machine.
    if (segments[0] === 'ws' && segments[2] === 'stream' && segments.length === 3 && req.method === 'GET') {
      const workspaceId = segments[1];
      const claims = await authorize(req, workspaceId);
      if (!claims) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      const machineId = claims.member_id;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const pool = getPool();
      let closed = false;
      const poll = async () => {
        if (closed) return;
        const members = await listForMachine(machineId, pool);
        for (const m of members) {
          const deliverable = await fetchDeliverable(m.member_id, pool);
          for (const envelope of deliverable) {
            if (closed) return;
            res.write(`data: ${JSON.stringify(envelope)}\n\n`);
          }
        }
      };
      const timer = setInterval(() => { poll().catch(() => {}); }, STREAM_POLL_INTERVAL_MS);
      req.on('close', () => {
        closed = true;
        clearInterval(timer);
      });
      await poll();
      return;
    }

    // /ws/:id/envelopes (apra-fleet-us9.6 slice 1: wire-protocol envelope
    // submission -- docs/hub-spoke-wire-protocol.md section 2/5).
    if (segments[0] === 'ws' && segments[2] === 'envelopes' && segments.length === 3 && req.method === 'POST') {
      const workspaceId = segments[1];
      const claims = await authorize(req, workspaceId);
      if (!claims) {
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
      const env = body as Partial<InboundEnvelope>;
      if (typeof env?.envelope_id !== 'string' || typeof env?.workspace_id !== 'string' || typeof env?.kind !== 'string') {
        sendJson(res, 400, { error: 'envelope_id, workspace_id, and kind are required' });
        return;
      }
      const result = await submitEnvelope(claims, env as InboundEnvelope, getPool());
      sendJson(res, result.status, result.body);
      return;
    }

    // /ws/:id/ack (docs/hub-spoke-wire-protocol.md section 5 step 4 --
    // a plain ack, not itself an envelope subject to its own delivery
    // guarantees).
    if (segments[0] === 'ws' && segments[2] === 'ack' && segments.length === 3 && req.method === 'POST') {
      const workspaceId = segments[1];
      const claims = await authorize(req, workspaceId);
      if (!claims) {
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
      // member_id is required explicitly: the JWT is per-machine, not
      // per-member (wire-protocol.md section 2 -- "one long-lived channel
      // per spoke... multiplexed by member_id inside the envelope"), so the
      // machine's own claims.member_id is not necessarily the envelope's
      // target member.
      const { envelope_id: envelopeId, member_id: memberId } = (body as { envelope_id?: unknown; member_id?: unknown }) ?? {};
      if (typeof envelopeId !== 'string' || typeof memberId !== 'string') {
        sendJson(res, 400, { error: 'envelope_id and member_id are required' });
        return;
      }
      await ackRelay(workspaceId, memberId, envelopeId, getPool());
      sendJson(res, 200, { acked: true });
      return;
    }

    // /ws/:id/projects
    if (segments[0] === 'ws' && segments[2] === 'projects' && segments.length === 3) {
      const workspaceId = segments[1];
      if (!(await authorize(req, workspaceId))) {
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
      if (!(await authorize(req, workspaceId))) {
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
      if (!(await authorize(req, workspaceId))) {
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

    // /ws/:id/cost
    if (segments[0] === 'ws' && segments[2] === 'cost' && segments.length === 3 && req.method === 'GET') {
      const workspaceId = segments[1];
      if (!(await authorize(req, workspaceId))) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      sendJson(res, 200, await getCostResponse(workspaceId));
      return;
    }

    // /ws/:id/activity
    if (segments[0] === 'ws' && segments[2] === 'activity' && segments.length === 3 && req.method === 'GET') {
      const workspaceId = segments[1];
      if (!(await authorize(req, workspaceId))) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      sendJson(res, 200, await getActivityFeed(workspaceId));
      return;
    }

    // POST /auth/oauth/:provider (apra-fleet-us9.16)
    // Stub identity resolution: the actual Google/Microsoft OAuth token
    // exchange (redirect handling, CSRF/state, library choice) is
    // deliberately out of scope here -- see
    // docs/dashboard-oauth-rbac-design.md section 5 ("well-trodden ground").
    // The body is treated as an ALREADY-VERIFIED identity from that
    // exchange ({oauthSubject, email, name}); wiring in a real OAuth
    // library replaces only this body-parsing step, not the RBAC state
    // machine below it.
    if (segments[0] === 'auth' && segments[1] === 'oauth' && segments.length === 3 && req.method === 'POST') {
      const provider = segments[2];
      if (provider !== 'google' && provider !== 'microsoft') {
        sendJson(res, 400, { error: 'unsupported provider' });
        return;
      }
      let body: unknown;
      try {
        body = await parseBody(req);
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const input = body as { oauthSubject?: unknown; email?: unknown; name?: unknown };
      if (typeof input?.oauthSubject !== 'string' || typeof input?.email !== 'string' || typeof input?.name !== 'string') {
        sendJson(res, 400, { error: 'oauthSubject, email, and name are required' });
        return;
      }
      const user = await findOrCreateUser(crypto.randomUUID(), provider, input.oauthSubject, input.email, input.name);
      const { token } = signSession(user.id);
      sendJson(res, 200, { jwt: token });
      return;
    }

    // GET /workspaces (apra-fleet-us9.16): session token only, no :id --
    // lists every workspace this user has access to. A pending/unassigned
    // user gets an empty array, not an error (a legitimate, non-error
    // state per the design doc).
    if (segments[0] === 'workspaces' && segments.length === 1 && req.method === 'GET') {
      const session = await authorizeSession(req);
      if (!session) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      const user = await getUser(session.sub);
      if (!user || user.status !== 'approved') {
        sendJson(res, 200, []);
        return;
      }
      const workspaceIds = await listUserWorkspaceIds(user.id);
      const result = [];
      for (const id of workspaceIds) {
        const ws = await getWorkspace(id);
        if (!ws) continue;
        const [members, projects] = await Promise.all([listMembers(id), listProjects(id)]);
        result.push({ id: ws.id, name: ws.name, role: user.role, members: members.length, projects: projects.length });
      }
      sendJson(res, 200, result);
      return;
    }

    // POST /workspaces/:id/select (apra-fleet-us9.16 addition, not in the
    // strict Endpoints contract map -- a pragmatic bridge the design doc's
    // flow needed but the contract didn't name): exchanges a session token
    // + workspace access for a workspace-scoped token that authenticates
    // every /ws/:id/... route already built. Reuses hub-jwt.ts's existing
    // shape (member_id/workspace_id/role) rather than inventing a third
    // claim shape -- see session-jwt.ts's header comment on the
    // not-yet-reconciled claim-shape family.
    if (segments[0] === 'workspaces' && segments.length === 3 && segments[2] === 'select' && req.method === 'POST') {
      const workspaceId = segments[1];
      const session = await authorizeSession(req);
      if (!session) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      const user = await getUser(session.sub);
      if (!user || user.status !== 'approved' || !user.role) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      if (!(await hasWorkspaceAccess(user.id, workspaceId))) {
        // Same non-leaking shape as every other auth mismatch in this file:
        // "not assigned to this workspace" is indistinguishable from
        // "workspace doesn't exist" or "wrong token".
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      const { token } = signHubJwt({ member_id: user.id, workspace_id: workspaceId, role: user.role });
      sendJson(res, 200, { jwt: token });
      return;
    }

    // /admin/users (apra-fleet-us9.16): platform-admin only. A non-
    // platform-admin (including a superadmin of just one workspace) gets
    // the exact same 401 as an invalid token -- never leaks that the
    // route exists or that other users do.
    if (segments[0] === 'admin' && segments[1] === 'users' && segments.length === 2 && req.method === 'GET') {
      if (!(await requirePlatformAdmin(req))) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      const users = await listUsers();
      const result = await Promise.all(users.map(async (u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        provider: u.oauth_provider,
        status: u.status,
        role: u.role ?? undefined,
        workspaces: await listUserWorkspaceIds(u.id),
        signedUpAt: secondsSince(u.created_at),
        lastLoginAt: u.last_login_at ? secondsSince(u.last_login_at) : null,
      })));
      sendJson(res, 200, result);
      return;
    }

    // PUT /admin/users/:id/approve
    if (segments[0] === 'admin' && segments[1] === 'users' && segments[3] === 'approve' && segments.length === 4 && req.method === 'PUT') {
      if (!(await requirePlatformAdmin(req))) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      const targetUserId = segments[2];
      let body: unknown;
      try {
        body = await parseBody(req);
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const input = body as { role?: unknown; workspaces?: unknown };
      if (input?.role !== 'member' && input?.role !== 'admin' && input?.role !== 'superadmin') {
        sendJson(res, 400, { error: 'role must be one of member, admin, superadmin' });
        return;
      }
      const workspaceIds = Array.isArray(input.workspaces) ? input.workspaces.filter((w): w is string => typeof w === 'string') : [];
      const updated = await approveUser(targetUserId, input.role, workspaceIds);
      if (!updated) {
        sendJson(res, 404, { error: 'user not found' });
        return;
      }
      sendJson(res, 200, {
        id: updated.id, name: updated.name, email: updated.email, provider: updated.oauth_provider,
        status: updated.status, role: updated.role, workspaces: await listUserWorkspaceIds(updated.id),
        signedUpAt: secondsSince(updated.created_at), lastLoginAt: updated.last_login_at ? secondsSince(updated.last_login_at) : null,
      });
      return;
    }

    // PUT /admin/users/:id/role -- a platform-admin gate independent of any
    // per-workspace role (a member-role user cannot reach this route at
    // all, regardless of what role they hold anywhere).
    if (segments[0] === 'admin' && segments[1] === 'users' && segments[3] === 'role' && segments.length === 4 && req.method === 'PUT') {
      if (!(await requirePlatformAdmin(req))) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      const targetUserId = segments[2];
      let body: unknown;
      try {
        body = await parseBody(req);
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const input = body as { role?: unknown };
      if (input?.role !== 'member' && input?.role !== 'admin' && input?.role !== 'superadmin') {
        sendJson(res, 400, { error: 'role must be one of member, admin, superadmin' });
        return;
      }
      const updated = await updateUserRole(targetUserId, input.role);
      if (!updated) {
        sendJson(res, 404, { error: 'user not found' });
        return;
      }
      sendJson(res, 200, {
        id: updated.id, name: updated.name, email: updated.email, provider: updated.oauth_provider,
        status: updated.status, role: updated.role, workspaces: await listUserWorkspaceIds(updated.id),
        signedUpAt: secondsSince(updated.created_at), lastLoginAt: updated.last_login_at ? secondsSince(updated.last_login_at) : null,
      });
      return;
    }

    // DELETE /admin/users/:id
    if (segments[0] === 'admin' && segments[1] === 'users' && segments.length === 3 && req.method === 'DELETE') {
      if (!(await requirePlatformAdmin(req))) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      const targetUserId = segments[2];
      const deleted = await deleteUser(targetUserId);
      if (!deleted) {
        sendJson(res, 404, { error: 'user not found' });
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    // POST /ws/:id/enrollment-tokens (apra-fleet-us9.5/fnz.4, re-scoped per
    // docs/hub-spoke-master-plan.md section 4): a dashboard user assigned to
    // this workspace generates a short-lived, single-use token for a new
    // machine's `apra-fleet join <token>`. Not in the strict Endpoints
    // contract map (a pragmatic addition, same as /workspaces/:id/select).
    if (segments[0] === 'ws' && segments[2] === 'enrollment-tokens' && segments.length === 3 && req.method === 'POST') {
      const workspaceId = segments[1];
      const session = await authorizeSession(req);
      if (!session) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      const user = await getUser(session.sub);
      if (!user || user.status !== 'approved' || !(await hasWorkspaceAccess(user.id, workspaceId))) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      const { token, expiresAt } = await generateEnrollmentToken(workspaceId);
      sendJson(res, 201, { token, expiresAt });
      return;
    }

    // POST /join/exchange (apra-fleet-us9.5/fnz.4): the hub-mediated half of
    // `apra-fleet join <token>` -- called OUTBOUND by the new machine, no
    // inbound exposure required on any existing spoke. The token itself is
    // the credential (short-lived, single-use, atomically claimed) --
    // no Bearer auth on this route, by design; that's what would make
    // enrollment circular (a new machine has no token yet to present).
    if (segments[0] === 'join' && segments[1] === 'exchange' && segments.length === 2 && req.method === 'POST') {
      let body: unknown;
      try {
        body = await parseBody(req);
      } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const input = body as { token?: unknown; hostname?: unknown };
      if (typeof input?.token !== 'string' || typeof input?.hostname !== 'string') {
        sendJson(res, 400, { error: 'token and hostname are required' });
        return;
      }
      const result = await exchangeEnrollmentToken(input.token, input.hostname);
      if (!result) {
        sendJson(res, 401, { error: 'invalid, expired, or already-used token' });
        return;
      }
      sendJson(res, 200, { machineId: result.machineId, workspaceId: result.workspaceId, jwt: result.jwt });
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
