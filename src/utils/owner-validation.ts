/**
 * Shared format validation for member_owner's {package, ref} pair
 * (apra-fleet-4qtu.2.1). Kept in one place so member-owner.ts and any test
 * that needs to construct a valid/invalid owner do not each hardcode their
 * own copy of the pattern and drift apart.
 *
 * Both package and ref must start with an alphanumeric character (never a
 * separator) and may otherwise contain letters, digits, dot, underscore,
 * dash and slash (ref also allows leading "@" via package's own pattern is
 * NOT extended to ref -- ref additionally excludes "@" since it is meant to
 * read as a plain checkout/sprint identifier, not a scoped name). Whitespace
 * and control characters are always rejected -- this fleet dispatches
 * through multiple shells (bash, cmd, powershell) and an unquoted value
 * containing either would need escaping no matter which one runs it.
 */
export const OWNER_PACKAGE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._@/-]{0,127}$/;
export const OWNER_REF_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/;

export type OwnerFieldValidationResult =
  | { ok: true }
  | { ok: false; error: string };

export function validateOwnerPackage(pkg: string): OwnerFieldValidationResult {
  if (!OWNER_PACKAGE_PATTERN.test(pkg)) {
    return {
      ok: false,
      error: `Invalid owner package "${pkg}". Must start with a letter or digit and match ${OWNER_PACKAGE_PATTERN} (letters, digits, dot, underscore, dash, slash, @; max 128 chars; no whitespace).`,
    };
  }
  return { ok: true };
}

export function validateOwnerRef(ref: string): OwnerFieldValidationResult {
  if (!OWNER_REF_PATTERN.test(ref)) {
    return {
      ok: false,
      error: `Invalid owner ref "${ref}". Must start with a letter or digit and match ${OWNER_REF_PATTERN} (letters, digits, dot, underscore, dash, slash; max 128 chars; no whitespace).`,
    };
  }
  return { ok: true };
}
