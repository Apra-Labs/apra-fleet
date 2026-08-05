// =============================================================================
// apra-fleet-eft.70.2 -- full-DB beads fetch tripwire checker.
//
// Companion to dispatch-safety-guard.mjs (apra-fleet-eft.3.3), same shape:
// the checker logic lives here, exported and parameterizable over a plain
// array of { phase, command } entries, so it can be pointed at BOTH a
// synthetic fixture (proving the checker actually fails on a reintroduced
// full-DB-polling regression, per this task's own acceptance criteria) and
// the real phase-tagged command log a mock-sprint run produces (see
// test/helpers/mock-sprint-harness.mjs's `activityLog`, added alongside this
// file), without duplicating the detection logic in each test file.
//
// Background (apra-fleet-eft.70 / eft.70.1): runner.js's bdListScoped()
// helper funnels EVERY scoped beads query through a single shared full-list
// fetch, fetchAllBeadsShared() -- issuing exactly one literal command,
// `bd list --all --limit 0 --json`, then filtering/BFS-ing the result in
// memory for whatever scope the caller actually wants. That single full
// fetch is a DELIBERATE, documented trade-off (see fetchAllBeadsShared's own
// doc comment in runner.js) -- the invariant this guard protects is not
// "never fetch the whole DB" but:
//
//   1. that one full fetch must be coalesced: at most once per phase step
//      (a fresh `bd list --all --limit 0 --json` may legitimately run again
//      after a `phase()` transition or any beads-mutating command, but never
//      twice back-to-back within the SAME phase step -- see runner.js's
//      allBeadsSnapshot/invalidateAllBeadsCache wiring); and
//   2. no OTHER, differently-shaped unscoped full-list command (e.g. missing
//      `--json`, reordered flags, or a brand new ad hoc call site that
//      bypasses the shared cache) is ever issued -- only the single,
//      reviewed, canonical command text is allowed to match the "unscoped
//      full list" shape at all.
// =============================================================================

/** The single documented, cache-backed full-DB fetch command (runner.js's fetchAllBeadsShared()). */
export const FULL_DB_FETCH_CMD = 'bd list --all --limit 0 --json';

// Matches ANY "unscoped full list" shaped `bd list` invocation -- i.e. one
// that combines `--all` with `--limit 0` -- regardless of flag order or
// trailing flags, so a regression that reshapes fetchAllBeadsShared's
// command text (or a brand new call site with a similar but non-identical
// shape) is still caught by rule 2 above, not just an exact-string match.
const FULL_DB_SHAPE_RE = /^bd\s+list\b(?=.*(?:^|\s)--all(?:\s|$))(?=.*(?:^|\s)--limit\s+0(?:\s|$))/;

// Mirrors runner.js's own BD_READ_ONLY_RE (the `command`/`phase` wrapper at
// the top of runSprintCycle): a `bd` command matching this shape is treated
// as a read that can never change beads state, so it does NOT invalidate a
// cached full-DB snapshot. Any OTHER `bd` command (update/create/close/note/
// dep/dolt pull/etc -- an unrecognized subcommand is conservatively assumed
// to mutate) does invalidate it. Non-`bd` commands (git, node probes) never
// touch beads state and are ignored entirely.
const BD_READ_ONLY_RE = /^bd\s+(list|show|ready|config)\b/i;

/**
 * Given `entries` (an ordered array of { phase, command }, as produced by
 * mock-sprint-harness.mjs's `activityLog`), returns an array of
 * human-readable violation strings for:
 *   - any unscoped-full-list-shaped command whose exact text is not the
 *     single documented FULL_DB_FETCH_CMD (rule 2), and
 *   - any full-DB fetch issued while a PREVIOUS full-DB fetch's snapshot was
 *     still validly cached -- i.e. no `phase()` transition and no
 *     beads-mutating `bd` command occurred since the last full fetch (rule
 *     1: a coalescing/caching regression). This walks the log as a small
 *     state machine mirroring runner.js's own allBeadsSnapshot/
 *     invalidateAllBeadsCache wiring, rather than naively flagging every
 *     repeat within the same phase LABEL -- a second full fetch under the
 *     SAME phase title is legitimate (and expected) immediately after an
 *     intervening mutation (e.g. a reviewer-driven `bd update --status=open`
 *     reopen) invalidates the cache.
 * Returns an empty array when the log is fully compliant.
 */
export function checkFullDbFetchLog(entries) {
    const violations = [];
    let cacheValid = false;
    const NO_PHASE_YET = Symbol('no-phase-seen-yet');
    let lastPhase = NO_PHASE_YET;

    entries.forEach((entry, idx) => {
        const command = entry && entry.command;
        if (typeof command !== 'string') return;

        // A phase() transition invalidates the cache (runner.js's `phase`
        // wrapper calls invalidateAllBeadsCache() before every rawPhase()).
        if (lastPhase !== NO_PHASE_YET && entry.phase !== lastPhase) {
            cacheValid = false;
        }
        lastPhase = entry.phase;

        if (FULL_DB_SHAPE_RE.test(command)) {
            if (command !== FULL_DB_FETCH_CMD) {
                violations.push(
                    `entry ${idx} (phase ${JSON.stringify(entry.phase)}): unscoped full-DB-shaped fetch with unexpected text "${command}" ` +
                    `(expected the single documented "${FULL_DB_FETCH_CMD}")`
                );
            }
            if (cacheValid) {
                violations.push(
                    `duplicate full-DB fetch at entry ${idx} (phase ${JSON.stringify(entry.phase)}, command "${command}") -- ` +
                    `no phase transition or beads-mutating bd command occurred since the previous full fetch, so this snapshot ` +
                    `should still have been cached (regression to runner.js's allBeadsSnapshot coalescing)`
                );
            }
            cacheValid = true;
            return; // a full-list read itself never mutates beads
        }

        const trimmed = command.trim();
        if (/^bd\b/i.test(trimmed) && !BD_READ_ONLY_RE.test(trimmed)) {
            cacheValid = false;
        }
    });

    return violations;
}

/** Convenience: count of full-DB-shaped fetches (any text) across the whole log, for sanity assertions. */
export function countFullDbFetches(entries) {
    return entries.filter((e) => e && typeof e.command === 'string' && FULL_DB_SHAPE_RE.test(e.command)).length;
}
