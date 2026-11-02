/**
 * Redact known credential values from free text before it is returned to a
 * caller or logged.
 *
 * Replaces every occurrence of each secret value in its raw form, URL-encoded
 * form, base64 of `user:secret` (for every username supplied), and the
 * shell-quote-escaped forms (single-quote, double-quote, PowerShell backtick)
 * with ****. Also redacts any `Authorization` header value (Bearer/Basic) and
 * GitHub-shaped token literals (ghp_/ghs_/... and github_pat_...), which covers
 * a token minted inside a provider's deploy that this module never sees.
 *
 * Out of scope: fragment-aware redaction of wrapped/truncated console output.
 */

const MASK = '****';
/** Secrets shorter than this are not redacted by value (would mangle text). */
const MIN_SECRET_LENGTH = 4;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function forms(secret: string, usernames: string[]): string[] {
  const out = new Set<string>();
  const add = (v: string | undefined) => { if (v && v.length >= MIN_SECRET_LENGTH) out.add(v); };
  add(secret);
  add(encodeURIComponent(secret));
  add(secret.replace(/'/g, "'\\''"));
  add(secret.replace(/'/g, "''"));
  add(secret.replace(/"/g, '\\"'));
  add(secret.replace(/"/g, '""'));
  add(secret.replace(/["$`]/g, '`$&'));
  for (const u of usernames) {
    add(Buffer.from(`${u}:${secret}`).toString('base64'));
    add(Buffer.from(`:${secret}`).toString('base64'));
  }
  add(Buffer.from(`:${secret}`).toString('base64'));
  add(Buffer.from(secret).toString('base64'));
  return [...out];
}

export function redactKnownSecrets(
  text: string,
  secrets: Array<string | undefined | null>,
  usernames: string[] = [],
): string {
  let out = text;
  const all = new Set<string>();
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= MIN_SECRET_LENGTH) for (const f of forms(s, usernames)) all.add(f);
  }
  // Longest first so a raw value never leaves a partial of a longer form.
  for (const f of [...all].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(escapeRegExp(f), 'g'), MASK);
  }
  out = out.replace(/(\bAuthorization\s*[:=]\s*['"]?\s*)(Bearer|Basic|token)(\s+)[^\s'"]+/gi, `$1$2$3${MASK}`);
  out = out.replace(/\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/g, `$1$2${MASK}`);
  out = out.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, MASK);
  return out;
}
