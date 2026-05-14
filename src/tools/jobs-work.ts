import { z } from 'zod';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { assertGbrainEnabled, callGbrainTool } from '../utils/gbrain-helpers.js';

export const jobsWorkSchema = z.object({
  ...memberIdentifier,
  job_id: z.string().describe('The ID of the job to mark as complete'),
  result: z.string().describe('The result or output of the completed job'),
});

export type JobsWorkInput = z.infer<typeof jobsWorkSchema>;

export async function jobsWork(input: JobsWorkInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;

  const gbrainError = assertGbrainEnabled(agentOrError);
  if (gbrainError) return gbrainError;

  // gbrain manages job lifecycle internally; there is no manual job completion
  // tool. Persist the result as a brain page under the jobs namespace instead.
  return callGbrainTool('put_page', {
    slug: `jobs/${input.job_id}`,
    content: `---\ntags: [jobs, completed]\n---\n${input.result}`,
  });
}
