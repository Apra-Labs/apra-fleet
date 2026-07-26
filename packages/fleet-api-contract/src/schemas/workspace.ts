import { z } from 'zod';
import { RoleSchema } from './jwt.js';

/** Workspace -- the tenant/security boundary (`ws` claim in JWTClaims). */
export const WorkspaceSchema = z.object({
  id: z.string().min(1).describe('workspace_id -- matches the JWT `ws` claim'),
  name: z.string().min(1),
  role: RoleSchema.describe("Requesting user's role within this workspace"),
  members: z.number().int().nonnegative(),
  projects: z.number().int().nonnegative(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const CreateWorkspaceRequestSchema = z.object({
  name: z.string().min(1),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;
