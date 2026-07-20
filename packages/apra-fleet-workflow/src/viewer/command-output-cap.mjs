// apra-fleet-eft.27.4: bounds how much of a command activity's captured
// stdout ever gets STORED into live sprint state (state.tree in
// src/viewer/index.mjs), not just how much GET /state serves per poll (that
// narrower job belongs to lean-state.mjs, applied only to the outgoing
// /state payload). Without this, the full text of every `command()`
// activity survives for the whole sprint in the in-memory `state` object --
// and therefore in the debounced running/<sprintId>.json write and the
// terminal sprint-logs/ snapshot too.
//
// Root cause (apra-fleet-eft.27, measured live): a 449-activity sprint's
// 188 MB /state payload was dominated by 130 command-activity events at
// ~1.3 MB each (164 MB) -- every one the full captured stdout of a repeated
// `bd list --all --limit 0 --json`. lean-state.mjs's closed siblings
// (eft.27.1/27.2/27.3) never capped this at the point of STORAGE, only at
// the point GET /state serialized it for the wire.
//
// Design: keep a short head+tail excerpt inline on the activity (enough to
// diagnose most failures at a glance) plus the true original byte count,
// and stash the full original text in an in-memory, per-activity-id store
// so it stays retrievable on demand (GET /activities/:id/output, wired in
// src/viewer/index.mjs) without ever being re-embedded in polled or
// persisted state. Deliberately command-agnostic: any chatty command is
// capped, not just `bd list`.

export const DEFAULT_HEAD_CHARS = 2000;
export const DEFAULT_TAIL_CHARS = 1000;

/**
 * Caps `text` to a head+tail excerpt when it exceeds headChars+tailChars.
 * Returns `{ value, truncated, byteLength }`: `value` is the (possibly
 * capped) excerpt to store inline, `truncated` is whether capping actually
 * happened, and `byteLength` is the ORIGINAL text's byte length (not the
 * excerpt's), so a caller can always show/report the true size even when
 * capped.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.headChars]
 * @param {number} [opts.tailChars]
 */
export function capOutputText(text, opts = {}) {
    const headChars = opts.headChars ?? DEFAULT_HEAD_CHARS;
    const tailChars = opts.tailChars ?? DEFAULT_TAIL_CHARS;
    if (typeof text !== 'string') return { value: text, truncated: false, byteLength: 0 };
    const byteLength = Buffer.byteLength(text, 'utf8');
    if (text.length <= headChars + tailChars) {
        return { value: text, truncated: false, byteLength };
    }
    const head = text.slice(0, headChars);
    const tail = tailChars > 0 ? text.slice(text.length - tailChars) : '';
    const omittedChars = text.length - headChars - tailChars;
    const value = `${head}\n\n... [${omittedChars} chars / ${byteLength} total bytes omitted -- full output available via GET /activities/:id/output] ...\n\n${tail}`;
    return { value, truncated: true, byteLength };
}

// In-memory store of full, un-capped command-activity output/error text,
// keyed by activity id (see capCommandActivityMeta()). Read by the
// GET /activities/:id/output route in src/viewer/index.mjs. Deliberately
// module-level rather than threaded through `state` -- this text must NEVER
// be serialized into state.tree / GET /state / persisted snapshots, which is
// the whole point of capping it there in the first place. One dashboard
// process serves exactly one live sprint, so an unbounded Map here is
// server-side memory only (never transmitted-per-poll or persisted-to-disk
// as a whole), garbage-collected with the process on exit.
const fullOutputById = new Map();

/** Returns `{ output?, error? }` for a capped activity id, or `null` if none was ever capped (or the id is unknown). */
export function getFullOutput(activityId) {
    return fullOutputById.has(activityId) ? fullOutputById.get(activityId) : null;
}

// Exposed for tests only.
export function _clearFullOutputStoreForTests() {
    fullOutputById.clear();
}

const CAPPED_FIELDS = ['output', 'error'];

/**
 * Returns a shallow copy of a `type: 'command'` activity:end meta object
 * with `output`/`error` capped to a head+tail excerpt (capOutputText()),
 * stashing the full original text in the module's fullOutputById store
 * (keyed by `meta.id`) whenever capping actually happens. Non-`command`
 * activities (e.g. `agent`) and activities with nothing over the cap pass
 * through completely unchanged (the identical `meta` reference is returned).
 *
 * The ORIGINAL `meta` object passed in is never mutated -- other
 * `activity:end` listeners on the same FleetWorkflow event (e.g.
 * journal.mjs's replay cache) depend on seeing the complete, uncapped text.
 *
 * @param {object} meta
 * @param {object} [opts] - forwarded to capOutputText() (headChars/tailChars).
 */
export function capCommandActivityMeta(meta, opts = {}) {
    if (!meta || meta.type !== 'command') return meta;
    let out = meta;
    let fullForId = null;
    for (const field of CAPPED_FIELDS) {
        const raw = meta[field];
        if (typeof raw !== 'string' || raw.length === 0) continue;
        const { value, truncated, byteLength } = capOutputText(raw, opts);
        if (!truncated) continue;
        if (out === meta) out = { ...meta };
        out[field] = value;
        out[`${field}Truncated`] = true;
        out[`${field}ByteLength`] = byteLength;
        if (!fullForId) fullForId = { ...(fullOutputById.get(meta.id) || {}) };
        fullForId[field] = raw;
    }
    if (fullForId) fullOutputById.set(meta.id, fullForId);
    return out;
}
