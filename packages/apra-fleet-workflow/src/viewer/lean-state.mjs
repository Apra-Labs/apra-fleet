// apra-fleet-eft.27.1: lean list-state transform for the dashboard's GET
// /state endpoint.
//
// Problem (apra-fleet-eft.27): a live 449-activity sprint measured a 116 MB
// GET /state payload per poll (85 MB of it pure duplication -- the same bead
// descriptions and command outputs embedded again and again by every `bd`
// command activity). Parsing + rendering that on the main thread produced a
// 49634 ms long task and made the dashboard effectively unusable.
//
// This module is a pure, dependency-free transform: it never touches the
// live `state` object the viewer mutates in place (src/viewer/index.mjs),
// nor the full-fidelity snapshots persisted to the configured
// state-snapshot directory and running/<runId>.json (those stay complete,
// unchanged, for audit/resume/History-view purposes) -- it only shapes what
// GET /state sends over the wire for the LIVE polling view.
//
// Two independent passes, both fully generic (no extension-specific
// field/namespace knowledge, so this stays workflow-agnostic per the parent
// bug's fix direction):
//
//   1. leanifyState(): walks state.tree and state.extensions and
//      (a) merges known "heavy" fields (description/output/error/input/
//      transcript/stdout/stderr -- the exact fields the bug's payload
//      anatomy pointed at) into a single short `summary` field, and
//      (b) caps every OTHER remaining string (msg, label, command, ...) at
//      a hard length regardless of field name, as a generic safety net.
//      Descriptions and agent transcripts are therefore never embedded in
//      list state -- only short summaries survive.
//   2. dedupeStrings(): a second, independent pass that replaces any string
//      value repeated 2+ times anywhere in the (already-leaned) payload with
//      a small `{ $ref: <index> }` marker into a shared `_strings` table
//      sent once, so remaining repeats (e.g. the same short label/member/
//      title appearing on many activities) are never sent twice. Fully
//      reversible via resolveStringRefs() -- the client-side counterpart
//      embedded into the served page (src/viewer/index.mjs HTML_TEMPLATE).

export const DEFAULT_SUMMARY_MAX_CHARS = 200;
export const DEFAULT_MAX_INLINE_STRING_CHARS = 400;
export const DEFAULT_DEDUP_MIN_LENGTH = 24;

// The exact fields the bug's payload anatomy identified as the source of
// duplication: full bead descriptions and full `bd`/agent command
// input/output/error text. Checked in this priority order when more than
// one is present on the same object (e.g. a failed activity carrying both
// `error` and `output`) -- the most diagnostically useful one wins the
// single `summary` field.
export const HEAVY_FIELD_NAMES = ['error', 'output', 'input', 'description', 'transcript', 'stdout', 'stderr'];

/** Truncates a string to `maxChars`, appending an ellipsis marker when cut. */
export function truncate(str, maxChars) {
    if (typeof str !== 'string') return str;
    if (str.length <= maxChars) return str;
    return str.slice(0, maxChars) + '...';
}

// Merges any HEAVY_FIELD_NAMES present on a plain object into a single
// short `summary` field and deletes the originals. Non-object input, and
// objects with none of these fields, pass through unchanged (a fresh
// shallow copy is only made when there's actually something to remove, so
// this stays cheap on the common case).
//
// apra-fleet-eft.38 (reopened): a `command` activity's output/error already
// carries <field>Truncated + <field>ByteLength markers by the time it gets
// here (command-output-cap.mjs capped it BEFORE storage, at activity:end --
// see src/viewer/index.mjs). Every OTHER activity type (most notably `agent`,
// whose full LLM response text is never capped at storage time, only here at
// the wire-shaping stage) had no such markers, so the dashboard's 'more...'
// control had nothing to key off of and never rendered for them. This now
// stamps the same <field>Truncated/<field>ByteLength pair onto ANY heavy
// field this function strips down to `summary`, whenever that field's full
// text does not survive intact inline (either it's a secondary heavy field --
// e.g. `output` when `error` already claimed the one `summary` slot -- that
// gets dropped entirely, or it's the summary source itself but longer than
// the summary cap). GET /activities/:id/output (src/viewer/index.mjs) falls
// back to the live in-memory state.tree for any id not already in
// command-output-cap.mjs's own store, so these markers are always backed by
// a real fetchable full text. Markers a field already carries (the `command`
// case above) are left untouched, never overwritten with a lesser byte count.
function summarizeHeavyFields(obj, maxChars) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
    const present = HEAVY_FIELD_NAMES.filter((key) =>
        Object.prototype.hasOwnProperty.call(obj, key) && typeof obj[key] === 'string' && obj[key].length > 0
    );
    if (present.length === 0) return obj;

    const out = { ...obj };
    const summaryKey = present[0];
    const heavyValue = out[summaryKey];

    for (const key of present) {
        const full = out[key];
        const survivesIntactAsSummary = key === summaryKey && full.length <= maxChars;
        const truncatedKey = `${key}Truncated`;
        const byteLengthKey = `${key}ByteLength`;
        if (!survivesIntactAsSummary && !Object.prototype.hasOwnProperty.call(out, truncatedKey)) {
            out[truncatedKey] = true;
            out[byteLengthKey] = Buffer.byteLength(full, 'utf8');
        }
        delete out[key];
    }

    if (!Object.prototype.hasOwnProperty.call(out, 'summary')) {
        out.summary = truncate(heavyValue, maxChars);
    }
    return out;
}

function leanifyDeep(value, opts) {
    if (Array.isArray(value)) return value.map((v) => leanifyDeep(v, opts));
    if (value && typeof value === 'object') {
        const summarized = summarizeHeavyFields(value, opts.summaryMaxChars);
        const out = {};
        for (const [k, v] of Object.entries(summarized)) {
            out[k] = leanifyDeep(v, opts);
        }
        return out;
    }
    // Generic safety net: ANY remaining string, under ANY field name
    // (log messages, labels, commands, future extension fields we don't
    // yet know the name of), is capped -- list state must never embed an
    // unbounded blob regardless of what it's called.
    if (typeof value === 'string') return truncate(value, opts.maxInlineStringChars);
    return value;
}

/**
 * Returns a new state object whose `tree` and `extensions` have been
 * stripped of heavy/unbounded string content (see module doc). Every other
 * top-level field (status, stats, runId, ...) is passed through
 * unchanged -- those are already small and fixed-shape.
 *
 * @param {object} state
 * @param {object} [opts]
 * @param {number} [opts.summaryMaxChars]
 * @param {number} [opts.maxInlineStringChars]
 */
export function leanifyState(state, opts = {}) {
    const summaryMaxChars = opts.summaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS;
    const maxInlineStringChars = opts.maxInlineStringChars ?? DEFAULT_MAX_INLINE_STRING_CHARS;
    const walkOpts = { summaryMaxChars, maxInlineStringChars };
    return {
        ...state,
        tree: leanifyDeep(state.tree ?? [], walkOpts),
        extensions: leanifyDeep(state.extensions ?? {}, walkOpts)
    };
}

/**
 * Replaces every string value that occurs 2+ times anywhere within `value`
 * (arrays/objects walked recursively) with a `{ $ref: <index> }` marker into
 * a shared table of unique strings, sent once. Strings shorter than
 * `minLength` are left inline (not worth a reference indirection). Returns
 * `{ value, table }`; `table[$ref]` recovers the original string. Pure and
 * side-effect-free -- safe to call on any JSON-compatible value.
 *
 * @param {any} value
 * @param {object} [opts]
 * @param {number} [opts.minLength]
 */
export function dedupeStrings(value, opts = {}) {
    const minLength = opts.minLength ?? DEFAULT_DEDUP_MIN_LENGTH;

    const counts = new Map();
    (function count(v) {
        if (Array.isArray(v)) { v.forEach(count); return; }
        if (v && typeof v === 'object') { Object.values(v).forEach(count); return; }
        if (typeof v === 'string' && v.length >= minLength) {
            counts.set(v, (counts.get(v) || 0) + 1);
        }
    })(value);

    const table = [];
    const indexOf = new Map();
    function refFor(str) {
        if (indexOf.has(str)) return indexOf.get(str);
        const idx = table.length;
        table.push(str);
        indexOf.set(str, idx);
        return idx;
    }

    function replace(v) {
        if (Array.isArray(v)) return v.map(replace);
        if (v && typeof v === 'object') {
            const out = {};
            for (const [k, val] of Object.entries(v)) out[k] = replace(val);
            return out;
        }
        if (typeof v === 'string' && v.length >= minLength && (counts.get(v) || 0) >= 2) {
            return { $ref: refFor(v) };
        }
        return v;
    }

    return { value: replace(value), table };
}

/**
 * Inverse of dedupeStrings(): walks `value`, replacing every
 * `{ $ref: <index> }` marker with `table[<index>]`. A plain object/array
 * containing no such markers (e.g. a frozen History-view state that never
 * went through dedupeStrings()) round-trips unchanged, so this is always
 * safe to apply defensively. This exact source is embedded verbatim into
 * the served page's client-side <script> (via .toString(), the same
 * pattern html-utils.mjs's escapeHtml() uses) so the browser can undo the
 * same transform.
 *
 * @param {any} value
 * @param {Array<string>} table
 */
export function resolveStringRefs(value, table) {
    if (Array.isArray(value)) return value.map((v) => resolveStringRefs(v, table));
    if (value && typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length === 1 && keys[0] === '$ref' && typeof value.$ref === 'number') {
            return table[value.$ref];
        }
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = resolveStringRefs(v, table);
        return out;
    }
    return value;
}

/**
 * Convenience one-shot: leanify then dedupe, returning a single
 * JSON.stringify-ready object (the shared string table is embedded under
 * `_strings`). This is what GET /state serves.
 *
 * @param {object} state
 * @param {object} [opts] - forwarded to leanifyState()/dedupeStrings().
 */
export function buildListStatePayload(state, opts = {}) {
    const leaned = leanifyState(state, opts);
    const { value, table } = dedupeStrings(leaned, opts);
    return { ...value, _strings: table };
}
