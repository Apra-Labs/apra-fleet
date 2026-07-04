import { z } from 'zod';

/**
 * UsageRecord -- cost attributed per (project, member), cumulative for the
 * current session until a persisted usage ledger exists (see us9.15 /
 * fleet-dashboard README "Honesty contract"). No-LLM executors report
 * tokens: 0, cost: 0 ("compute only").
 */
export const UsageRecordSchema = z.object({
  project: z.string().min(1).describe('Project id'),
  member: z.string().min(1).describe('Member id'),
  tokens: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;

export const CostResponseSchema = z.object({
  window: z.literal('session').describe('7d/30d are disabled until a persisted ledger exists'),
  workspaceTotal: z.number().nonnegative(),
  usage: z.array(UsageRecordSchema),
});
export type CostResponse = z.infer<typeof CostResponseSchema>;
