/**
 * Shared dated-pin rule for LLM model tier values (apra-fleet-rmkb-dz1).
 *
 * A bare family alias (e.g. Claude's haiku / sonnet / opus, see
 * src/providers/claude.ts:319-322) is preferred wherever a tier resolves with
 * no explicit override: the CLI resolves the alias to whatever generation is
 * current, so it never goes stale. A DATED model ID (one ending in a trailing
 * date suffix, e.g. claude-sonnet-4-20250514) is a point-in-time pin --
 * providers periodically retire dated snapshots, and a pin left sitting in a
 * member record or user config silently 404s at dispatch time with no warning
 * until then (apra-fleet-rmkb-dz1: exactly this, on a live remote member).
 *
 * This predicate mirrors checkModelAliasStaleness in
 * packages/apra-fleet-se/apra-pm/.claude/workflows/auto-sprint.js:1176-1190 so
 * the server-side check here and the sprint-preflight check there cannot
 * disagree on the same input. Keep the regex in sync with that copy if either
 * changes.
 *
 * Wired from exactly two call sites today:
 *   - the update_member tier normalization (src/tools/update-member.ts), so a
 *     dated pin is warned about at the moment an operator sets it, and
 *   - getModelOverride (src/services/user-config.ts), so a dated pin already
 *     sitting in user config is surfaced rather than silently winning over
 *     the provider's bare-alias default.
 *
 * NOT wired into src/tools/register-member.ts. That file has its own inline
 * duplicate of the update_member tier-normalization block (there is no shared
 * helper between the two today), so wiring it in would mean editing a file
 * that apra-fleet-rmkb-3n5.5.2 is concurrently rewriting this sprint for the
 * sshd forwarding-capability probe. This is a deliberate, temporary gap --
 * wire register_member to this same rule once that lane lands, rather than
 * extracting the register-member.ts copy into this module now.
 */

/** Matches a trailing 8-digit date suffix, e.g. "-20250514". */
const DATED_MODEL_ID_RE = /-\d{8}$/;

/** True when `modelId` looks like a dated point-in-time model pin rather than
 *  a bare, self-updating family alias. */
export function isDatedModelPin(modelId: string): boolean {
  return typeof modelId === 'string' && DATED_MODEL_ID_RE.test(modelId);
}

/** Scans a tier-name -> model-id map (e.g. { cheap, standard, premium }) and
 *  returns "tier=id" strings for every value that looks like a dated pin.
 *  Empty/undefined input yields an empty array. Mirrors
 *  checkModelAliasStaleness's return shape in auto-sprint.js so callers on
 *  both sides can format the same way. */
export function findDatedModelPins(
  tierMap: Record<string, string | undefined> | undefined | null,
): string[] {
  const stale: string[] = [];
  if (!tierMap) return stale;
  for (const [tier, id] of Object.entries(tierMap)) {
    if (typeof id === 'string' && isDatedModelPin(id)) stale.push(`${tier}=${id}`);
  }
  return stale;
}

/** Formats a non-empty findDatedModelPins() result into a single warning
 *  string. Callers should only call this when the array is non-empty. */
export function datedModelPinWarning(pins: string[]): string {
  return `dated-looking model ID(s) (prefer bare aliases, e.g. sonnet instead of claude-sonnet-4-20250514): ${pins.join(', ')}`;
}
