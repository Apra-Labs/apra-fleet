/**
 * Shared token grammar for the `{{secret.NAME}}` credential-store placeholder
 * (apra-fleet secret terminology standardization). `{{secure.NAME}}` is the
 * legacy spelling -- it still resolves identically, but every call site that
 * finds one must emit legacyTokenWarning() so operators migrate off it.
 * There is no hard-fail; both spellings are accepted indefinitely.
 *
 * Every credential-token regex/redaction/warning in the codebase should go
 * through this module instead of maintaining its own local pattern.
 */

/** Matches both {{secret.NAME}} (canonical) and {{secure.NAME}} (legacy). Global + stateful -- clone with `new RegExp(SECRET_TOKEN_RE.source, 'g')` or reset `.lastIndex` before reuse. */
export const SECRET_TOKEN_RE = /\{\{(secret|secure)\.([a-zA-Z0-9_-]{1,64})\}\}/g;

export interface SecretTokenMatch {
  /** The credential name inside the token. */
  name: string;
  /** The full matched token text, e.g. "{{secret.FOO}}" or "{{secure.FOO}}". */
  raw: string;
  /** True when this occurrence used the deprecated {{secure.NAME}} spelling. */
  legacy: boolean;
}

/** Finds every {{secret.NAME}} / {{secure.NAME}} token in `text`, in order of appearance. */
export function findSecretTokens(text: string): SecretTokenMatch[] {
  const re = new RegExp(SECRET_TOKEN_RE.source, 'g');
  const results: SecretTokenMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    results.push({ name: m[2], raw: m[0], legacy: m[1] === 'secure' });
  }
  return results;
}

/** True if `text` contains at least one {{secret.NAME}} or {{secure.NAME}} token. */
export function hasSecretToken(text: string): boolean {
  const re = new RegExp(SECRET_TOKEN_RE.source);
  return re.test(text);
}

/** Replaces every {{secret.NAME}} / {{secure.NAME}} token in `text` with `[REDACTED]`. */
export function redactSecretTokens(text: string): string {
  const re = new RegExp(SECRET_TOKEN_RE.source, 'g');
  return text.replace(re, '[REDACTED]');
}

/** Canonical placeholder text for a given credential name, e.g. formatSecretToken('FOO') -> "{{secret.FOO}}". */
export function formatSecretToken(name: string): string {
  return `{{secret.${name}}}`;
}

/**
 * One-line deprecation notice for the given legacy {{secure.NAME}} token
 * names (deduplicated). Callers append this to a tool's text result and log
 * it whenever resolveSecretTokens-style resolution sees at least one legacy
 * spelling, so operators see the nudge without a hard failure.
 * Deliberately unbraced: the log masker redacts any braced token, and a
 * braced form here would render as "[REDACTED] is deprecated" in fleet logs.
 */
export function legacyTokenWarning(names: string[]): string {
  const unique = [...new Set(names)];
  return unique
    .map((n) => `[deprecated] secure.${n} is the legacy spelling -- write secret.${n} instead (still accepted for now)`)
    .join('; ');
}
