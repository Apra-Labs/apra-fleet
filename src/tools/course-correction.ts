import { z } from 'zod';
import { captureCorrection, recallCorrections } from '../services/course-correction.js';

export const courseCorrectionCaptureSchema = z.object({
  attempted: z.string().describe('The approach that was attempted'),
  correction: z.string().describe('The corrected approach the user specified'),
  reason: z.string().optional().describe('Why the original approach was wrong'),
  repo: z.string().optional().describe('Repository context (e.g. owner/repo)'),
  member_name: z.string().optional().describe('Name of the member that made the attempt'),
});

export type CourseCorrectionCaptureInput = z.infer<typeof courseCorrectionCaptureSchema>;

export async function courseCorrectionCapture(input: CourseCorrectionCaptureInput): Promise<string> {
  await captureCorrection({
    attempted: input.attempted,
    correction: input.correction,
    reason: input.reason,
    repo: input.repo,
    member: input.member_name,
  });
  return 'Course correction captured.';
}

export const courseCorrectionRecallSchema = z.object({
  query: z.string().describe('Search query to look up past corrections'),
  repo: z.string().optional().describe('Narrow results to a specific repository'),
});

export type CourseCorrectionRecallInput = z.infer<typeof courseCorrectionRecallSchema>;

export async function courseCorrectionRecall(input: CourseCorrectionRecallInput): Promise<string> {
  return recallCorrections({ query: input.query, repo: input.repo });
}
