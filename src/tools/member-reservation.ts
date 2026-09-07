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

/**
 * Machine-readable outcome discriminator (apra-fleet-3swo.7.1).
 *
 * Every return path of memberReservation() carries exactly one of these, so a
 * programmatic caller branches on `structuredContent.outcome` instead of
 * string-matching the human summary. The prose text is unchanged and stays the
 * human-facing summary for callers that only read text.
 */
export type MemberReservationOutcome =
  /** The member is now reserved for the requesting sprint (fresh claim). */
  | 'reserved'
  /** Already held by the requesting sprint; the claim was refreshed, not moved. */
  | 'reservation_refreshed'
  /** The reservation was cleared by its own holder. */
  | 'released'
  /** force_release cleared a reservation regardless of owner. */
  | 'force_released'
  /** Refused: a different sprint currently holds the reservation. */
  | 'already_reserved_by_other'
  /** Nothing to release/force-release -- the member held no reservation. */
  | 'not_reserved'
  /** The member is marked unreservable (shared), so reserve/release are no-ops. */
  | 'unreservable'
  /** The request itself was malformed (e.g. reserve/release without sprint_id). */
  | 'invalid_input'
  /** No member matched member_id/member_name. */
  | 'member_not_found'
  /** The reservation store write failed -- the operation did NOT take effect. */
  | 'failed';

interface MemberReservationFields {
  /** Machine-readable outcome discriminator. Branch on this, never on `text`. */
  outcome: MemberReservationOutcome;
  /** True when the requested operation took effect (or was already true). */
  ok: boolean;
  /** The action that was requested. */
  action: 'reserve' | 'release' | 'force_release';
  /** Registry id of the resolved member, or null when no member resolved. */
  memberId: string | null;
  /** Friendly name of the resolved member, or null when no member resolved. */
  memberName: string | null;
  /** The sprint id supplied by the caller, or null when none was supplied. */
  sprintId: string | null;
  /**
   * The sprint that held the reservation when the call arrived, or null when
   * the member was unreserved (or no member resolved). On
   * `already_reserved_by_other` this is the blocking owner.
   */
  ownerSprintId: string | null;
}

export interface MemberReservationStructured extends MemberReservationFields {
  [key: string]: unknown;
}

export interface MemberReservationResult {
  text: string;
  structuredContent: MemberReservationStructured;
}

function reservationResult(
  text: string,
  fields: Omit<MemberReservationFields, 'ok'> & { ok?: boolean },
): MemberReservationResult {
  const failedOutcomes: MemberReservationOutcome[] = [
    'already_reserved_by_other',
    'invalid_input',
    'member_not_found',
    'failed',
  ];
  const ok = fields.ok ?? !failedOutcomes.includes(fields.outcome);
  return { text, structuredContent: { ...fields, ok } };
}

export async function memberReservation(input: MemberReservationInput): Promise<MemberReservationResult> {
  const existingOrError = resolveMember(input.member_id, input.member_name);
  if (typeof existingOrError === 'string') {
    // resolveMember's own error prose is preserved byte-for-byte; only the
    // structured discriminator is new.
    return reservationResult(existingOrError, {
      outcome: 'member_not_found',
      action: input.action,
      memberId: input.member_id ?? null,
      memberName: input.member_name ?? null,
      sprintId: input.sprint_id ?? null,
      ownerSprintId: null,
    });
  }
  const existing = existingOrError as Agent;

  const base = {
    action: input.action,
    memberId: existing.id,
    memberName: existing.friendlyName,
    sprintId: input.sprint_id ?? null,
  };

  if (existing.unreservable) {
    return reservationResult(
      `[OK] Member "${existing.friendlyName}" is shared/unreservable -- nothing to reserve or release.`,
      { ...base, outcome: 'unreservable', ownerSprintId: null },
    );
  }

  const currentOwner = existing.reservedBy ?? null;

  if (input.action === 'reserve') {
    if (!input.sprint_id) {
      return reservationResult('[-] sprint_id is required for action "reserve".', {
        ...base, outcome: 'invalid_input', ownerSprintId: currentOwner,
      });
    }
    if (currentOwner && currentOwner !== input.sprint_id) {
      return reservationResult(
        `[-] Member "${existing.friendlyName}" is already reserved by "${currentOwner}". Use force_release to clear a wedged reservation, or release it as that sprint first.`,
        { ...base, outcome: 'already_reserved_by_other', ownerSprintId: currentOwner },
      );
    }
    const updated = updateAgent(existing.id, { reservedBy: input.sprint_id });
    // Store-write failure (updateAgent returned falsy): this is a hard
    // failure of the reserve, not a success. Without the leading '[-]'
    // marker, runner.js's callFor() (fleet-sprint/runner.js) has nothing to
    // distinguish this from a genuine "[OK] ... reserved" string and
    // default-trusts it as ok:true -- which let a resume re-reserve
    // (reReserveForResume) continue as if the member had actually been
    // re-acquired even though the reservation store never recorded it.
    // Marking it '[-]' routes it through callFor()'s existing rejection
    // branch alongside the "already reserved by X" case above. The
    // structured `outcome: 'failed'` (apra-fleet-3swo.7.1) is the
    // machine-readable form of that same signal.
    if (!updated) {
      return reservationResult(`[-] Failed to reserve member "${existing.id}".`, {
        ...base, outcome: 'failed', ownerSprintId: currentOwner,
      });
    }
    logLine('member_reservation', `action=reserve id=${updated.id} name=${updated.friendlyName} reservedBy=${input.sprint_id}`, updated);
    writeStatusline();
    return currentOwner === input.sprint_id
      ? reservationResult(
        `[OK] Member "${existing.friendlyName}" reservation refreshed for "${input.sprint_id}" (was already held by this sprint).`,
        { ...base, outcome: 'reservation_refreshed', ownerSprintId: currentOwner },
      )
      : reservationResult(
        `[OK] Member "${existing.friendlyName}" reserved for "${input.sprint_id}".`,
        { ...base, outcome: 'reserved', ownerSprintId: currentOwner },
      );
  }

  if (input.action === 'release') {
    if (!input.sprint_id) {
      return reservationResult('[-] sprint_id is required for action "release".', {
        ...base, outcome: 'invalid_input', ownerSprintId: currentOwner,
      });
    }
    if (!currentOwner) {
      return reservationResult(
        `[OK] Member "${existing.friendlyName}" was not reserved. Nothing to release.`,
        { ...base, outcome: 'not_reserved', ownerSprintId: null },
      );
    }
    if (currentOwner !== input.sprint_id) {
      return reservationResult(
        `[-] Member "${existing.friendlyName}" is reserved by "${currentOwner}", not "${input.sprint_id}". Refusing to release someone else's reservation -- use force_release to override.`,
        { ...base, outcome: 'already_reserved_by_other', ownerSprintId: currentOwner },
      );
    }
    const updated = updateAgent(existing.id, { reservedBy: null });
    if (!updated) {
      return reservationResult(`Failed to release member "${existing.id}".`, {
        ...base, outcome: 'failed', ownerSprintId: currentOwner,
      });
    }
    logLine('member_reservation', `action=release id=${updated.id} name=${updated.friendlyName}`, updated);
    writeStatusline();
    return reservationResult(
      `[OK] Member "${existing.friendlyName}" reservation released.`,
      { ...base, outcome: 'released', ownerSprintId: currentOwner },
    );
  }

  // force_release: clears regardless of current owner, idempotent when already unreserved.
  const updated = updateAgent(existing.id, { reservedBy: null });
  if (!updated) {
    return reservationResult(`Failed to force-release member "${existing.id}".`, {
      ...base, outcome: 'failed', ownerSprintId: currentOwner,
    });
  }
  logLine('member_reservation', `action=force_release id=${updated.id} name=${updated.friendlyName} previousOwner=${currentOwner ?? 'none'}`, updated);
  writeStatusline();
  return currentOwner
    ? reservationResult(
      `[OK] Member "${existing.friendlyName}" reservation forcibly cleared (was held by "${currentOwner}").`,
      { ...base, outcome: 'force_released', ownerSprintId: currentOwner },
    )
    : reservationResult(
      `[OK] Member "${existing.friendlyName}" was not reserved. Nothing to force-release.`,
      { ...base, outcome: 'not_reserved', ownerSprintId: null },
    );
}
