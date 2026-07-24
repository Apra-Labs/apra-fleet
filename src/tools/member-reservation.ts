import { z } from 'zod';
import { updateAgent } from '../services/registry.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { logLine } from '../utils/log-helpers.js';
import { writeStatusline } from '../services/statusline.js';
import type { Agent } from '../types.js';

/**
 * Server-side member reservation (apra-fleet-eft.10, step 2).
 *
 * Provides the reserve/release/force-release operations that mutate a
 * member's reservedBy field (introduced in eft.10.1). This step only
 * carries the ownership record -- it does NOT yet enforce the reservation
 * at dispatch time (that is eft.10.3, which wires execute_prompt and the
 * supervisor ledger to check/require it).
 */
export const memberReservationSchema = z.object({
  ...memberIdentifier,
  action: z.enum(['reserve', 'release', 'force_release']).describe(
    '"reserve" claims the member for sprint_id (fails if already reserved by someone else). '
    + '"release" clears the reservation, but only if sprint_id matches the current holder. '
    + '"force_release" clears the reservation unconditionally, regardless of current owner -- use to recover a wedged reservation.'
  ),
  sprint_id: z.string().min(1).optional().describe(
    'Sprint/session id claiming or releasing the reservation. Required for "reserve" and "release". Ignored for "force_release".'
  ),
});

export type MemberReservationInput = z.infer<typeof memberReservationSchema>;

export async function memberReservation(input: MemberReservationInput): Promise<string> {
  const existingOrError = resolveMember(input.member_id, input.member_name);
  if (typeof existingOrError === 'string') return existingOrError;
  const existing = existingOrError as Agent;

  const currentOwner = existing.reservedBy ?? null;

  if (input.action === 'reserve') {
    if (!input.sprint_id) {
      return '[-] sprint_id is required for action "reserve".';
    }
    if (currentOwner && currentOwner !== input.sprint_id) {
      return `[-] Member "${existing.friendlyName}" is already reserved by "${currentOwner}". Use force_release to clear a wedged reservation, or release it as that sprint first.`;
    }
    const updated = updateAgent(existing.id, { reservedBy: input.sprint_id });
    if (!updated) return `Failed to reserve member "${existing.id}".`;
    logLine('member_reservation', `action=reserve id=${updated.id} name=${updated.friendlyName} reservedBy=${input.sprint_id}`, updated);
    writeStatusline();
    return currentOwner === input.sprint_id
      ? `[OK] Member "${existing.friendlyName}" reservation refreshed for "${input.sprint_id}" (was already held by this sprint).`
      : `[OK] Member "${existing.friendlyName}" reserved for "${input.sprint_id}".`;
  }

  if (input.action === 'release') {
    if (!input.sprint_id) {
      return '[-] sprint_id is required for action "release".';
    }
    if (!currentOwner) {
      return `[OK] Member "${existing.friendlyName}" was not reserved. Nothing to release.`;
    }
    if (currentOwner !== input.sprint_id) {
      return `[-] Member "${existing.friendlyName}" is reserved by "${currentOwner}", not "${input.sprint_id}". Refusing to release someone else's reservation -- use force_release to override.`;
    }
    const updated = updateAgent(existing.id, { reservedBy: null });
    if (!updated) return `Failed to release member "${existing.id}".`;
    logLine('member_reservation', `action=release id=${updated.id} name=${updated.friendlyName}`, updated);
    writeStatusline();
    return `[OK] Member "${existing.friendlyName}" reservation released.`;
  }

  // force_release: clears regardless of current owner, idempotent when already unreserved.
  const updated = updateAgent(existing.id, { reservedBy: null });
  if (!updated) return `Failed to force-release member "${existing.id}".`;
  logLine('member_reservation', `action=force_release id=${updated.id} name=${updated.friendlyName} previousOwner=${currentOwner ?? 'none'}`, updated);
  writeStatusline();
  return currentOwner
    ? `[OK] Member "${existing.friendlyName}" reservation forcibly cleared (was held by "${currentOwner}").`
    : `[OK] Member "${existing.friendlyName}" was not reserved. Nothing to force-release.`;
}
