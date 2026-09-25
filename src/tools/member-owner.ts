import { z } from 'zod';
import { updateAgent } from '../services/registry.js';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { validateOwnerPackage, validateOwnerRef } from '../utils/owner-validation.js';
import { logLine } from '../utils/log-helpers.js';
import { writeStatusline } from '../services/statusline.js';
import type { Agent } from '../types.js';

/**
 * member_owner (apra-fleet-4qtu.2, F1/DQ-22 design refs).
 *
 * Sets or clears the `owner` {package, ref} tag a package/consumer (e.g. a
 * fleet-sprint project) uses to bind a member to its own bookkeeping. Both
 * "set" and "clear" refuse while the member is held (reservedBy set) via
 * memberHeldRefusal() below -- kept as a single, exported check function so
 * the later workflow-package `holds` consult (DQ-22, sprint S7) can extend
 * it without duplicating the reservedBy check here or in update_member's own
 * inline copy of the same rule (src/tools/update-member.ts).
 */
export const memberOwnerSchema = z.object({
  ...memberIdentifier,
  action: z.enum(['set', 'clear']).describe(
    '"set" writes owner {package, ref} (both required, format-validated). '
    + '"clear" removes the owner tag. Both refuse with error code member-held while the member is reserved (reservedBy set).'
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
        ...base, outcome: 'invalid_input', owner: existing.owner ?? null,
      });
    }
    const pkgCheck = validateOwnerPackage(input.package);
    if (!pkgCheck.ok) {
      return ownerResult(`[-] ${pkgCheck.error} Owner was NOT changed.`, {
        ...base, outcome: 'invalid_input', owner: existing.owner ?? null,
      });
    }
    const refCheck = validateOwnerRef(input.ref);
    if (!refCheck.ok) {
      return ownerResult(`[-] ${refCheck.error} Owner was NOT changed.`, {
        ...base, outcome: 'invalid_input', owner: existing.owner ?? null,
      });
    }

    const heldReason = memberHeldRefusal(existing);
    if (heldReason) {
      return ownerResult(`[-] Cannot set owner: ${heldReason} Error code: member-held. Owner was NOT changed.`, {
        ...base, outcome: 'member_held', owner: existing.owner ?? null,
      });
    }

    const owner = { package: input.package, ref: input.ref };
    const updated = updateAgent(existing.id, { owner });
    if (!updated) {
      return ownerResult(`[-] Failed to set owner on member "${existing.id}".`, {
        ...base, outcome: 'failed', owner: existing.owner ?? null,
      });
    }
    logLine('member_owner', `action=set id=${updated.id} name=${updated.friendlyName} owner=${owner.package}@${owner.ref}`, updated);
    writeStatusline();
    return ownerResult(`[OK] Member "${existing.friendlyName}" owner set to ${owner.package}@${owner.ref}.`, {
      ...base, outcome: 'set', owner,
    });
  }

  // action === 'clear'
  const heldReason = memberHeldRefusal(existing);
  if (heldReason) {
    return ownerResult(`[-] Cannot clear owner: ${heldReason} Error code: member-held. Owner was NOT changed.`, {
      ...base, outcome: 'member_held', owner: existing.owner ?? null,
    });
  }

  if (!existing.owner) {
    return ownerResult(`[OK] Member "${existing.friendlyName}" had no owner set. Nothing to clear.`, {
      ...base, outcome: 'cleared', owner: null,
    });
  }

  const updated = updateAgent(existing.id, { owner: undefined });
  if (!updated) {
    return ownerResult(`[-] Failed to clear owner on member "${existing.id}".`, {
      ...base, outcome: 'failed', owner: existing.owner ?? null,
    });
  }
  logLine('member_owner', `action=clear id=${updated.id} name=${updated.friendlyName}`, updated);
  writeStatusline();
  return ownerResult(`[OK] Member "${existing.friendlyName}" owner cleared.`, {
    ...base, outcome: 'cleared', owner: null,
  });
}
