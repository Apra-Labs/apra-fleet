/**
 * Shared validation for Agent.env (register_member/update_member's `env`
 * field, DQ-23). Kept in one place so register-member.ts, update-member.ts
 * and any test that needs to construct a valid/invalid map do not each
 * hardcode their own copy of the pattern/cap and drift apart.
 *
 * Portable env-name pattern: the POSIX "Portable Character Set" rule for
 * environment variable names -- starts with a letter or underscore, then
 * letters/digits/underscores only. This excludes names that would need
 * quoting or escaping in any of the shells this fleet dispatches through
 * (bash, cmd, powershell).
 */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Total size cap (sum of every key length + value length, in UTF-16 code
 * units) for a single member's env map. Bounds how much plaintext config
 * a member record can carry -- generous enough for real env maps (dozens of
 * short vars) while keeping registry.json from growing unbounded per member.
 */
export const ENV_MAP_MAX_TOTAL_SIZE = 4096;

export type EnvMapValidationResult =
  | { ok: true; value: Record<string, string> }
  | { ok: false; error: string };

/** Validates an env map against the portable name pattern and the total size cap. */
export function validateEnvMap(env: Record<string, string>): EnvMapValidationResult {
  const invalidNames = Object.keys(env).filter((name) => !ENV_NAME_PATTERN.test(name));
  if (invalidNames.length > 0) {
    return {
      ok: false,
      error: `Invalid env name(s): ${invalidNames.join(', ')}. Names must match ${ENV_NAME_PATTERN} (letters, digits, underscore; cannot start with a digit).`,
    };
  }

  let totalSize = 0;
  for (const [key, value] of Object.entries(env)) {
    totalSize += key.length + value.length;
  }
  if (totalSize > ENV_MAP_MAX_TOTAL_SIZE) {
    return {
      ok: false,
      error: `env map is too large (${totalSize} chars; max ${ENV_MAP_MAX_TOTAL_SIZE} chars total across all names and values).`,
    };
  }

  return { ok: true, value: env };
}
