/**
 * Redact known credential values from free text before it is returned to a
 * caller or logged.
 *
 * Replaces every occurrence of each secret value in its raw form, URL-encoded
 * form, base64 of `user:secret` (for every username supplied), and every
 * shell-escaped form the OS command builders (src/os/*) write it in, with
 * ****. Those escaped forms are built with the SAME escapers the builders use
 * (src/utils/shell-escape.ts), never re-implemented here, so a form actually
 * sent to a member is always a form this module masks. Also redacts any `Authorization` header value (Bearer/Basic) and
 * GitHub-shaped token literals (ghp_/ghs_/... and github_pat_...), which covers
 * a token minted inside a provider's deploy that this module never sees.
 *
 * Out of scope: fragment-aware redaction of wrapped/truncated console output.
 */

import {
  escapeBatchMetachars,
  escapeDoubleQuoted,
  escapeForDoubleQuotes,
  escapePowerShellArgInner,
  escapeShellArgInner,
  escapeWindowsArg,
} from './shell-escape.js';

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
  // POSIX single quotes (escapeShellArg: httpGetStatusWithBearer, git-bash helper).
  add(escapeShellArgInner(secret));
  // POSIX double quotes (linux/macos gitCredentialHelperWrite, ghAuthLogin).
  add(escapeDoubleQuoted(secret));
  add(escapeForDoubleQuotes(secret, false));
  // PowerShell single quotes (windows httpGetStatusWithBearer) and double quotes.
  add(escapePowerShellArgInner(secret));
  add(escapeForDoubleQuotes(secret, true));
  // .bat helper content (windows / git-bash gitCredentialHelperWrite) and its
  // PowerShell / POSIX single-quoted carriers.
  add(escapeBatchMetachars(secret));
  add(escapePowerShellArgInner(escapeBatchMetachars(secret)));
  add(escapeShellArgInner(escapeBatchMetachars(secret)));
  // cmd.exe double quotes (windows ghAuthLogin) inside PowerShell single quotes.
  add(escapeWindowsArg(secret));
  add(escapePowerShellArgInner(escapeWindowsArg(secret)));
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

/** Text shapes of well-known token formats; deliberately specific, so ordinary script text does not match. */
const KNOWN_TOKEN_FORMATS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { label: 'GitLab token', re: /\bglpat-[A-Za-z0-9_-]{16,}/ },
  { label: 'API key (sk-)', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { label: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'Slack token', re: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/ },
  { label: 'Atlassian token', re: /\bATATT[A-Za-z0-9_=-]{20,}/ },
  { label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/ },
  { label: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
];

/**
 * The label of the first known token format found in `text`, or null. Best
 * effort only: a value of no recognisable shape is not caught. Returns the
 * label, never the match, so a caller can report it without echoing the value.
 */
export function knownTokenFormat(text: string): string | null {
  return KNOWN_TOKEN_FORMATS.find(({ re }) => re.test(text))?.label ?? null;
}
