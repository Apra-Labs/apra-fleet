// sprint-doctor consent-gated engine-flaw telemetry -- local-first
// sanitization, anonymous install id, fingerprint dedup (design:
// fleet-sprint/docs/escalate-to-llm-design.md section 4.4).
//
// apra-fleet-iiny.7.1: this module owns ONLY the privacy-critical primitives
// -- sanitizeReport(), the anonymous install id, and the dedup fingerprint --
// so they can be reviewed, tested and reasoned about in complete isolation
// from the consent-mode/upstreaming policy (never|ask|always) and the PR-
// body/dashboard surfacing that consume them. That policy layer is
// apra-fleet-iiny.7.2's job, added to THIS SAME FILE (mode handling belongs
// beside the sanitizer it gates, per that bead's own file list) plus the
// runner-side PR-body/state code that already exists.
//
// WHY NO SECOND REDACTOR. contracts.mjs already ships a secret-token
// redactor (wrapUntrustedBlock()/redactSecretTokens()) for the DIFFERENT
// problem of keeping `{{secret.NAME}}` references out of a PROMPT (it
// STRIPS THE BRACES but deliberately keeps "secret.NAME" readable, because
// that block stays inside the trusted engine/LLM boundary). This module's
// problem is the opposite: text that may leave the machine entirely, so a
// secret-shaped match must be REMOVED OUTRIGHT, not brace-stripped -- reusing
// redactSecretTokens() here would leave the token's NAME (and therefore a
// hint about which secret it is) in report text bound for an external
// tracker. sprint-report.mjs's sanitizePrText() is a different tool again (a
// SAFE_TEXT_RE character allowlist for shell/PR-body injection safety, not a
// privacy redactor) -- apra-fleet-iiny.7.2 reuses THAT one, at the point
// sanitized telemetry text is embedded into the PR body, exactly mirroring
// how publish-pr.mjs already treats finalVerdictResult.notes. Recorded here
// per this bead's "say which you did" requirement; see iiny.7.2 for the
// actual reuse call site.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { getFleetDataDir } from '@apralabs/apra-fleet-client/server-resolution';

// ---------------------------------------------------------------------------
// Secret-shaped patterns -- STRIPPED OUTRIGHT (replaced with nothing, never a
// placeholder): a placeholder still proves a secret WAS there and roughly
// where, which is more than an external tracker needs and more than a user
// consented to. Every pattern below is applied with the global flag so a
// report containing several secrets loses all of them.
// ---------------------------------------------------------------------------
const SECRET_PATTERNS = [
    // Templated secret references this engine's own prompts use
    // ({{secret.NAME}} / the deprecated {{secure.NAME}} spelling) -- see the
    // header comment above for why this is NOT the brace-only strip
    // contracts.mjs's redactSecretTokens() does.
    /\{\{\s*(?:secret|secure)\.[a-zA-Z0-9_-]{1,64}\s*\}\}/g,
    // OpenAI-style secret keys (sk-..., sk-proj-...).
    /\bsk-[A-Za-z0-9_-]{16,}\b/g,
    // GitHub personal-access / fine-grained / OAuth / App / refresh tokens
    // (ghp_, gho_, ghu_, ghs_, ghr_).
    /\bgh[opusr]_[A-Za-z0-9]{20,}\b/g,
    // AWS access key ids.
    /\bAKIA[0-9A-Z]{16}\b/g,
    // Authorization: Bearer <token> headers, however capitalized.
    /\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi,
    // "KEY=value" / "token: value" style assignments -- the general shape an
    // env dump or a copy-pasted credential line takes. Matches the whole
    // assignment (label included) so nothing about the value's neighborhood
    // survives either.
    /\b[\w.-]*(?:api[_-]?key|access[_-]?key|secret[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['"]?[^\s'",;]{4,}['"]?/gi,
];

function stripSecrets(text) {
    let out = text;
    for (const re of SECRET_PATTERNS) {
        out = out.replace(re, '');
    }
    return out;
}

// ---------------------------------------------------------------------------
// Paths, hosts, users, emails, IPs -- PLACEHOLDERED (the shape survives, the
// value never does). Home-directory paths get their own placeholder because
// they are the single most identity-revealing path shape (embeds the OS
// username); every other absolute path collapses to a generic work-folder
// placeholder.
// ---------------------------------------------------------------------------

// Whole-token absolute paths: POSIX (/Users/<name>/..., /home/<name>/...,
// or any other /...) and Windows (C:\Users\<name>\..., or any other C:\...).
// A SINGLE combined pattern, scanned in ONE pass (not one .replace() call
// per shape): running separate sequential passes -- home paths first, then
// "any other absolute path" -- lets the second pass re-match the placeholder
// the first pass just inserted (the placeholder's own '/...' suffix starts
// with '/', which is exactly what the generic absolute-path pattern looks
// for), corrupting '<home>/...' into '<home><work-folder>/...'. One pass
// with alternation never re-scans its own output.
const HOME_POSIX = '\\/(?:Users|home)\\/[^\\s]+';
const HOME_WIN = '[A-Za-z]:\\\\Users\\\\[^\\s]+';
const OTHER_WIN = '[A-Za-z]:\\\\[^\\s]+';
const OTHER_POSIX = '\\/[^\\s]+';
const PATH_RE = new RegExp(`(${HOME_POSIX})|(${HOME_WIN})|(${OTHER_WIN})|(${OTHER_POSIX})`, 'g');

function redactPaths(text) {
    return text.replace(PATH_RE, (_match, homePosix, homeWin) => {
        if (homePosix !== undefined) return '<home>/...';
        if (homeWin !== undefined) return '<home>\\...';
        // Whichever of the two "other absolute path" groups matched, its
        // separator tells us which placeholder spelling to use.
        return _match.startsWith('/') ? '<work-folder>/...' : '<work-folder>\\...';
    });
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redacts the CURRENT machine's own hostname/username wherever they appear
 * literally in `text`. Deliberately needle-based (replace the actual known
 * value) rather than pattern-based ("anything hostname-shaped") -- detecting
 * an arbitrary hostname in free text is undecidable in general, but this
 * process always knows its own hostname/username, which is exactly the
 * identifying data a log tail or error message is most likely to leak.
 * `hostname`/`username` are parameters (not read from `os` inline) so a
 * caller -- and this module's tests -- can inject a deterministic value
 * instead of depending on the real host's identity.
 */
function redactHostAndUser(text, { hostname, username }) {
    let out = text;
    if (hostname && hostname.length >= 3) {
        out = out.replace(new RegExp(escapeRegExp(hostname), 'gi'), '<host>');
    }
    if (username && username.length >= 3) {
        out = out.replace(new RegExp(`\\b${escapeRegExp(username)}\\b`, 'gi'), '<user>');
    }
    return out;
}

/**
 * The full generic redaction pass applied to every free-text field a
 * sanitized report carries: secrets stripped, then paths/host/user/email/IP
 * placeholdered. Order matters only in that secrets are removed FIRST, so a
 * secret value that happens to look path-shaped can never survive by being
 * placeholdered instead of stripped.
 * @param {string} text
 * @param {{hostname?: string, username?: string}} identity
 * @returns {string}
 */
function redactSensitiveText(text, identity) {
    if (typeof text !== 'string' || text.length === 0) return text;
    let out = stripSecrets(text);
    out = redactPaths(out);
    // Email/IP BEFORE host/user: an email's local part is often literally
    // the username (jdoe@example.com), and redacting the bare username
    // first would leave "<user>@example.com" behind instead of the single
    // "<email>" token the whole address should collapse to.
    out = out.replace(EMAIL_RE, '<email>');
    out = out.replace(IPV4_RE, '<ip>');
    out = redactHostAndUser(out, identity);
    // Secret-stripping and path/placeholder substitution both leave
    // occasional double-spaces or trailing whitespace behind; collapse them
    // so the result still reads as prose rather than looking corrupted.
    return out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
}

export { redactSensitiveText };

// ---------------------------------------------------------------------------
// Error-text truncation -- "the minimal reproducing lines", not a full log
// dump. Keeps the first N non-truncated lines and appends a short marker
// naming how much was cut, so a human reading the sanitized report knows
// truncation happened rather than assuming the excerpt was already complete.
// ---------------------------------------------------------------------------
const DEFAULT_MAX_ERROR_LINES = 20;

function truncateErrorText(text, maxLines) {
    if (typeof text !== 'string' || text.length === 0) return text;
    const lines = text.split(/\r?\n/);
    if (lines.length <= maxLines) return text;
    const kept = lines.slice(0, maxLines);
    const cut = lines.length - maxLines;
    return `${kept.join('\n')}\n... (${cut} more line${cut === 1 ? '' : 's'} truncated)`;
}

// ---------------------------------------------------------------------------
// sanitizeReport(): the load-bearing entry point. Runs FIRST, locally,
// always -- callers must never write a report to disk/artifact/PR body
// before it has been through this function.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} EngineFlawTelemetryInput
 * @property {string} [symptom]
 * @property {string} [suspectedComponent]
 * @property {string[]} [reproEvidence]
 * @property {string} [proposedBeadTitle]
 * @property {string} [errorText] - raw log/error excerpt; truncated then redacted.
 * @property {string} [codeSnippet] - excluded entirely unless opts.includeCodeSnippets.
 * @property {string} [repoName] - anonymized to '<target-repo>' unless opts.keepIdentifiers.
 * @property {string} [branch] - anonymized to '<sprint-branch>' unless opts.keepIdentifiers.
 * @property {string[]} [beadTitles] - each anonymized to '<bead-title>' unless opts.keepIdentifiers.
 */

/**
 * Sanitizes an engine-flaw telemetry report BEFORE it is ever written
 * anywhere. Pure function: no I/O, no randomness (aside from the caller
 * optionally supplying `hostname`/`username`, which default to the real
 * host's own values).
 *
 * @param {EngineFlawTelemetryInput} report
 * @param {{
 *   keepIdentifiers?: boolean,      // default false -- opt-in tier to KEEP repoName/branch/beadTitles verbatim (still redacted for secrets/paths/etc)
 *   includeCodeSnippets?: boolean,  // default false -- opt-in to keep codeSnippet (still redacted); otherwise the field is dropped entirely
 *   maxErrorLines?: number,         // default 20
 *   hostname?: string,              // default os.hostname()
 *   username?: string,              // default os.userInfo().username
 * }} [opts]
 * @returns {EngineFlawTelemetryInput} a NEW object; `report` is never mutated
 */
export function sanitizeReport(report, opts = {}) {
    const input = report && typeof report === 'object' ? report : {};
    const keepIdentifiers = opts.keepIdentifiers === true;
    const includeCodeSnippets = opts.includeCodeSnippets === true;
    const maxErrorLines = Number.isFinite(opts.maxErrorLines) && opts.maxErrorLines > 0
        ? Math.floor(opts.maxErrorLines)
        : DEFAULT_MAX_ERROR_LINES;
    const identity = {
        hostname: typeof opts.hostname === 'string' ? opts.hostname : safeHostname(),
        username: typeof opts.username === 'string' ? opts.username : safeUsername(),
    };

    // --- 1. Target-repo identifier anonymization (repo/branch/bead titles) ---
    // Two things happen when NOT keeping identifiers: the top-level field
    // itself becomes the fixed placeholder, AND every literal occurrence of
    // the ORIGINAL value is scrubbed out of every OTHER free-text field below
    // -- otherwise a repo/branch/bead name redacted from its own field could
    // still leak verbatim inside `symptom`/`errorText`/`reproEvidence`.
    const identifierSubstitutions = [];
    if (!keepIdentifiers) {
        if (typeof input.repoName === 'string' && input.repoName.length > 0) {
            identifierSubstitutions.push([input.repoName, '<target-repo>']);
        }
        if (typeof input.branch === 'string' && input.branch.length > 0) {
            identifierSubstitutions.push([input.branch, '<sprint-branch>']);
        }
        if (Array.isArray(input.beadTitles)) {
            for (const title of input.beadTitles) {
                if (typeof title === 'string' && title.length > 0) {
                    identifierSubstitutions.push([title, '<bead-title>']);
                }
            }
        }
    }
    const scrubIdentifiers = (text) => {
        if (typeof text !== 'string' || text.length === 0) return text;
        let out = text;
        for (const [value, placeholder] of identifierSubstitutions) {
            out = out.split(value).join(placeholder);
        }
        return out;
    };
    const scrubIdentifiersArray = (arr) => (Array.isArray(arr) ? arr.map(scrubIdentifiers) : arr);

    // --- 2. Build the working (identifier-scrubbed) field values ---
    const workingRepoName = keepIdentifiers
        ? input.repoName
        : (input.repoName !== undefined ? '<target-repo>' : undefined);
    const workingBranch = keepIdentifiers
        ? input.branch
        : (input.branch !== undefined ? '<sprint-branch>' : undefined);
    const workingBeadTitles = keepIdentifiers
        ? input.beadTitles
        : (Array.isArray(input.beadTitles) ? input.beadTitles.map(() => '<bead-title>') : undefined);

    let workingErrorText = scrubIdentifiers(input.errorText);
    workingErrorText = truncateErrorText(workingErrorText, maxErrorLines);

    const out = {};
    if (input.symptom !== undefined) out.symptom = scrubIdentifiers(input.symptom);
    if (input.suspectedComponent !== undefined) out.suspectedComponent = scrubIdentifiers(input.suspectedComponent);
    if (input.reproEvidence !== undefined) out.reproEvidence = scrubIdentifiersArray(input.reproEvidence);
    if (input.proposedBeadTitle !== undefined) out.proposedBeadTitle = scrubIdentifiers(input.proposedBeadTitle);
    if (input.errorText !== undefined) out.errorText = workingErrorText;
    if (input.repoName !== undefined) out.repoName = workingRepoName;
    if (input.branch !== undefined) out.branch = workingBranch;
    if (input.beadTitles !== undefined) out.beadTitles = workingBeadTitles;
    // codeSnippet: excluded entirely by default -- not blanked, not
    // placeholdered, simply ABSENT from the sanitized object, so a caller
    // that forgets to check a flag can never accidentally ship one.
    if (includeCodeSnippets && input.codeSnippet !== undefined) {
        out.codeSnippet = input.codeSnippet;
    }

    // --- 3. Generic redaction pass over every remaining free-text field ---
    if (out.symptom !== undefined) out.symptom = redactSensitiveText(out.symptom, identity);
    if (out.suspectedComponent !== undefined) out.suspectedComponent = redactSensitiveText(out.suspectedComponent, identity);
    if (out.reproEvidence !== undefined) out.reproEvidence = out.reproEvidence.map((line) => redactSensitiveText(line, identity));
    if (out.proposedBeadTitle !== undefined) out.proposedBeadTitle = redactSensitiveText(out.proposedBeadTitle, identity);
    if (out.errorText !== undefined) out.errorText = redactSensitiveText(out.errorText, identity);
    if (out.codeSnippet !== undefined) out.codeSnippet = redactSensitiveText(out.codeSnippet, identity);
    if (keepIdentifiers) {
        if (out.repoName !== undefined) out.repoName = redactSensitiveText(out.repoName, identity);
        if (out.branch !== undefined) out.branch = redactSensitiveText(out.branch, identity);
        if (out.beadTitles !== undefined) out.beadTitles = out.beadTitles.map((t) => redactSensitiveText(t, identity));
    }

    return out;
}

function safeHostname() {
    try {
        return os.hostname();
    } catch {
        return '';
    }
}

function safeUsername() {
    try {
        return os.userInfo().username;
    } catch {
        return '';
    }
}

// ---------------------------------------------------------------------------
// Anonymous install id -- a random UUID, persisted ONCE under the fleet data
// dir (the same base directory runner.js's resolveDoctorArtifactPath() uses,
// via the shared @apralabs/apra-fleet-client helper rather than this
// package depending on the root apra-fleet CLI's own TypeScript config
// module -- fleet-sprint ships to any target project and must stay
// dependency-light). NEVER derived from hostname/username/MAC: cross-report
// dedup needs stability, not identity.
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function installIdFilePath(env) {
    return path.join(getFleetDataDir(env), 'doctor', 'telemetry-install-id.json');
}

/**
 * Returns this install's stable anonymous telemetry id, creating and
 * persisting it on first call. Safe to call every run: a second call (same
 * data dir) always returns the SAME id, read back off disk rather than
 * regenerated.
 * @param {NodeJS.ProcessEnv} [env] - defaults to process.env; a test passes a
 *   fixture env with APRA_FLEET_DATA_DIR pointed at a throwaway directory so
 *   no run ever touches a developer's real ~/.apra-fleet.
 * @returns {string} a lowercase UUID v4 string
 */
export function getOrCreateInstallId(env = process.env) {
    const filePath = installIdFilePath(env);
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.installId === 'string' && UUID_RE.test(parsed.installId)) {
            return parsed.installId;
        }
    } catch {
        // Missing file, unreadable, or malformed JSON -- fall through and
        // (re)create it. A malformed file is deliberately overwritten rather
        // than left to poison every future call.
    }
    const installId = crypto.randomUUID();
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify({ installId }, null, 2)}\n`, 'utf8');
    } catch {
        // Best-effort persistence: a write failure (read-only fs, no
        // permission) must never fail the caller -- it just means the NEXT
        // call generates a different id instead of reusing this one.
    }
    return installId;
}

// ---------------------------------------------------------------------------
// Fingerprint -- a stable, compact dedup key derived from the ALREADY
// -normalized error signature (doctor-ledger.mjs's normalizeErrorSignature),
// not reimplemented here. Hashing (rather than using the signature text
// itself) keeps the fingerprint a fixed-shape opaque token regardless of how
// long or how punctuation-heavy the underlying signature is.
// ---------------------------------------------------------------------------

/**
 * @param {string} errorSignature - the normalized signature, e.g. from
 *   doctor-ledger.mjs's normalizeErrorSignature(reason, message).
 * @returns {string} a 16-hex-character (64-bit) fingerprint
 */
export function fingerprintForSignature(errorSignature) {
    const normalized = typeof errorSignature === 'string' ? errorSignature : String(errorSignature ?? '');
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Convenience composer: sanitizes `report`, then attaches this install's
 * anonymous id and the report's dedup fingerprint. Equivalent to calling
 * sanitizeReport()/getOrCreateInstallId()/fingerprintForSignature()
 * separately and merging the results -- provided because every real caller
 * needs all three together.
 * @param {EngineFlawTelemetryInput} report
 * @param {{errorSignature?: string, env?: NodeJS.ProcessEnv} & Parameters<typeof sanitizeReport>[1]} [options]
 * @returns {EngineFlawTelemetryInput & {installId: string, fingerprint: string}}
 */
export function buildTelemetryReport(report, options = {}) {
    const { errorSignature, env = process.env, ...sanitizeOpts } = options;
    const sanitized = sanitizeReport(report, sanitizeOpts);
    return {
        ...sanitized,
        installId: getOrCreateInstallId(env),
        fingerprint: fingerprintForSignature(errorSignature),
    };
}
