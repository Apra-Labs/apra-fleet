// =============================================================================
// GET /api/members/:id/holds -- reservation + assignment holds
// (apra-fleet-g6ap.2.2)
// =============================================================================
//
// Consulted by the apra-fleet server's workflow-package holds consult
// (src/services/workflow-packages.ts's consultHolds(), src/tools/member-owner.ts)
// with the derived per-package credential (see supervisor/auth.mjs) so it can
// tell whether a member is safe to release/reassign.
//
// Two independent hold sources, both surfaced under one `reasons` array:
//   reservation -- the member appears in a live ledger reservation's
//     `members` array (ledger.list()'s existing read API; see ledger.mjs).
//   assignment  -- a non-finished role assignment naming this member. No
//     `role_assignments` table exists yet (that lands with the
//     sprint-definition sprint), so this seam always answers empty for now
//     -- deliberately NOT a migration, per the parent feature's scope.
//
// This route lives under /api/, so it is guarded by the SAME bearer check
// (raw token OR the derived 'se' credential) every other /api/ route uses --
// no separate guard wiring needed here.
// =============================================================================

import { sendJson } from '../supervisor/server.mjs';

/**
 * Reservation-sourced hold reasons for `memberId`: one `{kind: 'reservation',
 * sprintId}` entry per live ledger reservation whose `members` array names
 * this member.
 *
 * @param {{ list: () => Array<{ sprintId: string, members: string[] }> }} ledger
 * @param {string} memberId
 * @returns {Array<{ kind: 'reservation', sprintId: string }>}
 */
export function reservationHoldReasons(ledger, memberId) {
    const reasons = [];
    for (const entry of ledger.list()) {
        const members = Array.isArray(entry.members) ? entry.members : [];
        if (members.includes(memberId)) {
            reasons.push({ kind: 'reservation', sprintId: entry.sprintId });
        }
    }
    return reasons;
}

/**
 * Assignment-sourced hold reasons for `memberId`. Seam only: no
 * `role_assignments` table exists in the store yet, so this always returns
 * an empty array until the sprint-definition sprint adds one. `store` is
 * accepted (and ignored) now purely so the call site does not need to change
 * shape once that table lands.
 *
 * @param {unknown} _store
 * @param {string} _memberId
 * @returns {Array<{ kind: 'assignment', sprintId: string }>}
 */
export function assignmentHoldReasons(_store, _memberId) {
    return [];
}

/**
 * Register `GET /api/members/:id/holds`.
 *
 * @param {{ route: Function }} supervisor
 * @param {{ ledger: { list: () => Array<object> }, store?: unknown }} deps
 */
export function registerHoldsRoute(supervisor, { ledger, store } = {}) {
    if (!ledger || typeof ledger.list !== 'function') {
        throw new TypeError('registerHoldsRoute requires a ledger with a list() method');
    }
    supervisor.route('GET', '/api/members/:id/holds', async (req, res, ctx) => {
        const memberId = ctx?.params?.id;
        if (!memberId) {
            sendJson(res, 400, { error: 'missing member id in path' });
            return;
        }
        const reasons = [
            ...reservationHoldReasons(ledger, memberId),
            ...assignmentHoldReasons(store, memberId),
        ];
        sendJson(res, 200, { held: reasons.length > 0, reasons });
    });
}
