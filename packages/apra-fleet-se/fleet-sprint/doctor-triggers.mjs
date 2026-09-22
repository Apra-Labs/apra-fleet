// sprint-doctor trigger layer (design:
// fleet-sprint/docs/escalate-to-llm-design.md section 1.2).
//
// Pure functions over `doctor-ledger.mjs` rows plus the handful of cycle
// counters the runner already keeps (staleCycles, high-water-mark progress,
// budget spend). No LLM call, no dispatching, no I/O, and no env/config
// reads -- every threshold is an explicit parameter with a documented
// default (DEFAULT_THRESHOLDS below), and nothing here names a specific
// target project, repo or bead prefix (this module ships to any target --
// see docs/generic-engine-boundary.md). Wiring this into the real Cycle
// Evaluation / mid-cycle fast-path call sites (H2/H4 in the design doc) is
// a separate, later task in this lane.

import { isInfraDispatchReason } from './errors.mjs';

// 'watchdog_timeout' is the CLIENT-side dispatch watchdog's own reason
// (dispatch-failure.mjs's `withDispatchWatchdog`) -- distinct from the
// server-classified `INFRA_DISPATCH_REASONS` set in errors.mjs, so T1/T2
// treat it as infra too without folding it into that set (which stays a
// server-classification taxonomy, not "what counts as infra for the
// trigger layer").
function isInfraOrWatchdogReason(reason) {
    return reason === 'watchdog_timeout' || isInfraDispatchReason(reason);
}

/**
 * Every threshold `evaluateTriggers()` consults, each independently
 * overridable by a caller's partial `thresholds` object (shallow-merged
 * over this default). Nothing in this module reads `process.env` or any
 * config file -- these defaults are the ONLY built-in values.
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
    // T1: consecutive infra-reason (or same-errorSignature) dispatch
    // failures on one bead(set), across cycles, with zero closures in
    // between, before a consult fires.
    t1AttemptCount: 3,
    // T2: consecutive infra-reason dispatch failures on one member, across
    // cycles, spanning at least 2 distinct beads, before a consult fires.
    t2FailureCount: 3,
    // T3: `staleCycles` reaching this limit interposes one consult before
    // the runner's own stalled-sprint abort. Documented default mirrors
    // runner.js's STALL_CYCLE_LIMIT at the time this was written; a caller
    // wiring T3 for real should pass the runner's own LIVE value here
    // rather than relying on the two staying in step by accident.
    t3StallCycleLimit: 2,
    // T4: spend-without-progress trigger, expressed as a fraction of the
    // sprint's total budget...
    t4SpendTriggerFraction: 0.15,
    // ...capped by this flat USD figure when a budget total IS set (the
    // effective trigger is `min(fraction * budget.total, this flat cap)`),
    // or used AS-IS (a flat figure) when no budget total is configured.
    t4SpendTriggerFlatUsd: 25,
});

/**
 * The effective T4 trigger amount in USD for a given budget total.
 * @param {number|null|undefined} budgetTotal
 * @param {{t4SpendTriggerFraction: number, t4SpendTriggerFlatUsd: number}} thresholds
 * @returns {number}
 */
function resolveSpendTrigger(budgetTotal, thresholds) {
    if (typeof budgetTotal === 'number' && Number.isFinite(budgetTotal) && budgetTotal > 0) {
        return Math.min(budgetTotal * thresholds.t4SpendTriggerFraction, thresholds.t4SpendTriggerFlatUsd);
    }
    return thresholds.t4SpendTriggerFlatUsd;
}

/** Canonical grouping key for a row's bead set -- order/duplicate independent. */
function beadSetKey(beadIds) {
    return [...new Set((beadIds || []).map(String))].sort().join(',');
}

// ---------------------------------------------------------------------------
// Debounce (shared by T1-T4; T5 uses its own always-single-shot rule below)
// ---------------------------------------------------------------------------
//
// "A (trigger, bead-or-member) pair that already produced a consult this
// sprint cannot re-fire unless the doctor's prescribed action was executed
// and a NEW failure occurred after it" (design doc section 1.2). Callers
// pass their consult history as `state.priorConsults`: an array of
// `{ trigger, key, actionExecuted, firedAt }` records this module never
// mutates -- appending to that history after a consult is the caller's job
// (the runner's own consult ledger), not this pure evaluator's.

function isDebounced(trigger, key, priorConsults, latestEvidenceTimestamp) {
    const matches = priorConsults.filter((c) => c.trigger === trigger && c.key === key);
    if (matches.length === 0) return false;
    const last = matches[matches.length - 1];
    if (!last.actionExecuted) return true; // no remedy attempted yet -- stay suppressed
    // A remedy WAS executed: re-arm only if there is evidence of a failure
    // strictly after it fired.
    return !(typeof latestEvidenceTimestamp === 'number' && latestEvidenceTimestamp > last.firedAt);
}

// ---------------------------------------------------------------------------
// T1 -- same bead(set), consecutive infra/same-signature failures, no closure
// ---------------------------------------------------------------------------

function trailingFailureStreak(rows) {
    // `rows` is one group's ledger rows in the CALLER'S given (chronological)
    // order. Walks backward from the most recent row, collecting consecutive
    // `ok: false` rows; an `ok: true` row (a closure) stops the walk, so the
    // streak returned never straddles a closure.
    const streak = [];
    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i];
        if (row.ok) break;
        streak.unshift(row);
    }
    return streak;
}

function evaluateT1(ledgerRows, thresholds, priorConsults) {
    const groups = new Map();
    for (const row of ledgerRows) {
        if (!row.beadIds || row.beadIds.length === 0) continue;
        const key = beadSetKey(row.beadIds);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }

    const results = [];
    for (const [key, rows] of groups) {
        const streak = trailingFailureStreak(rows);
        if (streak.length < thresholds.t1AttemptCount) continue;
        const window = streak.slice(-thresholds.t1AttemptCount);

        const allInfra = window.every((r) => isInfraOrWatchdogReason(r.reason));
        const signatures = new Set(window.map((r) => r.errorSignature).filter(Boolean));
        const sameSignature = signatures.size === 1;
        // A bead failing repeatedly with DIFFERENT substantive errors is the
        // develop/review loop working as intended, not a stall -- do not fire.
        if (!allInfra && !sameSignature) continue;

        const debounceKey = `bead:${key}`;
        const latestTs = window[window.length - 1].timestamp;
        if (isDebounced('T1', debounceKey, priorConsults, latestTs)) continue;

        results.push({
            trigger: 'T1',
            scope: 'bead',
            beadIds: [...window[window.length - 1].beadIds],
            member: undefined,
            evidenceRows: window,
            summary: `Bead(s) [${key}] accumulated ${window.length} consecutive infra-reason dispatch failures with zero closures in between.`,
        });
    }
    return results;
}

// ---------------------------------------------------------------------------
// T2 -- same member, consecutive infra failures across >= 2 distinct beads
// ---------------------------------------------------------------------------

function evaluateT2(ledgerRows, thresholds, priorConsults) {
    const byMember = new Map();
    for (const row of ledgerRows) {
        if (!row.member) continue;
        if (!byMember.has(row.member)) byMember.set(row.member, []);
        byMember.get(row.member).push(row);
    }

    const results = [];
    for (const [member, rows] of byMember) {
        // Same trailing-streak-since-closure shape as T1, but T2 has no
        // same-errorSignature alternative: a non-infra failure breaks the
        // streak outright (it is not evidence the MEMBER is unwell).
        const streak = [];
        for (let i = rows.length - 1; i >= 0; i -= 1) {
            const row = rows[i];
            if (row.ok) break;
            if (!isInfraOrWatchdogReason(row.reason)) break;
            streak.unshift(row);
        }
        if (streak.length < thresholds.t2FailureCount) continue;
        const window = streak.slice(-thresholds.t2FailureCount);

        const distinctBeadIds = new Set(window.flatMap((r) => r.beadIds || []));
        // Bead-diversity requirement is mandatory: a single hard bead must
        // not be able to impersonate a sick member.
        if (distinctBeadIds.size < 2) continue;

        const debounceKey = `member:${member}`;
        const latestTs = window[window.length - 1].timestamp;
        if (isDebounced('T2', debounceKey, priorConsults, latestTs)) continue;

        results.push({
            trigger: 'T2',
            scope: 'member',
            beadIds: [...distinctBeadIds],
            member,
            evidenceRows: window,
            summary: `Member '${member}' accumulated ${window.length} consecutive infra-reason failures across ${distinctBeadIds.size} distinct beads.`,
        });
    }
    return results;
}

// ---------------------------------------------------------------------------
// T3 -- cycle stagnation
// ---------------------------------------------------------------------------

function evaluateT3(state, thresholds, priorConsults) {
    const staleCycles = state.staleCycles || 0;
    if (staleCycles < thresholds.t3StallCycleLimit) return [];

    const debounceKey = 'sprint';
    const latestTs = typeof state.now === 'number' ? state.now : Date.now();
    if (isDebounced('T3', debounceKey, priorConsults, latestTs)) return [];

    return [{
        trigger: 'T3',
        scope: 'sprint',
        beadIds: [],
        member: undefined,
        evidenceRows: [],
        summary: `Cycle stagnation: staleCycles (${staleCycles}) reached the stall limit (${thresholds.t3StallCycleLimit}).`,
    }];
}

// ---------------------------------------------------------------------------
// T4 -- spend-without-progress
// ---------------------------------------------------------------------------

function evaluateT4(state, thresholds, priorConsults) {
    const budgetTotal = state.budget && typeof state.budget.total === 'number' ? state.budget.total : null;
    const spentSinceHighWaterMark = typeof state.spentSinceHighWaterMark === 'number' ? state.spentSinceHighWaterMark : 0;
    const trigger = resolveSpendTrigger(budgetTotal, thresholds);
    if (spentSinceHighWaterMark < trigger) return [];

    const debounceKey = 'sprint';
    const latestTs = typeof state.now === 'number' ? state.now : Date.now();
    if (isDebounced('T4', debounceKey, priorConsults, latestTs)) return [];

    return [{
        trigger: 'T4',
        scope: 'sprint',
        beadIds: [],
        member: undefined,
        evidenceRows: [],
        summary: `Spend without progress: $${spentSinceHighWaterMark.toFixed(2)} spent since the last new high-water mark exceeds the $${trigger.toFixed(2)} trigger.`,
    }];
}

// ---------------------------------------------------------------------------
// T5 -- unforeseen red state (event-driven, single-shot per event, forever)
// ---------------------------------------------------------------------------

function evaluateT5(state, _thresholds, priorConsults) {
    const events = state.redStateEvents || [];
    const results = [];
    for (const event of events) {
        const debounceKey = `event:${event.eventId}`;
        // Deliberately NOT the T1-T4 re-arm rule: the same one-off red-state
        // event cannot recur (it is identified by its own unique eventId),
        // so once consulted it stays consulted for the rest of the sprint.
        const alreadyConsulted = priorConsults.some((c) => c.trigger === 'T5' && c.key === debounceKey);
        if (alreadyConsulted) continue;
        results.push({
            trigger: 'T5',
            scope: event.scope || 'sprint',
            beadIds: event.beadIds || [],
            member: event.member,
            evidenceRows: event.evidenceRows || [],
            summary: event.summary || `Unforeseen red state raised by the caller (event ${event.eventId}).`,
        });
    }
    return results;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Evaluates all five triggers over the given state snapshot and returns zero
 * or more pending-consult descriptors: `{ trigger, scope, beadIds, member,
 * evidenceRows, summary }`.
 *
 * @param {{
 *   ledgerRows?: object[],              // SprintHealthLedger.rows() -- see doctor-ledger.mjs
 *   staleCycles?: number,
 *   isNewHighWaterMark?: boolean,        // did THIS cycle set a new high-water mark?
 *   budget?: { total?: number|null, spent?: number },
 *   spentSinceHighWaterMark?: number,
 *   redStateEvents?: Array<{ eventId: string, scope?: string, beadIds?: string[], member?: string, evidenceRows?: object[], summary?: string }>,
 *   priorConsults?: Array<{ trigger: string, key: string, actionExecuted: boolean, firedAt: number }>,
 *   now?: number,                        // logical clock for T3/T4/T5 debounce evidence; defaults to Date.now()
 * }} [state]
 * @param {Partial<typeof DEFAULT_THRESHOLDS>} [thresholds]
 * @returns {Array<{ trigger: string, scope: 'bead'|'member'|'sprint', beadIds: string[], member?: string, evidenceRows: object[], summary: string }>}
 */
export function evaluateTriggers(state = {}, thresholds = DEFAULT_THRESHOLDS) {
    const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
    const ledgerRows = state.ledgerRows || [];
    const priorConsults = state.priorConsults || [];
    const isNewHighWaterMark = !!state.isNewHighWaterMark;

    // No trigger except T1 may fire in a cycle whose progress score set a
    // new high-water mark -- a slow-but-progressing sprint is left alone.
    const results = [...evaluateT1(ledgerRows, t, priorConsults)];
    if (!isNewHighWaterMark) {
        results.push(...evaluateT2(ledgerRows, t, priorConsults));
        results.push(...evaluateT3(state, t, priorConsults));
        results.push(...evaluateT4(state, t, priorConsults));
        results.push(...evaluateT5(state, t, priorConsults));
    }
    return results;
}
