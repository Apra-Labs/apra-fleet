import { z } from 'zod';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { assertGbrainEnabled, callGbrainTool } from '../utils/gbrain-helpers.js';

export const jobsSubmitSchema = z.object({
  ...memberIdentifier,
  task: z.string().describe('The task description to submit to the job queue'),
  priority: z.number().optional().describe('Job priority (0=critical, 4=backlog, default 2)'),
});

export type JobsSubmitInput = z.infer<typeof jobsSubmitSchema>;

export async function jobsSubmit(input: JobsSubmitInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;

  const gbrainError = assertGbrainEnabled(agentOrError);
  if (gbrainError) return `${gbrainError} For immediate work, use execute_prompt instead.`;

  // gbrain's internal job queue is exposed via "submit_job".
  return callGbrainTool('submit_job', {
    name: 'autopilot-cycle',
    data: { task: input.task },
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
  });
}
