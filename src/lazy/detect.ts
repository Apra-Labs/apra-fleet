/**
 * Secret detection for text flowing out to the model.
 *
 * Three layers, strongest first:
 *   1. Known formats (provider key prefixes, private key blocks, JWTs, ...)
 *   2. Context: `password = x`, `token: x`, `postgres://u:p@h`, "my password is x"
 *   3. Shape: long mixed-case high-entropy tokens (user-typed text only)
 *
 * Plus an explicit marker the user can always fall back to: `secret: VALUE`.
 *
 * False positives are cheap: the proxy restores every placeholder before a
 * tool runs, so an over-eager match only means the model sees a token name.
 * False negatives are what leak, so the patterns lean inclusive.
 */

export type DetectMode = 'user' | 'tool';

export interface Finding {
  start: number;
  end: number;
  kind: string;
}

export interface DetectOptions {
  /** Context patterns: `password = x`, URL userinfo, "my token is x". */
  context?: boolean;
  /** Shape-based detection of high-entropy tokens (user text only). */
  entropy?: boolean;
}

export const MIN_SECRET_LENGTH = 6;

interface Pattern {
  kind: string;
  re: RegExp;
  /** Capture group holding the secret; 0 = whole match. */
  group: number;
}

const FORMAT_PATTERNS: Pattern[] = [
  { kind: 'private_key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, group: 0 },
  { kind: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, group: 0 },
  { kind: 'openai_key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, group: 0 },
  { kind: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g, group: 0 },
  { kind: 'github_token', re: /\bgithub_pat_[A-Za-z0-9_]{40,}/g, group: 0 },
  { kind: 'gitlab_token', re: /\bglpat-[A-Za-z0-9_-]{20,}/g, group: 0 },
  { kind: 'aws_access_key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, group: 0 },
  { kind: 'aws_secret_key', re: /aws_secret_access_key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})/gi, group: 1 },
  { kind: 'slack_token', re: /\bxox[abprse]-[A-Za-z0-9-]{10,}/g, group: 0 },
  { kind: 'stripe_key', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, group: 0 },
  { kind: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}/g, group: 0 },
  { kind: 'npm_token', re: /\bnpm_[A-Za-z0-9]{36}\b/g, group: 0 },
  { kind: 'sendgrid_key', re: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, group: 0 },
  { kind: 'huggingface_token', re: /\bhf_[A-Za-z0-9]{30,}/g, group: 0 },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, group: 0 },
];

const NAME_HINT = '(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?key|credential)';

const CONTEXT_PATTERNS: Pattern[] = [
  // scheme://user:password@host
  { kind: 'url_password', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]+)@[^\s]/gi, group: 1 },
  // DB_PASSWORD=x, "apiKey": "x", token: x
  {
    kind: 'secret',
    re: new RegExp(`\\b[A-Za-z0-9_.-]*${NAME_HINT}[A-Za-z0-9_]*["']?\\s*[:=]\\s*(["']?)([^\\s"'\`,;()<>{}]{${MIN_SECRET_LENGTH},})\\1`, 'gi'),
    group: 2,
  },
  // Authorization: Bearer x
  { kind: 'bearer_token', re: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/g, group: 1 },
];

// "my password is x", "the token was x" -- natural language, user text only.
const PHRASE_PATTERN: Pattern = {
  kind: 'secret',
  re: new RegExp(`\\b(?:password|passcode|passphrase|pin|token|api key|secret|key)\\s+(?:is|was)\\s*:?\\s+["']?([^\\s"']{${MIN_SECRET_LENGTH},})`, 'gi'),
  group: 1,
};

// Explicit escape hatch -- accepted regardless of shape.
const EXPLICIT_PATTERN: Pattern = { kind: 'secret', re: /(?:^|\s)secret\s*[:=]\s*(\S+)/gi, group: 1 };

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_.$-]*$/;
const PLACEHOLDER_HINT_RE = /^(?:\{\{|\$\{?|<|%|\*{3,}|x{6,}$|\.{3})/i;
const COMMON_NON_SECRETS = new Set(['string', 'required', 'optional', 'undefined', 'boolean', 'number', 'redacted', 'placeholder', 'example', 'changeme', 'your-token-here']);

/** Reject values that are obviously code, placeholders or type names. */
function plausibleContextValue(value: string): boolean {
  if (value.length < MIN_SECRET_LENGTH) return false;
  if (PLACEHOLDER_HINT_RE.test(value)) return false;
  if (COMMON_NON_SECRETS.has(value.toLowerCase())) return false;
  // Bare identifiers (tokenValue, config.apiKey) are variable references,
  // unless they carry a digit -- hunter22 is a password, apiKey is not.
  if (IDENTIFIER_RE.test(value) && !/\d/.test(value)) return false;
  return true;
}

export function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const ENTROPY_TOKEN_RE = /[A-Za-z0-9_+/=.-]{24,200}/g;

function looksRandom(token: string): boolean {
  if (/^[0-9a-f]+$/i.test(token)) return false; // hashes, SHAs
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(token)) return false; // UUIDs
  // Paths, slugs and dotted names break into short pieces; keys do not.
  const longestRun = Math.max(...token.split(/[/._-]+/).map(part => part.length));
  if (longestRun < 16) return false;
  if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/\d/.test(token)) return false;
  return shannonEntropy(token) >= 4.0;
}

function collect(text: string, p: Pattern, out: Finding[], accept: (v: string) => boolean): void {
  // The `d` flag gives exact capture-group offsets.
  const re = new RegExp(p.re.source, p.re.flags.includes('d') ? p.re.flags : p.re.flags + 'd');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].length === 0) re.lastIndex++;
    const value = m[p.group];
    const span = m.indices?.[p.group];
    if (!value || !span || !accept(value)) continue;
    out.push({ start: span[0], end: span[1], kind: p.kind });
  }
}

/**
 * Find candidate secrets in `text`. Returned spans never overlap and are
 * sorted by position. `mode` gates the looser heuristics: phrase, explicit
 * and entropy detection only run on text the user typed.
 */
export function detectSecrets(text: string, mode: DetectMode, opts: DetectOptions = {}): Finding[] {
  const context = opts.context ?? true;
  const entropy = opts.entropy ?? true;
  const found: Finding[] = [];

  for (const p of FORMAT_PATTERNS) collect(text, p, found, v => v.length >= MIN_SECRET_LENGTH);
  if (mode === 'user') collect(text, EXPLICIT_PATTERN, found, v => !PLACEHOLDER_HINT_RE.test(v));
  if (context) {
    for (const p of CONTEXT_PATTERNS) collect(text, p, found, plausibleContextValue);
    if (mode === 'user') collect(text, PHRASE_PATTERN, found, plausibleContextValue);
  }
  if (entropy && mode === 'user') {
    const p: Pattern = { kind: 'secret', re: ENTROPY_TOKEN_RE, group: 0 };
    collect(text, p, found, looksRandom);
  }

  // Earliest first; on overlap keep the longer span (formats beat heuristics
  // because they were pushed first and ties keep the first entry).
  found.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const result: Finding[] = [];
  for (const f of found) {
    const last = result[result.length - 1];
    if (last && f.start < last.end) {
      if (f.end > last.end && f.start === last.start) result[result.length - 1] = f;
      continue;
    }
    result.push(f);
  }
  return result;
}
