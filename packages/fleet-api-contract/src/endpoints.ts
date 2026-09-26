import { z } from 'zod';
import { JWTClaimsSchema } from './schemas/jwt.js';
import { WorkspaceSchema, CreateWorkspaceRequestSchema } from './schemas/workspace.js';
import {
  ProjectSchema,
  CreateProjectRequestSchema,
  UpdateProjectRequestSchema,
  AddProjectMemberRequestSchema,
} from './schemas/project.js';
import {
  MemberSchema,
  CreateMemberRequestSchema,
  MemberTokenResponseSchema,
} from './schemas/member.js';
import { ActivityEventSchema } from './schemas/activity.js';
import { CostResponseSchema } from './schemas/usage.js';
import { InstallerSchema } from './schemas/installer.js';
import {
  AdminUserSchema,
  ApproveUserRequestSchema,
  UpdateUserRoleRequestSchema,
} from './schemas/admin-user.js';

/**
 * One entry per route in fleet-dashboard/README.md "State & API sketch".
 * Every entry that is workspace/auth-gated carries an `auth: JWTClaimsSchema`
 * field on its request shape -- JWTClaims is referenced, never redefined.
 *
 * This map is also the single source of truth the OpenAPI generator
 * (scripts/gen-openapi.ts) walks to build the 3.1 document, so response/
 * request shapes here and in the generated spec can never drift apart.
 */
export const Endpoints = {
  'POST /auth/oauth/:provider': {
    summary: 'OAuth sign-in (google|microsoft) -> session (JWT cookie)',
    auth: false,
    params: z.object({ provider: z.enum(['google', 'microsoft']) }),
    response: z.object({ jwt: z.string().min(1) }),
  },

  'GET /workspaces': {
    summary: "User's workspaces + role",
    auth: true,
    request: z.object({ auth: JWTClaimsSchema }),
    response: z.array(WorkspaceSchema),
  },
  'POST /workspaces': {
    summary: 'Create workspace (admin+)',
    auth: true,
    request: z.object({ auth: JWTClaimsSchema, body: CreateWorkspaceRequestSchema }),
    response: WorkspaceSchema,
  },

  'GET /ws/:id/projects': {
    summary: 'List projects',
    auth: true,
    params: z.object({ id: z.string().min(1) }),
    request: z.object({ auth: JWTClaimsSchema }),
    response: z.array(ProjectSchema),
  },
  'POST /ws/:id/projects': {
    summary: 'Create project',
    auth: true,
    params: z.object({ id: z.string().min(1) }),
    request: z.object({ auth: JWTClaimsSchema, body: CreateProjectRequestSchema }),
    response: ProjectSchema,
  },
  'PATCH /ws/:id/projects/:pid': {
    summary: 'Update project',
    auth: true,
    params: z.object({ id: z.string().min(1), pid: z.string().min(1) }),
    request: z.object({ auth: JWTClaimsSchema, body: UpdateProjectRequestSchema }),
    response: ProjectSchema,
  },
  'DELETE /ws/:id/projects/:pid': {
    summary: 'Delete project',
    auth: true,
    params: z.object({ id: z.string().min(1), pid: z.string().min(1) }),
    request: z.object({ auth: JWTClaimsSchema }),
    response: z.object({ ok: z.literal(true) }),
  },
  'POST /ws/:id/projects/:pid/members': {
    summary: 'Add/remove member on project',
    auth: true,
    params: z.object({ id: z.string().min(1), pid: z.string().min(1) }),
    request: z.object({ auth: JWTClaimsSchema, body: AddProjectMemberRequestSchema }),
    response: ProjectSchema,
  },

  'GET /ws/:id/members': {
    summary: 'List members',
    auth: true,
    params: z.object({ id: z.string().min(1) }),
    request: z.object({ auth: JWTClaimsSchema }),
    response: z.array(MemberSchema),
  },
  'POST /ws/:id/members': {
    summary: 'Add member; issues JWT (returned ONCE)',
    auth: true,
    params: z.object({ id: z.string().min(1) }),
    request: z.object({ auth: JWTClaimsSchema, body: CreateMemberRequestSchema }),
    response: MemberTokenResponseSchema,
  },
  'POST /ws/:id/members/:mid/rotate': {
    summary: 'Rotate member JWT (returned once), old revoked',
    auth: true,
    params: z.object({ id: z.string().min(1), mid: z.string().min(1) }),
    request: z.object({ auth: JWTClaimsSchema }),
    response: MemberTokenResponseSchema,
  },

  'GET /ws/:id/activity': {
    summary: 'Workspace-scoped activity feed (SSE)',
    auth: true,
    params: z.object({ id: z.string().min(1) }),
    request: z.object({ auth: JWTClaimsSchema }),
    response: z.array(ActivityEventSchema),
  },

  'GET /ws/:id/cost': {
    summary: 'Per-(project,member) usage, session-cumulative',
    auth: true,
    params: z.object({ id: z.string().min(1) }),
    request: z.object({ auth: JWTClaimsSchema }),
    response: CostResponseSchema,
  },

  'GET /admin/users': {
    summary: 'List users for provisioning (superadmin)',
    auth: true,
    request: z.object({ auth: JWTClaimsSchema }),
    response: z.array(AdminUserSchema),
  },
  'PUT /admin/users/:id/approve': {
    summary: 'Approve a pending user (superadmin)',
    auth: true,
    params: z.object({ id: z.string().min(1) }),
    request: z.object({ auth: JWTClaimsSchema, body: ApproveUserRequestSchema }),
    response: AdminUserSchema,
  },
  'PUT /admin/users/:id/role': {
    summary: "Change a user's role (superadmin)",
    auth: true,
    params: z.object({ id: z.string().min(1) }),
    request: z.object({ auth: JWTClaimsSchema, body: UpdateUserRoleRequestSchema }),
    response: AdminUserSchema,
  },
  'DELETE /admin/users/:id': {
    summary: 'Delete a user (superadmin)',
    auth: true,
    params: z.object({ id: z.string().min(1) }),
    request: z.object({ auth: JWTClaimsSchema }),
    response: z.object({ ok: z.literal(true) }),
  },

  'GET /installers': {
    summary: 'Latest agent builds per OS',
    auth: false,
    response: z.array(InstallerSchema),
  },
} as const;

export type EndpointName = keyof typeof Endpoints;
