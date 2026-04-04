import { getAgentOrFail } from './agent-helpers.js';
import { z } from 'zod';
import type { Agent } from '../types.js';

/**
 * Resolve a member from either member_id (UUID or name) or member_name.
 * member_id takes precedence if both are provided.
 * Returns the Agent or an error string.
 */
export function resolveMember(member_id?: string, member_name?: string): Agent | string {
  if (!member_id && !member_name) {
    return 'Error: provide either member_id (UUID) or member_name (friendly name).';
  }
  return getAgentOrFail(member_id ?? member_name!);
}

/**
 * Shared zod fragment for member identification.
 * Spread into tool schemas: z.object({ ...memberIdentifier, ...otherFields })
 * Add .refine(d => d.member_id || d.member_name, { message: 'Provide either member_id or member_name' })
 */
export const memberIdentifier = {
  member_id: z.string().optional().describe(
    'UUID of the member. Takes precedence over member_name if both are provided.'
  ),
  member_name: z.string().optional().describe(
    'Friendly name of the member. Use when UUID is not known. Ignored if member_id is also provided.'
  ),
};
