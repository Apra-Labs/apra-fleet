import { z } from 'zod';
import { queryErrorEntries, MAX_ERROR_ENTRIES, DEFAULT_ERROR_QUERY_LIMIT, type ErrorEntry } from '../services/error-registry.js';
import { getSessionMemberId } from '../services/tool-scope.js';

export const queryErrorsSchema = z.object({
  member: z.string().min(1).describe('Member uuid whose tool-call errors to read. On a member session it must be the calling member.'),
  since_seconds: z.number().int().positive().describe('Window: errors recorded in the last this many seconds, by this server\'s clock.'),
  code: z.string().optional().describe('Only entries with this code, e.g. E-KB-HTTP-AUTH.'),
  tool: z.string().optional().describe('Only entries for this tool name.'),
  origin: z.enum(['engine', 'session']).optional().describe('Only entries from this origin: engine (a session the engine opened as the member, e.g. apra-fleet call) or session (any other). Default: both.'),
  limit: z.number().int().min(1).max(MAX_ERROR_ENTRIES).optional().describe(`Most recent entries to return (default ${DEFAULT_ERROR_QUERY_LIMIT}).`),
});

export type QueryErrorsInput = z.infer<typeof queryErrorsSchema>;

/** query_errors result: the window queried, the match count, and the entries (oldest first). */
export interface QueryErrorsResult {
  member: string;
  since_seconds: number;
  total: number;
  entries: ErrorEntry[];
}

/** E-FORBIDDEN: a member session asked for another member's errors. */
export class QueryErrorsForbiddenError extends Error {
  readonly code = 'E-FORBIDDEN' as const;
  constructor() {
    super('E-FORBIDDEN: a member session may only read its own errors');
    this.name = 'QueryErrorsForbiddenError';
  }
}

/**
 * query_errors -- this server's recorded tool-call errors for one member
 * (src/services/error-registry.ts). Returns JSON QueryErrorsResult. A member
 * session reads only its own member; another member throws E-FORBIDDEN.
 */
export async function queryErrors(input: QueryErrorsInput): Promise<string> {
  const sessionMember = getSessionMemberId();
  if (sessionMember && input.member !== sessionMember) throw new QueryErrorsForbiddenError();
  const { entries, total } = queryErrorEntries({
    member: input.member,
    sinceSeconds: input.since_seconds,
    code: input.code,
    tool: input.tool,
    origin: input.origin,
    limit: input.limit,
  });
  const result: QueryErrorsResult = { member: input.member, since_seconds: input.since_seconds, total, entries };
  return JSON.stringify(result);
}
