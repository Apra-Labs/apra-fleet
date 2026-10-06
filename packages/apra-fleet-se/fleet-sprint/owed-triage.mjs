// =============================================================================
// owed-triage.mjs -- pure collector for the triage a finished sprint still owes.
//
// A sprint can end with work nobody will pick up unless a human is told about
// it: follow-up beads created without lane metadata (no dispatcher lane will
// ever offer them), rollup beads whose children are all closed but which were
// never closed themselves, reviewer newTask findings that failed validation
// and were parked only in a parent bead's notes, and beads closed with a
// 'blocked:' reason. This module turns the sprint's scoped bead read plus its
// rejectedNewTasks audit trail into four explicit lists so the terminal record
// and the PR body can enumerate them (apra-fleet-5u79.1).
//
// PURE BY CONTRACT. No bd, no child_process, no fs: the caller does the reads
// and hands the arrays in, so this is unit-testable without a sandbox. A test
// asserts the import list stays empty of I/O modules.
//
// bd JSON SHAPE (verified against a real `bd list --status=closed --json` read
// on 2026-10-05): a closed bead carries `status: "closed"`, `closed_at` (ISO
// timestamp) and `close_reason` (free text). Parent linkage is a top-level
// `parent` id and/or a `dependencies[]` entry with `type: "parent-child"`
// whose `issue_id` is the child and `depends_on_id` the parent. `metadata` is
// an object (it may arrive as a JSON string from older bd builds, so both are
// accepted).
//
// GENERIC ENGINE CODE: every string this module emits is target-agnostic.
// ASCII only.
// =============================================================================

/** Statuses that mean "still owed work". Deferred is a deliberate park. */
const OPEN_STATUSES = new Set(['open', 'in_progress', 'blocked', 'hooked', 'pinned']);

function isOpen(bead) {
    return OPEN_STATUSES.has(String(bead?.status || '').toLowerCase());
}

function isClosed(bead) {
    return String(bead?.status || '').toLowerCase() === 'closed';
}

function metadataOf(bead) {
    const m = bead?.metadata;
    if (m && typeof m === 'object') return m;
    if (typeof m === 'string' && m.trim()) {
        try {
            const parsed = JSON.parse(m);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }
    return {};
}

function hasValue(v) {
    return v !== undefined && v !== null && String(v).trim() !== '';
}

/** The parent id a bead declares, via `parent` or a parent-child dependency. */
function parentIdOf(bead) {
    if (hasValue(bead?.parent)) return String(bead.parent);
    const deps = Array.isArray(bead?.dependencies) ? bead.dependencies : [];
    for (const d of deps) {
        if (d && d.type === 'parent-child' && d.issue_id === bead.id && hasValue(d.depends_on_id)) {
            return String(d.depends_on_id);
        }
    }
    return null;
}

/** Flatten to a single ASCII line so log and markdown rendering cannot break. */
function oneLine(text, max = 160) {
    const flat = String(text ?? '')
        .replace(/[^\x20-\x7E]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function toTime(v) {
    if (v === undefined || v === null || v === '') return null;
    const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
    return Number.isFinite(t) ? t : null;
}

/**
 * Computes the four owed-triage lists.
 *
 * @param {object} input
 * @param {object[]} [input.scopeBeads] Every bead in the sprint's scope, open
 *   AND closed (a bd list --json read).
 * @param {Array<{cycle?: *, reason?: string, raw?: *}>} [input.rejectedNewTasks]
 *   The run's rejected reviewer newTask audit trail.
 * @param {Iterable<string>} [input.closedAtStartIds] Ids that were already
 *   closed when the sprint started. When given it is AUTHORITATIVE: a blocked
 *   closure counts only if its id is not in this set, and sprintStartedAt is
 *   ignored. Prefer it -- it compares bead state, not clocks, so it cannot be
 *   skewed by clock drift between the orchestrator and the beads host.
 * @param {string|number|Date} [input.sprintStartedAt] Fallback when
 *   closedAtStartIds is not given: a blocked closure counts only if it closed
 *   at or after this instant.
 * @param {Record<string,string>} [input.strandedReasons] Optional per-id WHY
 *   for stranded rollups (for example a skipped integration test phase).
 * @param {string[]} [input.targetIds] The sprint's own target issue ids. They
 *   are never reported as unrouted or stranded: the sprint itself owns them
 *   and its publish step closes them, so listing them would make every
 *   finished sprint look like it owed triage.
 * @returns {{
 *   unroutedFollowUps: Array<{id: string, title: string, reason: string}>,
 *   strandedRollups: Array<{id: string, title: string, reason: string}>,
 *   rejectedFindings: Array<{id: null, title: string, reason: string, cycle: *}>,
 *   blockedClosures: Array<{id: string, title: string, reason: string}>,
 *   total: number,
 * }}
 */
export function computeOwedTriage({
    scopeBeads = [],
    rejectedNewTasks = [],
    sprintStartedAt,
    closedAtStartIds,
    strandedReasons = {},
    targetIds = [],
} = {}) {
    const beads = (Array.isArray(scopeBeads) ? scopeBeads : []).filter((b) => b && hasValue(b.id));
    // Dedupe by id (the caller may concatenate an open read and a closed read).
    const byId = new Map();
    for (const b of beads) byId.set(String(b.id), b);
    const all = [...byId.values()];

    const childrenOf = new Map();
    for (const b of all) {
        const p = parentIdOf(b);
        if (!p) continue;
        if (!childrenOf.has(p)) childrenOf.set(p, []);
        childrenOf.get(p).push(b);
    }

    const unroutedFollowUps = [];
    const strandedRollups = [];
    const blockedClosures = [];
    const closedBefore = closedAtStartIds && typeof closedAtStartIds[Symbol.iterator] === 'function'
        ? new Set([...closedAtStartIds].map(String))
        : null;
    const startedAt = closedBefore ? null : toTime(sprintStartedAt);
    const reasons = strandedReasons && typeof strandedReasons === 'object' ? strandedReasons : {};
    const targets = new Set((Array.isArray(targetIds) ? targetIds : []).map(String));

    for (const b of all) {
        const id = String(b.id);
        const title = oneLine(b.title) || '(untitled)';
        const kids = childrenOf.get(id) || [];

        const isTarget = targets.has(id);

        if (!isTarget && isOpen(b) && kids.length === 0 && String(b.issue_type || '').toLowerCase() === 'task') {
            const meta = metadataOf(b);
            const missing = [];
            if (!hasValue(meta.streak)) missing.push('streak');
            if (!hasValue(meta.model)) missing.push('model');
            if (missing.length > 0) {
                unroutedFollowUps.push({
                    id, title,
                    reason: `missing ${missing.join(' and ')} metadata; no dispatcher lane will pick it up`,
                });
            }
        }

        if (!isTarget && isOpen(b) && kids.length > 0 && kids.every(isClosed)) {
            const why = hasValue(reasons[id]) ? oneLine(reasons[id]) : null;
            strandedRollups.push({
                id, title,
                reason: why
                    ? `all ${kids.length} child(ren) closed but still open: ${why}`
                    : `all ${kids.length} child(ren) closed but still open`,
            });
        }

        if (isClosed(b)) {
            const closeReason = String(b.close_reason ?? '');
            if (/^\s*blocked:/i.test(closeReason)) {
                let inSprint;
                if (closedBefore) {
                    inSprint = !closedBefore.has(id);
                } else {
                    const closedAt = toTime(b.closed_at);
                    inSprint = startedAt === null || (closedAt !== null && closedAt >= startedAt);
                }
                if (inSprint) {
                    blockedClosures.push({ id, title, reason: oneLine(closeReason) });
                }
            }
        }
    }

    const rejectedFindings = (Array.isArray(rejectedNewTasks) ? rejectedNewTasks : [])
        .filter((r) => r && typeof r === 'object')
        .map((r) => {
            const raw = r.raw;
            let title = '';
            if (raw && typeof raw === 'object' && hasValue(raw.title)) title = oneLine(raw.title);
            else if (typeof raw === 'string') title = oneLine(raw);
            return {
                id: null,
                title: title || '(untitled finding)',
                reason: oneLine(r.reason) || 'rejected by newTask validation',
                cycle: r.cycle ?? null,
            };
        });

    return {
        unroutedFollowUps,
        strandedRollups,
        rejectedFindings,
        blockedClosures,
        total: unroutedFollowUps.length + strandedRollups.length + rejectedFindings.length + blockedClosures.length,
    };
}

const SECTIONS = [
    ['unroutedFollowUps', 'Unrouted follow-ups'],
    ['strandedRollups', 'Stranded rollups'],
    ['rejectedFindings', 'Rejected reviewer findings'],
    ['blockedClosures', 'Closed as blocked'],
];

/**
 * Renders a triage as plain-text ASCII lines for the run log and a PR body.
 * An empty (or missing) triage renders as [].
 *
 * @param {ReturnType<typeof computeOwedTriage>} triage
 * @returns {string[]}
 */
export function formatOwedTriageLines(triage) {
    if (!triage || !(Number(triage.total) > 0)) return [];
    const lines = [`owed triage: ${triage.total} item(s) need a human decision`];
    for (const [key, label] of SECTIONS) {
        const items = Array.isArray(triage[key]) ? triage[key] : [];
        if (items.length === 0) continue;
        lines.push(`${label} (${items.length}):`);
        for (const item of items) {
            const who = hasValue(item.id)
                ? item.id
                : (item.cycle !== undefined && item.cycle !== null ? `cycle ${item.cycle}` : 'finding');
            lines.push(`- ${who}: ${item.title} -- ${item.reason}`);
        }
    }
    return lines;
}
