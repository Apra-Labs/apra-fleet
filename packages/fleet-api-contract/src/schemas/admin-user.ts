import { z } from 'zod';
import { RoleSchema } from './jwt.js';
import { ProviderSchema } from './member.js';

/** AdminUser -- super-admin user-provisioning row (GET /admin/users). */
export const UserStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type UserStatus = z.infer<typeof UserStatusSchema>;

export const AdminUserSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  provider: ProviderSchema.optional().describe('OAuth provider (google/microsoft), not the LLM provider'),
  status: UserStatusSchema,
  role: RoleSchema.optional().describe('Set once approved'),
  workspaces: z.array(z.string()).describe('workspace_ids this user is assigned to'),
  signedUpAt: z.number().int().nonnegative().describe('Seconds ago'),
  lastLoginAt: z.number().int().nonnegative().nullable(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const ApproveUserRequestSchema = z.object({
  role: RoleSchema,
  workspaces: z.array(z.string()).default([]),
});
export type ApproveUserRequest = z.infer<typeof ApproveUserRequestSchema>;

export const UpdateUserRoleRequestSchema = z.object({
  role: RoleSchema,
});
export type UpdateUserRoleRequest = z.infer<typeof UpdateUserRoleRequestSchema>;
