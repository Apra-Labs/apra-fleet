import { z } from 'zod';

export const ActivityKindSchema = z.enum(['cmd', 'prompt', 'file', 'commit']);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

/** ActivityEvent -- workspace-scoped feed item, pushed over SSE. */
export const ActivityEventSchema = z.object({
  t: z.number().int().nonnegative().describe('Seconds ago'),
  member: z.string().min(1).describe('Member id'),
  project: z.string().min(1).describe('Project id'),
  kind: ActivityKindSchema,
  text: z.string(),
  exit: z.number().int().nullable().optional().describe('Exit code for kind === "cmd"'),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;
