// =============================================================================
// Beads identity: which .beads database a component is actually talking to.
//
// bd resolves its database by walking up from the cwd of whichever process
// runs it. fleet-sprint never runs bd itself -- every bd goes to a member and
// runs inside that member's workFolder -- so the ONLY way to know (and prove)
// which database a sprint will mutate is to ask each member `bd where`. The
// supervisor does run bd (backlog + scope-overlap reads), in its own cwd.
//
// This module is the shared, pure contract both sides use:
//   - the probe command strings (plain read-only bd/git; no env, no shell
//     specific text -- execute_command already cd's per member OS),
//   - parsing of their output into one { beadsDir, prefix, syncRemote,
//     repoRemote } record,
//   - comparison of two records. beadsDir is DISPLAYED, never compared: it is
//     a path on whichever box ran the probe. prefix, syncRemote and repoRemote
//     are the project identity; every field that resolved on both sides must
//     match (a field a probe could not resolve is reported, not compared).
//
// No I/O here: callers run the commands and hand the stdout in.
// =============================================================================

// The three probes. Order matters only for readability of logs.
export const BEADS_IDENTITY_PROBES = Object.freeze({
    where: 'bd where --json',
    syncRemote: 'bd config get sync.remote --json',
    repoRemote: 'git remote get-url origin',
});

export function buildIdentityProbeCommands() {
    return { ...BEADS_IDENTITY_PROBES };
}

// Fields that must agree between two identities. beadsDir is excluded on
// purpose (see header).
export const COMPARED_FIELDS = Object.freeze(['prefix', 'syncRemote', 'repoRemote']);

function firstJsonObject(text) {
    if (typeof text !== 'string') return null;
    const start = text.indexOf('{');
    if (start < 0) return null;
    try {
        return JSON.parse(text.slice(start));
    } catch {
        return null;
    }
}

// `bd where --json` -> { path, prefix, database_path, schema_version }.
// Plain `bd where` (no --json) prints the dir on line 1 and "  prefix: X" on
// line 2; accepted as a fallback so a member running an older bd still parses.
export function parseBdWhere(text) {
    const obj = firstJsonObject(text);
    if (obj && typeof obj.path === 'string' && obj.path.trim()) {
        return {
            beadsDir: obj.path.trim(),
            prefix: typeof obj.prefix === 'string' ? obj.prefix.trim() : '',
            databasePath: typeof obj.database_path === 'string' ? obj.database_path.trim() : '',
        };
    }
    if (typeof text !== 'string') return null;
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    const dir = lines[0];
    if (!/[\\/]\.beads$/.test(dir)) return null;
    let prefix = '';
    let databasePath = '';
    for (const l of lines.slice(1)) {
        const m = /^(prefix|database):\s*(.+)$/.exec(l);
        if (!m) continue;
        if (m[1] === 'prefix') prefix = m[2].trim();
        else databasePath = m[2].trim();
    }
    return { beadsDir: dir, prefix, databasePath };
}

// `bd config get sync.remote --json` -> { key, value, ... }; an unset key is
// exit 0 with value "". Plain output (no --json) is the raw value.
export function parseBdConfigValue(text) {
    const obj = firstJsonObject(text);
    if (obj && 'value' in obj) {
        return typeof obj.value === 'string' ? obj.value.trim() : String(obj.value ?? '').trim();
    }
    if (typeof text !== 'string') return '';
    return text.trim().split(/\r?\n/)[0].trim();
}

// Canonical form of a git remote (lower-cased) so `git+https://x/y.git`,
// `git@x:y.git` and `ssh://git@x/y` all compare equal when they name the
// same repository. Returns '' for empty input.
export function normalizeRemoteUrl(url) {
    if (typeof url !== 'string') return '';
    let u = url.trim();
    if (!u) return '';
    u = u.replace(/^git\+/, '');
    // scp-like: git@host:owner/repo(.git)
    const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(u);
    if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
        u = `${scp[1]}/${scp[2]}`;
    } else {
        u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
        u = u.replace(/^[^@/]+@/, '');
    }
    u = u.replace(/\/+$/, '').replace(/\.git$/, '');
    // Hosting providers treat owner/repo case-insensitively; fold the whole
    // thing so a differently-cased clone URL is not a false mismatch.
    return u.toLowerCase();
}

// Builds one identity record from the three probe outputs. Any probe that
// could not be parsed leaves its field '' -- an UNRESOLVED field. Strict
// compareIdentity (the default) treats '' against a non-empty expectation
// as a mismatch; the engine's precondition passes { skipUnresolved: true }
// so an unresolved field is reported (warned about) rather than compared.
export function parseBeadsIdentity({ where, syncRemote, repoRemote }) {
    const w = parseBdWhere(where);
    return {
        beadsDir: w ? w.beadsDir : '',
        prefix: w ? w.prefix : '',
        databasePath: w ? w.databasePath : '',
        syncRemote: parseBdConfigValue(syncRemote),
        repoRemote: typeof repoRemote === 'string' ? repoRemote.trim().split(/\r?\n/)[0].trim() : '',
    };
}

export function isCompleteIdentity(id) {
    return !!(id && id.beadsDir && id.prefix && id.syncRemote && id.repoRemote);
}

// Compares `actual` against `expected` on COMPARED_FIELDS. Remote URLs are
// compared in normalized form; prefix is compared exactly. Returns
// { ok, mismatches: [{ field, expected, actual }], unresolved: [{ field,
// expected, actual }] }.
//
// A field that is empty on EITHER side is "unresolved". By default (strict)
// it is compared like any other value, so '' against a non-empty
// expectation is a mismatch. With `{ skipUnresolved: true }` such a field is
// listed under `unresolved` instead and never counts against `ok` -- the
// caller decides how loudly to report it. A field that is non-empty on both
// sides and differs is ALWAYS a mismatch, whichever option is set.
export function compareIdentity(expected, actual, { skipUnresolved = false } = {}) {
    const mismatches = [];
    const unresolved = [];
    for (const field of COMPARED_FIELDS) {
        const e = expected ? expected[field] ?? '' : '';
        const a = actual ? actual[field] ?? '' : '';
        const eText = String(e).trim();
        const aText = String(a).trim();
        if (skipUnresolved && (!eText || !aText)) {
            unresolved.push({ field, expected: e, actual: a });
            continue;
        }
        const same = field === 'prefix'
            ? eText === aText
            : normalizeRemoteUrl(e) === normalizeRemoteUrl(a);
        if (!same) mismatches.push({ field, expected: e, actual: a });
    }
    return { ok: mismatches.length === 0, mismatches, unresolved };
}

// One-line human form, used by the supervisor header, the CLI banner and the
// runner log. Deliberately generic: no product paths.
export function formatBeadsIdentity(id, { label } = {}) {
    if (!id) return `${label ? label + ': ' : ''}beads: (unknown)`;
    const parts = [
        id.beadsDir || '(no .beads)',
        `prefix=${id.prefix || '?'}`,
        `remote=${id.syncRemote || '(unset)'}`,
    ];
    if (id.repoRemote && normalizeRemoteUrl(id.repoRemote) !== normalizeRemoteUrl(id.syncRemote)) {
        parts.push(`origin=${id.repoRemote}`);
    }
    return `${label ? label + ' ' : ''}beads: ${parts.join(' | ')}`;
}

// Serialised form passed from the supervisor to a sprint child
// (`--expect-beads <json>`). Only the compared fields plus beadsDir for
// display; parse is lenient so a hand-written value works too.
export function serializeExpectedIdentity(id) {
    return JSON.stringify({
        beadsDir: id.beadsDir || '',
        prefix: id.prefix || '',
        syncRemote: id.syncRemote || '',
        repoRemote: id.repoRemote || '',
    });
}

export function parseExpectedIdentity(text) {
    if (text && typeof text === 'object') return normaliseRecord(text);
    if (typeof text !== 'string' || !text.trim()) return null;
    let obj;
    try {
        obj = JSON.parse(text);
    } catch {
        return null;
    }
    return obj && typeof obj === 'object' ? normaliseRecord(obj) : null;
}

function normaliseRecord(obj) {
    const pick = (k) => (typeof obj[k] === 'string' ? obj[k].trim() : '');
    return {
        beadsDir: pick('beadsDir'),
        prefix: pick('prefix'),
        syncRemote: pick('syncRemote'),
        repoRemote: pick('repoRemote'),
    };
}
