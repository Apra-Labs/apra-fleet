// Self-vs-foreign classification for the reservation ledger entries that
// GET /api/sprints returns (api.mjs listSprints()).
//
// apra-fleet-5co8.37: the deploy runbook's active-sprints gate used to STOP on
// ANY non-empty `sprints` array. A sprint that dispatches its own deployer is
// itself in that ledger, so the gate always fired on the deploying sprint's OWN
// reservation and no sprint could ever deploy its own work. The deployer is now
// told its dispatching sprint's identity and uses this module to keep only
// GENUINELY foreign reservations as a stop condition.
//
// Identity comparison is EXACT (=== on the sprintId string, === on an integer
// childPid). It is deliberately never a substring/prefix match: a sprintId
// embeds its issue roots, so `includes()` would make two unrelated sprints on
// overlapping issue roots look like each other.

/**
 * @typedef {object} SprintReservation
 * @property {string} [sprintId]  ledger reservation key (incarnation-unique)
 * @property {number|null} [childPid] pid of the sprint child process, if known
 */

/**
 * @typedef {object} SprintSelfIdentity
 * @property {string} [sprintId]  the dispatching sprint's own reservation key
 * @property {number} [childPid]  the dispatching sprint's own child pid
 */

/** @param {unknown} value @returns {string|null} */
function exactStringOrNull(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

/** @param {unknown} value @returns {number|null} */
function exactPidOrNull(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * True when `reservation` is the caller's OWN reservation.
 *
 * Matching requires at least one exact identifier match. With no usable
 * self-identity (neither a sprintId nor a childPid), NOTHING matches: an
 * unidentified caller must treat every reservation as foreign, which preserves
 * the old conservative stop-on-anything behavior.
 *
 * @param {SprintReservation} reservation
 * @param {SprintSelfIdentity} [identity]
 * @returns {boolean}
 */
export function isSelfReservation(reservation, identity = {}) {
    if (!reservation || typeof reservation !== 'object') return false;
    const selfSprintId = exactStringOrNull(identity?.sprintId);
    const selfChildPid = exactPidOrNull(identity?.childPid);
    if (selfSprintId === null && selfChildPid === null) return false;

    const resSprintId = exactStringOrNull(reservation.sprintId);
    if (selfSprintId !== null && resSprintId !== null && resSprintId === selfSprintId) return true;

    const resChildPid = exactPidOrNull(reservation.childPid);
    if (selfChildPid !== null && resChildPid !== null && resChildPid === selfChildPid) return true;

    return false;
}

/**
 * Splits a GET /api/sprints `sprints` array into the caller's own reservations
 * and genuinely foreign ones.
 *
 * `shouldStop` is the deploy gate's answer: stop only when at least one FOREIGN
 * reservation is live. A list containing only the caller's own reservation(s)
 * -- or an empty list -- lets the deploy proceed.
 *
 * @param {SprintReservation[]} sprints
 * @param {SprintSelfIdentity} [identity]
 * @returns {{ self: SprintReservation[], foreign: SprintReservation[], shouldStop: boolean }}
 */
export function classifyActiveSprints(sprints, identity = {}) {
    const list = Array.isArray(sprints) ? sprints : [];
    /** @type {SprintReservation[]} */ const self = [];
    /** @type {SprintReservation[]} */ const foreign = [];
    for (const reservation of list) {
        if (isSelfReservation(reservation, identity)) self.push(reservation);
        else foreign.push(reservation);
    }
    return { self, foreign, shouldStop: foreign.length > 0 };
}

/**
 * Convenience wrapper: just the foreign reservations.
 * @param {SprintReservation[]} sprints
 * @param {SprintSelfIdentity} [identity]
 * @returns {SprintReservation[]}
 */
export function selectForeignSprints(sprints, identity = {}) {
    return classifyActiveSprints(sprints, identity).foreign;
}
