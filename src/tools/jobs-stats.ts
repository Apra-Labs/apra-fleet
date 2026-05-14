import { z } from 'zod';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { assertGbrainEnabled, callGbrainTool } from '../utils/gbrain-helpers.js';

export const jobsStatsSchema = z.object({
  ...memberIdentifier,
});

export type JobsStatsInput = z.infer<typeof jobsStatsSchema>;

export async function jobsStats(input: JobsStatsInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;

  const gbrainError = assertGbrainEnabled(agentOrError);
  if (gbrainError) return gbrainError;

  // gbrain does not expose a dedicated stats endpoint; delegate to list_jobs
  // and let the caller interpret the counts from the returned job list.
  return callGbrainTool('list_jobs', { limit: 100 });
}
