// apra-fleet-x8r.7 -- shared test helper for `createDashboard({ listAllBeads })`
// fixtures.
//
// WHY THIS EXISTS: `dashboard.mjs`'s production default for `listAllBeads`
// (`bdListAllBeads()`, in backlog.mjs) always maps every raw `bd list --json`
// row through `normalizeBead()` before handing it to callers. A test that
// hand-builds a `listAllBeads: async () => [...]` fixture with fields
// `normalizeBead()` does not preserve (or normalizes away) is asserting on a
// shape production can never actually emit -- exactly what made the
// apra-fleet-x8r.4 goalMax regression (normalizeBead() silently dropping
// `priority`, so below-goal filtering never actually ran on the dashboard)
// invisible: the test injected `{ id, status, priority, parentId }` objects
// directly, bypassing normalizeBead() entirely, so it kept passing even
// though the real production path stripped `priority` before
// computeSprintProgress() ever saw it.
//
// Route every `createDashboard({ listAllBeads })` fixture through
// `normalizedBeadFixture()` (single bead) / `normalizedBeadFixtures()` (array)
// below instead of hand-building objects, so a fixture can never assert on a
// field the production path strips.
import { normalizeBead } from '../../src/supervisor/backlog.mjs';

/**
 * Build one dashboard bead fixture the way production actually would: pass a
 * raw-row-shaped object through the real `normalizeBead()`.
 * @param {object} raw - a raw `bd list --json`-row-shaped object, e.g.
 *   `{ id, title, issue_type, status, priority, dependencies }` (or the
 *   `parentId` shorthand `normalizeBead()` also accepts).
 * @returns {{ id: string, title: string, issueType: string, status: string, parentId: string|null, priority: number|null }}
 */
export function normalizedBeadFixture(raw) {
    return normalizeBead(raw);
}

/**
 * Array form of `normalizedBeadFixture()`, for building a whole
 * `listAllBeads: async () => [...]` fixture array in one call.
 * @param {Array<object>} rows
 * @returns {Array<{ id: string, title: string, issueType: string, status: string, parentId: string|null, priority: number|null }>}
 */
export function normalizedBeadFixtures(rows) {
    return (Array.isArray(rows) ? rows : []).map(normalizeBead);
}
