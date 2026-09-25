import { z } from 'zod';
import { updateAgent } from '../services/registry.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { logLine } from '../utils/log-helpers.js';
import { writeStatusline } from '../services/statusline.js';
import { isPidAlive } from '../utils/pid-helpers.js';
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
  owner_ref: z.object({ package: z.string().min(1), ref: z.string().min(1) }).optional().describe(
    'Owner tag the caller expects this member to carry, e.g. {package: "fleet-sprint", ref: "<project>"}. When supplied and the member IS owner-tagged with a different package or ref, "reserve" is refused (outcome member_other_owner) and nothing is written. An untagged member, or a call without owner_ref, is never refused. Ignored by "release" and "force_release".'
  ),
  pid: z.number().int().positive().optional().describe(
    'Process id of the reserving process ON THE FLEET SERVER\'S HOST. Recorded with the reservation so a reservation whose holder died is reaped automatically instead of wedging the member. Omit when the caller does not run on that host -- a reservation without a pid is never reaped.'
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
  | 'failed'
  /**
   * Refused: the caller passed an owner_ref and the member carries a
   * DIFFERENT owner tag, so it belongs to another package/consumer
   * (apra-fleet-ecjf.4). Nothing was written -- this is not a conflict over
   * who currently holds the member, it is a refusal to touch someone else's
   * member at all.
   */
  | 'member_other_owner';

/**
 * Reservation as a READER sees it (apra-fleet-ecjf.3).
 *
 * Deliberately wider than Agent['reservation']: a legacy member that only
 * ever carried the `reservedBy` string has no timestamp, so `at` is nullable
 * here while the stored object always has one.
 */
export interface ReservationView {
  /** Sprint/run id holding the reservation (always equals agent.reservedBy). */
  runId: string;
  /** Holder's pid on the fleet server's host, or null when unknown/legacy. */
  pid: number | null;
  /** ISO 8601 time the reservation was taken/refreshed, null for legacy. */
  at: string | null;
}

/**
 * The single read path for "who holds this member". Returns the stored
 * reservation object, a synthesised view for a legacy string-only member
 * ({runId: reservedBy, pid: null, at: null}), or null when unreserved.
 */
export function getReservation(agent: Agent): ReservationView | null {
  const stored = agent.reservation;
  if (stored && stored.runId) {
    return { runId: stored.runId, pid: stored.pid ?? null, at: stored.at ?? null };
  }
  if (agent.reservedBy) {
    return { runId: agent.reservedBy, pid: null, at: null };
  }
  return null;
}

/**
 * Lazy dead-holder reaping (apra-fleet-ecjf.3).
 *
 * Clears BOTH reservation fields when the holder recorded a pid and that
 * process is gone. A legacy or pid-less reservation is never reaped -- its
 * holder may well live on another host, and isPidAlive() can only speak for
 * this one. isPidAlive() treats EPERM as alive on purpose: a false "dead"
 * would steal a live reservation, which is far worse than leaving a stale
 * one for the operator to force_release.
 *
 * Returns the agent to keep reading from -- the caller MUST use it, because
 * the pre-reap object still carries the cleared reservation and would
 * otherwise block the very reserve this reaping exists to unblock.
 */
export function reapIfDead(agent: Agent): { agent: Agent; reaped: boolean } {
  const reservation = agent.reservation;
  if (!reservation || reservation.pid == null) return { agent, reaped: false };
  if (isPidAlive(reservation.pid)) return { agent, reaped: false };
  const updated = updateAgent(agent.id, { reservation: null, reservedBy: null });
  if (!updated) return { agent, reaped: false };
  logLine(
    'member_reservation',
    `reaped dead reservation runId=${reservation.runId} pid=${reservation.pid}`,
    updated,
  );
  return { agent: updated, reaped: true };
}

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
  /**
   * The member's reservation AFTER this call (apra-fleet-ecjf.3) -- not
   * "after a successful call": on a refusal the reservation is unchanged, so
   * this is the blocking holder's object. null when unreserved or no member
   * resolved.
   */
  reservation: ReservationView | null;
  /** True when a dead-pid holder was cleared during this call. */
  reaped: boolean;
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
    'member_other_owner',
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
      reservation: null,
      reaped: false,
    });
  }
  let existing = existingOrError as Agent;

  const base = {
    action: input.action,
    memberId: existing.id,
    memberName: existing.friendlyName,
    sprintId: input.sprint_id ?? null,
  };

  if (existing.unreservable) {
    return reservationResult(
      `[OK] Member "${existing.friendlyName}" is shared/unreservable -- nothing to reserve or release.`,
      {
        ...base,
        outcome: 'unreservable',
        ownerSprintId: null,
        reservation: getReservation(existing),
        reaped: false,
      },
    );
  }

  let reaped = false;

  if (input.action === 'reserve') {
    if (!input.sprint_id) {
      return reservationResult('[-] sprint_id is required for action "reserve".', {
        ...base,
        outcome: 'invalid_input',
        ownerSprintId: getReservation(existing)?.runId ?? null,
        reservation: getReservation(existing),
        reaped: false,
      });
    }
    // Owner-tag refusal (apra-fleet-ecjf.4). Runs after member resolution,
    // after the unreservable short-circuit and BEFORE both the reaping and
    // the already_reserved_by_other check, so a member owned by another
    // package is refused regardless of who currently holds it -- and so the
    // refusal writes NOTHING at all (reaping is a real store write, so doing
    // it first would make a "refused" call still mutate the member). The
    // owner tag itself is only ever READ here; member_owner/register_member/
    // update_member are the writers.
    const ownerRef = input.owner_ref;
    const currentTag = existing.owner;
    if (ownerRef && currentTag && (currentTag.package !== ownerRef.package || currentTag.ref !== ownerRef.ref)) {
      return reservationResult(
        `[-] Member "${existing.friendlyName}" is owned by "${currentTag.package}@${currentTag.ref}", not "${ownerRef.package}@${ownerRef.ref}". Refusing to reserve a member owned by another package.`,
        {
          ...base,
          outcome: 'member_other_owner',
          ownerSprintId: getReservation(existing)?.runId ?? null,
          reservation: getReservation(existing),
          reaped: false,
        },
      );
    }
    // Lazy reaping runs BEFORE the holder check so a dead holder no longer
    // blocks a fresh reserve. `existing` is reassigned from the reaper's
    // return: the pre-reap object still carries the cleared reservation and
    // would re-block the very claim this unwedges.
    const reapResult = reapIfDead(existing);
    existing = reapResult.agent;
    reaped = reapResult.reaped;
    const currentOwner = getReservation(existing)?.runId ?? null;
    if (currentOwner && currentOwner !== input.sprint_id) {
      return reservationResult(
        `[-] Member "${existing.friendlyName}" is already reserved by "${currentOwner}". Use force_release to clear a wedged reservation, or release it as that sprint first.`,
        {
          ...base,
          outcome: 'already_reserved_by_other',
          ownerSprintId: currentOwner,
          reservation: getReservation(existing),
          reaped,
        },
      );
    }
    // Both fields are written in ONE updateAgent call so the object and its
    // reservedBy string mirror can never diverge (a half-applied write would
    // leave every legacy reader disagreeing with the object readers).
    const reservation = { runId: input.sprint_id, pid: input.pid ?? null, at: new Date().toISOString() };
    const updated = updateAgent(existing.id, { reservedBy: input.sprint_id, reservation });
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
        ...base,
        outcome: 'failed',
        ownerSprintId: currentOwner,
        reservation: getReservation(existing),
        reaped,
      });
    }
    logLine('member_reservation', `action=reserve id=${updated.id} name=${updated.friendlyName} reservedBy=${input.sprint_id}`, updated);
    writeStatusline();
    return currentOwner === input.sprint_id
      ? reservationResult(
        `[OK] Member "${existing.friendlyName}" reservation refreshed for "${input.sprint_id}" (was already held by this sprint).`,
        {
          ...base,
          outcome: 'reservation_refreshed',
          ownerSprintId: currentOwner,
          reservation: getReservation(updated),
          reaped,
        },
      )
      : reservationResult(
        `[OK] Member "${existing.friendlyName}" reserved for "${input.sprint_id}".`,
        {
          ...base,
          outcome: 'reserved',
          ownerSprintId: currentOwner,
          reservation: getReservation(updated),
          reaped,
        },
      );
  }

  // release/force_release read the CURRENT holder through the same accessor,
  // so a legacy string-only member stays releasable exactly as before. They
  // never reap: clearing is what they are about to do anyway, and a reap
  // here would only muddy "not_reserved" vs "released".
  const currentOwner = getReservation(existing)?.runId ?? null;

  if (input.action === 'release') {
    if (!input.sprint_id) {
      return reservationResult('[-] sprint_id is required for action "release".', {
        ...base, outcome: 'invalid_input', ownerSprintId: currentOwner, reservation: getReservation(existing), reaped,
      });
    }
    if (!currentOwner) {
      return reservationResult(
        `[OK] Member "${existing.friendlyName}" was not reserved. Nothing to release.`,
        { ...base, outcome: 'not_reserved', ownerSprintId: null, reservation: null, reaped },
      );
    }
    if (currentOwner !== input.sprint_id) {
      return reservationResult(
        `[-] Member "${existing.friendlyName}" is reserved by "${currentOwner}", not "${input.sprint_id}". Refusing to release someone else's reservation -- use force_release to override.`,
        { ...base, outcome: 'already_reserved_by_other', ownerSprintId: currentOwner, reservation: getReservation(existing), reaped },
      );
    }
    const updated = updateAgent(existing.id, { reservedBy: null, reservation: null });
    if (!updated) {
      return reservationResult(`Failed to release member "${existing.id}".`, {
        ...base, outcome: 'failed', ownerSprintId: currentOwner, reservation: getReservation(existing), reaped,
      });
    }
    logLine('member_reservation', `action=release id=${updated.id} name=${updated.friendlyName}`, updated);
    writeStatusline();
    return reservationResult(
      `[OK] Member "${existing.friendlyName}" reservation released.`,
      { ...base, outcome: 'released', ownerSprintId: currentOwner, reservation: null, reaped },
    );
  }

  // force_release: clears regardless of current owner, idempotent when already unreserved.
  const updated = updateAgent(existing.id, { reservedBy: null, reservation: null });
  if (!updated) {
    return reservationResult(`Failed to force-release member "${existing.id}".`, {
      ...base, outcome: 'failed', ownerSprintId: currentOwner, reservation: getReservation(existing), reaped,
    });
  }
  logLine('member_reservation', `action=force_release id=${updated.id} name=${updated.friendlyName} previousOwner=${currentOwner ?? 'none'}`, updated);
  writeStatusline();
  return currentOwner
    ? reservationResult(
      `[OK] Member "${existing.friendlyName}" reservation forcibly cleared (was held by "${currentOwner}").`,
      { ...base, outcome: 'force_released', ownerSprintId: currentOwner, reservation: null, reaped },
    )
    : reservationResult(
      `[OK] Member "${existing.friendlyName}" was not reserved. Nothing to force-release.`,
      { ...base, outcome: 'not_reserved', ownerSprintId: null, reservation: null, reaped },
    );
}
