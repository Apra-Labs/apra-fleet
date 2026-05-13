import { getGbrainClient } from './gbrain-client.js';

export interface CourseCorrectionContext {
  repo?: string;
  member?: string;
  attempted: string;
  correction: string;
  reason?: string;
}

/**
 * Persist a course correction to the gbrain brain.
 * Silent no-op if gbrain is not available.
 */
export async function captureCorrection(context: CourseCorrectionContext): Promise<void> {
  const parts: string[] = [];
  if (context.repo) parts.push(`On repo ${context.repo},`);
  parts.push(`approach "${context.attempted}" was attempted.`);
  parts.push(`User corrected to "${context.correction}".`);
  if (context.reason) parts.push(`Because: ${context.reason}`);
  const content = parts.join(' ');

  const writeArgs: Record<string, unknown> = { content, collection: 'course-corrections' };
  if (context.member) writeArgs['member'] = context.member;

  try {
    await getGbrainClient().callTool('brain_write', writeArgs);
  } catch {
    // Silent no-op — gbrain may not be running
  }
}

/**
 * Recall past course corrections from the gbrain brain.
 * Returns empty string if gbrain is not available.
 */
export async function recallCorrections(context: { repo?: string; query: string }): Promise<string> {
  const queryParts: string[] = [];
  if (context.repo) queryParts.push(`repo:${context.repo}`);
  queryParts.push(context.query);
  const query = queryParts.join(' ');

  try {
    return await getGbrainClient().callTool('brain_query', { query, collection: 'course-corrections' });
  } catch {
    return '';
  }
}
