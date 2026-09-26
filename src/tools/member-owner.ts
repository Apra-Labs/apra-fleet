import { z } from 'zod';
import { updateAgent } from '../services/registry.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { validateOwnerPackage, validateOwnerRef } from '../utils/owner-validation.js';
import { logLine } from '../utils/log-helpers.js';
import { writeStatusline } from '../services/statusline.js';
import { FLEET_RESERVATION_PACKAGE, workflowPackageService } from '../services/workflow-packages.js';
import type { Agent } from '../types.js';

/**
 * member_owner (apra-fleet-4qtu.2, F1/DQ-22 design refs).
 *
 * Sets or clears the `owner` {package, ref} tag a package/consumer (e.g. a
 * fleet-sprint project) uses to bind a member to its own bookkeeping. Both
 * "set" and "clear" refuse while the member is held (reservedBy set) via
 * memberHeldRefusal() below -- kept as a single, exported check function so
 * the workflow-package `holds` consult (DQ-22, sprint S7) can extend it
 * without duplicating the reservedBy check here or in update_member's own
 * inline copy of the same rule (src/tools/update-member.ts). That consult
 * lives in memberHeldCheck() below, which combines the sync reservedBy
 * check with an async consult of every registered workflow package's holds
 * route -- exported so remove_member (src/tools/remove-member.ts) runs the
 * exact same combined check before a non-forced removal instead of growing
 * its own copy.
 */
export const memberOwnerSchema = z.object({
  ...memberIdentifier,
  action: z.enum(['set', 'clear']).describe(
    '"set" writes owner {package, ref} (both required, format-validated; when "package" is a '
    + 'registered workflow package declaring ownerRefs, "ref" must be a known ref for it). '
    + '"clear" removes the owner tag. Both refuse with error code member-held while the member '
    + 'is reserved (reservedBy set) or while a registered workflow package reports the member held.'
  ),
  package: z.string().optional().describe('Package/consumer that owns this member (e.g. "fleet-sprint"). Required for action "set".'),
  ref: z.string().optional().describe('Consumer-side reference this owner binding points at (e.g. a sprint/checkout id). Required for action "set".'),
});

export type MemberOwnerInput = z.infer<typeof memberOwnerSchema>;

/** Machine-readable outcome discriminator, mirroring member_reservation's MemberReservationOutcome. */
export type MemberOwnerOutcome =
  | 'set'
  | 'cleared'
  | 'invalid_input'
  | 'member_held'
  | 'member_not_found'
  | 'failed';

/** One entry in heldBy: which holder is refusing the operation, and why.
 *  `package` is the registered workflow package id reporting the hold, or
 *  the FLEET_RESERVATION_PACKAGE sentinel for the fleet's own built-in
 *  reservedBy hold (never a real workflow package). `reason` is either the
 *  literal 'reservation' (reservedBy), 'holds-unavailable' (the owning
 *  package's holds call errored -- fail closed), or whatever free-form
 *  reason text the reporting package's holds route supplied. */
export interface MemberHeldByEntry {
  package: string;
  reason: string;
}

interface MemberOwnerFields {
  /** Machine-readable outcome discriminator. Branch on this, never on `text`. */
  outcome: MemberOwnerOutcome;
  /** True when the requested operation took effect. */
  ok: boolean;
  /** The action that was requested. */
  action: 'set' | 'clear';
  /** Registry id of the resolved member, or null when no member resolved. */
  memberId: string | null;
  /** Friendly name of the resolved member, or null when no member resolved. */
  memberName: string | null;
  /** The owner value AFTER this call (null when cleared, absent, or the call failed before writing). */
  owner: { package: string; ref: string } | null;
  /** Every holder currently refusing the operation, or null when nothing held it (including
   *  every non-member_held outcome). Populated only alongside outcome 'member_held'. */
  heldBy: MemberHeldByEntry[] | null;
}

export interface MemberOwnerStructured extends MemberOwnerFields {
  [key: string]: unknown;
}

export interface MemberOwnerResult {
  text: string;
  structuredContent: MemberOwnerStructured;
}

function ownerResult(
  text: string,
  fields: Omit<MemberOwnerFields, 'ok'> & { ok?: boolean },
): MemberOwnerResult {
  const failedOutcomes: MemberOwnerOutcome[] = ['invalid_input', 'member_held', 'member_not_found', 'failed'];
  const ok = fields.ok ?? !failedOutcomes.includes(fields.outcome);
  return { text, structuredContent: { ...fields, ok } };
}

/**
 * Single member-held refusal check for member_owner. Returns a human-
 * readable reason when the member is currently held (reservedBy set), or
 * null when the operation may proceed. Exported so a later workflow-package
 * `holds` consult (DQ-22) can call this AND its own holds check from one
 * place instead of two call sites drifting apart.
 */
export function memberHeldRefusal(agent: Agent): string | null {
  if (agent.reservedBy) {
    return `Member "${agent.friendlyName}" is held (reservedBy=${agent.reservedBy}).`;
  }
  return null;
}

/** Sentinel `package` value for a heldBy entry produced by the fleet's own
 *  built-in reservedBy hold. Re-exported from workflow-packages.ts, which
 *  owns the canonical definition AND enforces it: POST
 *  /api/workflow-packages/register rejects (400, reason `reserved-id`) any
 *  package trying to register with this exact id, so a `heldBy` entry
 *  naming this package is unambiguously the built-in reservation, never a
 *  workflow package's own report (apra-fleet-g6ap.8 -- see
 *  workflow-packages.ts's doc comment on the source constant for the full
 *  history of why that guarantee did not hold before this fix). */
export { FLEET_RESERVATION_PACKAGE };

/**
 * Combined member-held check (DQ-22): merges the sync reservedBy check
 * (memberHeldRefusal) with an async consult of every registered workflow
 * package's holds route (workflowPackageService.consultHolds). Exported so
 * both member_owner (set/clear) and remove_member run the identical check
 * from one place instead of two call sites drifting apart.
 *
 * `owningPackages` names EVERY package whose holds-call ERROR must fail
 * CLOSED (a holds-unavailable heldBy entry) rather than being skipped, not
 * just skipped-and-logged like a non-owning package's error. `clear` and
 * `remove_member` pass a single-element list: the package named in the
 * member's CURRENT owner tag (or none, when the member has no owner). `set`
 * passes up to two: the CURRENT owner tag's package AND the requested
 * package.
 *
 * apra-fleet-g6ap.7 (product decision): `set` was originally fail-closed
 * for the requested package only, so a reassignment away from package A
 * proceeded even if A's own holds call errored -- in tension with this
 * check's rationale ("a package that cannot vouch for its own member must
 * not lose it silently"), since a reassignment is exactly how A loses the
 * member. Resolved as: `set` fails closed for BOTH the member's current
 * owner package and the requested package, so A cannot silently lose a
 * member it cannot currently vouch for, just like clear/remove. Pass an
 * empty array, or entries that are null, when there is no such package
 * (nulls are filtered out; duplicates collapse to a single fail-closed
 * check, e.g. re-setting the same package as its own current owner).
 *
 * Never throws: consultHolds() itself never throws, and a failure to reach
 * a non-owning package is logged and skipped rather than surfaced.
 */
export async function memberHeldCheck(
  agent: Agent,
  owningPackages: ReadonlyArray<string | null>,
): Promise<{ heldBy: MemberHeldByEntry[]; refusalText: string | null }> {
  const heldBy: MemberHeldByEntry[] = [];
  const refusalParts: string[] = [];
  const owningSet = new Set(owningPackages.filter((p): p is string => p !== null));

  const reservationReason = memberHeldRefusal(agent);
  if (reservationReason) {
    heldBy.push({ package: FLEET_RESERVATION_PACKAGE, reason: 'reservation' });
    refusalParts.push(reservationReason);
  }

  const results = await workflowPackageService.consultHolds(agent.id);
  for (const result of results) {
    if (result.error) {
      if (owningSet.has(result.packageId)) {
        heldBy.push({ package: result.packageId, reason: 'holds-unavailable' });
        refusalParts.push(`Package "${result.packageId}" could not confirm holds for this member (holds-unavailable).`);
      } else {
        logLine('member_owner', `holds consult failed for package="${result.packageId}": ${result.error}`, agent);
      }
      continue;
    }
    if (result.held) {
      const reason = result.reason && result.reason !== '' ? result.reason : 'held';
      heldBy.push({ package: result.packageId, reason });
      refusalParts.push(`Package "${result.packageId}" reports this member held (${reason}).`);
    }
  }

  return { heldBy, refusalText: refusalParts.length > 0 ? refusalParts.join(' ') : null };
}

export async function memberOwner(input: MemberOwnerInput): Promise<MemberOwnerResult> {
  const existingOrError = resolveMember(input.member_id, input.member_name);
  if (typeof existingOrError === 'string') {
    // resolveMember's own error prose is preserved byte-for-byte; only the
    // structured discriminator is new.
    return ownerResult(existingOrError, {
      outcome: 'member_not_found',
      action: input.action,
      memberId: input.member_id ?? null,
      memberName: input.member_name ?? null,
      owner: null,
      heldBy: null,
    });
  }
  const existing = existingOrError as Agent;

  const base = {
    action: input.action,
    memberId: existing.id,
    memberName: existing.friendlyName,
  };

  if (input.action === 'set') {
    if (!input.package || !input.ref) {
      return ownerResult('[-] Both "package" and "ref" are required for action "set". Owner was NOT changed.', {
        ...base, outcome: 'invalid_input', owner: existing.owner ?? null, heldBy: null,
      });
    }
    const pkgCheck = validateOwnerPackage(input.package);
    if (!pkgCheck.ok) {
      return ownerResult(`[-] ${pkgCheck.error} Owner was NOT changed.`, {
        ...base, outcome: 'invalid_input', owner: existing.owner ?? null, heldBy: null,
      });
    }
    const refCheck = validateOwnerRef(input.ref);
    if (!refCheck.ok) {
      return ownerResult(`[-] ${refCheck.error} Owner was NOT changed.`, {
        ...base, outcome: 'invalid_input', owner: existing.owner ?? null, heldBy: null,
      });
    }

    // ownerRefs validation (DQ-22): only when "package" is a REGISTERED
    // workflow package that declares an ownerRefs path -- any other package
    // (unregistered, or registered without ownerRefs) keeps today's
    // format-only validation, already satisfied above.
    const registeredPackage = workflowPackageService.list().find((p) => p.id === input.package);
    if (registeredPackage && registeredPackage.ownerRefs) {
      const ownerRefCheck = await workflowPackageService.checkOwnerRef(input.package, input.ref);
      if ('error' in ownerRefCheck) {
        return ownerResult(`[-] ${ownerRefCheck.error} Owner was NOT changed.`, {
          ...base, outcome: 'failed', owner: existing.owner ?? null, heldBy: null,
        });
      }
      if (!ownerRefCheck.known) {
        return ownerResult(`[-] unknown ref for package "${input.package}". Owner was NOT changed.`, {
          ...base, outcome: 'invalid_input', owner: existing.owner ?? null, heldBy: null,
        });
      }
    }

    // apra-fleet-g6ap.7: fail closed for BOTH the member's current owner
    // package (it must be able to vouch that it is not silently losing this
    // member to a reassignment) and the requested package.
    const { heldBy, refusalText } = await memberHeldCheck(existing, [existing.owner?.package ?? null, input.package]);
    if (refusalText) {
      return ownerResult(`[-] Cannot set owner: ${refusalText} Error code: member-held. Owner was NOT changed.`, {
        ...base, outcome: 'member_held', owner: existing.owner ?? null, heldBy,
      });
    }

    const owner = { package: input.package, ref: input.ref };
    const updated = updateAgent(existing.id, { owner });
    if (!updated) {
      return ownerResult(`[-] Failed to set owner on member "${existing.id}".`, {
        ...base, outcome: 'failed', owner: existing.owner ?? null, heldBy: null,
      });
    }
    logLine('member_owner', `action=set id=${updated.id} name=${updated.friendlyName} owner=${owner.package}@${owner.ref}`, updated);
    writeStatusline();
    return ownerResult(`[OK] Member "${existing.friendlyName}" owner set to ${owner.package}@${owner.ref}.`, {
      ...base, outcome: 'set', owner, heldBy: null,
    });
  }

  // action === 'clear'
  const { heldBy, refusalText } = await memberHeldCheck(existing, [existing.owner?.package ?? null]);
  if (refusalText) {
    return ownerResult(`[-] Cannot clear owner: ${refusalText} Error code: member-held. Owner was NOT changed.`, {
      ...base, outcome: 'member_held', owner: existing.owner ?? null, heldBy,
    });
  }

  if (!existing.owner) {
    return ownerResult(`[OK] Member "${existing.friendlyName}" had no owner set. Nothing to clear.`, {
      ...base, outcome: 'cleared', owner: null, heldBy: null,
    });
  }

  const updated = updateAgent(existing.id, { owner: undefined });
  if (!updated) {
    return ownerResult(`[-] Failed to clear owner on member "${existing.id}".`, {
      ...base, outcome: 'failed', owner: existing.owner ?? null, heldBy: null,
    });
  }
  logLine('member_owner', `action=clear id=${updated.id} name=${updated.friendlyName}`, updated);
  writeStatusline();
  return ownerResult(`[OK] Member "${existing.friendlyName}" owner cleared.`, {
    ...base, outcome: 'cleared', owner: null, heldBy: null,
  });
}
