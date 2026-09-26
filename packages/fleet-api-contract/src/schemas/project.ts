import { z } from 'zod';

/**
 * Project -- deliberately has NO repository field. Real projects span many
 * repos; checkouts belong to members, each of which has a work folder.
 */
export const ProjectStatusSchema = z.enum(['active', 'paused']);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  desc: z.string(),
  status: ProjectStatusSchema,
  members: z.array(z.string()).describe('Member ids'),
  lastActivity: z.number().int().nonnegative().describe('Seconds ago'),
});
export type Project = z.infer<typeof ProjectSchema>;

export const CreateProjectRequestSchema = z.object({
  name: z.string().min(1),
  desc: z.string().default(''),
  members: z.array(z.string()).default([]),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const UpdateProjectRequestSchema = CreateProjectRequestSchema.partial();
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;

export const AddProjectMemberRequestSchema = z.object({
  memberId: z.string().min(1),
});
export type AddProjectMemberRequest = z.infer<typeof AddProjectMemberRequestSchema>;
