import { z } from 'zod';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { assertGbrainEnabled, callGbrainTool } from '../utils/gbrain-helpers.js';

export const jobsListSchema = z.object({
  ...memberIdentifier,
  status: z.string().optional().describe('Filter jobs by status (queued, running, completed, failed, cancelled)'),
});

export type JobsListInput = z.infer<typeof jobsListSchema>;

export async function jobsList(input: JobsListInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;

  const gbrainError = assertGbrainEnabled(agentOrError);
  if (gbrainError) return gbrainError;

  // gbrain's internal job queue is exposed via "list_jobs".
  return callGbrainTool('list_jobs', {
    ...(input.status ? { status: input.status } : {}),
  });
}
