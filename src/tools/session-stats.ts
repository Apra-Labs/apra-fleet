import { z } from 'zod';
import { getMemberCallStats } from '../services/member-call-counts.js';
import { getSessionMemberId } from '../services/tool-scope.js';

export const sessionStatsSchema = z.object({
  member_id: z.string().optional().describe(
    'Member uuid to read. Omit on a member session (the calling member is used). Required on a non-member session.',
  ),
});

export type SessionStatsInput = z.infer<typeof sessionStatsSchema>;

/**
 * session_stats -- the calling member's aggregated kb_* / code_* call counts on
 * this server (see src/services/member-call-counts.ts). Returns JSON:
 * { member_id, since, kb, code, total, tools }. A member session may only read
 * its own counts; a violation throws (an isError tool result).
 */
export async function sessionStats(input: SessionStatsInput): Promise<string> {
  const sessionMember = getSessionMemberId();
  const requested = input.member_id;
  if (sessionMember) {
    if (requested && requested !== sessionMember) {
      throw new Error('E-FORBIDDEN: a member session may only read its own session_stats');
    }
    return JSON.stringify(getMemberCallStats(sessionMember));
  }
  if (!requested) {
    throw new Error('E-USAGE: member_id is required on a non-member session');
  }
  return JSON.stringify(getMemberCallStats(requested));
}
