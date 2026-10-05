// Terminal-reason class table: one place that says what KIND of failure each
// engine terminalReason is. The reason universe is open
// (fleet-sprint/fatal-diagnostics.mjs resolveTerminalReason returns
// BEADS_SYNC_CONFLICT, else err.code || err.name || 'UNKNOWN_ABORT'), so any
// unlisted reason is classified 'engine-bug' -- unexpected, worth a human look.
// test/terminal-reasons.test.mjs enumerates fleet-sprint/errors.mjs exports so
// a new error class without an entry here fails loudly instead of landing in
// 'engine-bug' unnoticed.

const freeze = (list) => Object.freeze(new Set(list));

export const TERMINAL_REASON_CLASSES = Object.freeze({
    // Will recur on an identical relaunch until something changes.
    deterministic: freeze([
        'BEADS_SYNC_CONFLICT',
        'DOLT_DIVERGED',
        'GIT_DIVERGED',
        'DOLT_BINARY_UNAVAILABLE',
        'PRE_SPRINT_VALIDATION',
        'BEADS_IDENTITY',
        'RUNBOOK_PERMISSIONS',
    ]),
    // Environmental / timing; a relaunch may well succeed. SIGINT/SIGTERM
    // (written by the viewer) are operator/OS interruptions, not sprint
    // faults, so transient is their natural home.
    transient: freeze([
        'DOLT_SYNC_FAILED',
        'GIT_SYNC_FAILED',
        'POST_DISPATCH_SYNC_FAILED',
        'USAGE_LIMIT_WAIT_EXHAUSTED',
        'SPRINT_LOCK_HELD',
        'CONCURRENT_SYNC_BRACKET',
        'PLAN_REVIEW_DISPATCH_FAILED',
        'MEMBER_RESERVATION_RESUME_FAILED',
        'SIGINT',
        'SIGTERM',
    ]),
    // The engine misbehaved or died without a typed reason.
    'engine-bug': freeze(['UNKNOWN_ABORT']),
    // The sprint ran correctly and a quality/plan judgement said stop.
    judgement: freeze([
        'SPRINT_STALLED',
        'SPRINT_PLAN_REJECTED',
        'REVIEWER_CONTRACT_VIOLATION',
    ]),
});

/**
 * @param {unknown} reason
 * @returns {'deterministic'|'transient'|'engine-bug'|'judgement'}
 */
export function classifyTerminalReason(reason) {
    if (typeof reason !== 'string') return 'engine-bug';
    for (const [cls, set] of Object.entries(TERMINAL_REASON_CLASSES)) {
        if (set.has(reason)) return cls;
    }
    return 'engine-bug';
}

// The relaunch gate's subset (409 on a blind relaunch). NOT the whole
// deterministic class: it stays exactly {BEADS_SYNC_CONFLICT}.
export const RELAUNCH_GATE_REASONS = freeze(['BEADS_SYNC_CONFLICT']);
