// carry-over.mjs -- pure, no-I/O selection of which beads become new backlog
// items at the end of a sprint.
//
// implementation-plan.md Part 8 ("Carry-over: the precise algorithm") is the
// spec. Two amendments recorded there under "Decisions that changed during
// design review" replace it in two places, both encoded below:
//
//   1. Rule 3 ("attributable to this sprint") is narrowed to `created-after`
//      alone. The design doc originally OR'd three heuristics (created after
//      startedAt, within the sprint's scope, or titled `[carry-over]`) but
//      only ever showed a query implementing the first. That narrowing is
//      deliberate and settled -- the other two disjuncts are NOT
//      reintroduced here.
//   2. A `--max-carry-over` breach no longer means "publish nothing and fail
//      loudly" (the design doc's original wording). The settled behaviour is
//      the opposite: publish the top-N candidates by priority as `selected`
//      and report the remainder as `suppressed`, so a caller (`finalize`) can
//      file one summary item saying N more were suppressed. Stranding
//      everything in the local beads DB after a two-day sprint, where nobody
//      looks, is worse than a noisy board.
//
// This module performs no I/O of any kind -- no `bd` exec, no HTTP, no
// filesystem, no clock read (the "now" it needs, `startedAt`, is passed in
// by the caller) -- precisely so it can be tested exhaustively, which is why
// it was split out of `finalize` in the first place (implementation-plan.md
// Part B: "src/carry-over.mjs  selectCarryOver() - pure, no I/O").

import { BridgeError, BRIDGE_ERROR_CODES } from './errors.mjs';

/**
 * Bead statuses that are NOT closed -- the allow-list for rule 1. Anything
 * else (an actually-closed status, an unrecognized/misspelled status, or a
 * missing status) is excluded by construction: an unknown status is never
 * treated as "must be open".
 */
const OPEN_STATUSES = Object.freeze(new Set(['open', 'in_progress', 'blocked', 'deferred']));

/**
 * The literal marker the regression phase files onto a standalone bead's
 * title (fleet-bridge-design.md 8: "two mechanisms produce carry-over
 * today" -- 1, "Regression failures").
 */
const REGRESSION_MARKER = '[regression][carry-over]';

const DEFAULT_MAX_CARRY_OVER = 25;

/**
 * Normalizes a timestamp-ish value (epoch-ms number or an ISO-8601 string)
 * to epoch milliseconds, or `null` if it cannot be parsed. Never throws -- a
 * row with a malformed `created_at` is data for rule 3 to classify (as
 * "cannot show attributable"), not a reason to fail the whole selection.
 * @param {any} value
 * @returns {number|null}
 */
function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

/**
 * Classifies a bead that has already passed all three carry-over rules into
 * one of the three reasons.
 *
 * PRECEDENCE (a bead can match more than one signal; this is the settled
 * order, documented here because the spec requires a decision, not a
 * silently implicit one): the `[regression][carry-over]` title marker wins
 * first -- it is the regression phase's explicit, intentional signal, so a
 * `deferred` bead someone also titled with the marker is still reported as
 * `regression`, not reclassified by its status. `deferred` is checked next
 * (status is authoritative once the title marker is absent). Everything else
 * still open at terminal state is `unfinished`.
 * @param {{ title?: any, status?: any }} row
 * @returns {'regression'|'deferred'|'unfinished'}
 */
function classifyReason(row) {
  const title = typeof row.title === 'string' ? row.title : '';
  if (title.includes(REGRESSION_MARKER)) return 'regression';
  if (row.status === 'deferred') return 'deferred';
  return 'unfinished';
}

/**
 * Builds the CarryOverItem shape (fleet-bridge-design.md section 5) from a
 * `bd list --json` row plus its computed reason. `sprintId`/`prUrl`/`branch`
 * are deliberately NOT filled in here -- they are not inputs to this pure
 * function; `finalize` assembles them once the sprint's terminal PR/branch
 * are known.
 * @param {object} row
 * @param {'regression'|'deferred'|'unfinished'} reason
 * @returns {Readonly<object>}
 */
function toCarryOverItem(row, reason) {
  return Object.freeze({
    beadId: row.id,
    title: row.title,
    body: row.description,
    acceptanceCriteria: row.acceptance_criteria,
    issueType: row.issue_type,
    priority: row.priority,
    reason,
  });
}

/**
 * Deterministic comparator for the maxCarryOver cut: priority ascending
 * (numerically lower Pn is more urgent and is kept first; a missing or
 * non-numeric priority sorts last, as the worst priority), then `beadId`
 * ascending as a stable tiebreak. Using `beadId` rather than relying on
 * input order (even though `Array#sort` is stable in Node) is what makes
 * "the same input always yields the same split" hold for the same *set* of
 * rows regardless of what order `rows` arrived in.
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function compareForCarryOver(a, b) {
  const pa = typeof a.priority === 'number' && Number.isFinite(a.priority) ? a.priority : Number.POSITIVE_INFINITY;
  const pb = typeof b.priority === 'number' && Number.isFinite(b.priority) ? b.priority : Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa - pb;
  const ida = typeof a.beadId === 'string' ? a.beadId : '';
  const idb = typeof b.beadId === 'string' ? b.beadId : '';
  if (ida < idb) return -1;
  if (ida > idb) return 1;
  return 0;
}

/**
 * Selects which beads carry over into new backlog items at sprint end. Pure,
 * no I/O -- see module header.
 *
 * A bead is carry-over if and only if ALL THREE hold, checked in this order
 * (after the always-on synthetic-root exclusion):
 *   1. Not closed -- `status` is one of open/in_progress/blocked/deferred.
 *   2. No `external_ref` -- it did not come from the tracker. This is also
 *      what makes the whole operation idempotent: `publishCarryOver`/
 *      `finalize` stamps `external_ref` onto a bead once pushed, so a second
 *      `finalize` run over the same (now-refreshed) rows selects nothing for
 *      it.
 *   3. Attributable to this sprint -- `created_at` strictly after
 *      `startedAt` (see module header amendment 1).
 *
 * `syntheticRootId` (the local-only epic `ingest` may create) is always
 * excluded, ahead of the three rules, regardless of its status, external_ref
 * or creation time.
 *
 * @param {Array<object>} rows - `bd list --json` records.
 * @param {object} opts
 * @param {number|string} opts.startedAt - epoch-ms or ISO-8601 sprint start;
 *   rule 3 keeps only beads created strictly after this instant.
 * @param {string} [opts.syntheticRootId] - always excluded, per above.
 * @param {number} [opts.maxCarryOver=25] - top-N by priority are `selected`;
 *   the rest of the otherwise-qualifying candidates are `suppressed`, never
 *   dropped silently (see module header amendment 2).
 * @returns {{
 *   selected: object[],
 *   suppressed: object[],
 *   skipped: Array<{ beadId: (string|null), reason: string }>,
 * }}
 * @throws {BridgeError} CONFIG_MISSING/CONFIG_INVALID if `rows` or `opts`
 *   themselves are malformed (a caller-contract violation). A malformed
 *   individual ROW never throws -- see `toEpochMs`/`classifyReason`, which
 *   degrade a bad field on one row into a skip reason instead.
 */
export function selectCarryOver(rows, opts = {}) {
  if (!Array.isArray(rows)) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `selectCarryOver: rows must be an array of bd-list records, got ${typeof rows}`,
      { rowsType: typeof rows }
    );
  }
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      'selectCarryOver: opts must be an object'
    );
  }

  const { startedAt, syntheticRootId, maxCarryOver = DEFAULT_MAX_CARRY_OVER } = opts;

  if (startedAt === undefined || startedAt === null) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_MISSING,
      'selectCarryOver: opts.startedAt is required -- rule 3 ("attributable to this sprint") has nothing to compare created_at against otherwise'
    );
  }
  const startedAtMs = toEpochMs(startedAt);
  if (startedAtMs === null) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `selectCarryOver: opts.startedAt is not a valid timestamp: ${JSON.stringify(startedAt)}`,
      { startedAt }
    );
  }

  if (!Number.isInteger(maxCarryOver) || maxCarryOver < 0) {
    throw new BridgeError(
      BRIDGE_ERROR_CODES.CONFIG_INVALID,
      `selectCarryOver: opts.maxCarryOver must be a non-negative integer, got ${JSON.stringify(maxCarryOver)}`,
      { maxCarryOver }
    );
  }

  const candidates = [];
  const skipped = [];

  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      skipped.push({ beadId: null, reason: 'invalid-row' });
      continue;
    }

    const beadId = typeof row.id === 'string' && row.id.length > 0 ? row.id : null;

    // Always excluded, ahead of the three numbered rules.
    if (
      beadId !== null &&
      typeof syntheticRootId === 'string' &&
      syntheticRootId.length > 0 &&
      beadId === syntheticRootId
    ) {
      skipped.push({ beadId, reason: 'synthetic-root' });
      continue;
    }

    // Rule 1 -- not closed.
    if (typeof row.status !== 'string' || !OPEN_STATUSES.has(row.status)) {
      skipped.push({ beadId, reason: 'closed' });
      continue;
    }

    // Rule 2 -- no external_ref (a non-empty string; anything else is bd's
    // "absent" value for a plain local bead).
    if (typeof row.external_ref === 'string' && row.external_ref.length > 0) {
      skipped.push({ beadId, reason: 'external_ref' });
      continue;
    }

    // Rule 3 -- created strictly after startedAt. A missing/unparseable
    // created_at cannot be shown attributable, so it is skipped rather than
    // assumed in-scope.
    const createdMs = toEpochMs(row.created_at);
    if (createdMs === null || !(createdMs > startedAtMs)) {
      skipped.push({ beadId, reason: 'not-attributable' });
      continue;
    }

    const reason = classifyReason(row);
    candidates.push(toCarryOverItem(beadId === null ? row : { ...row, id: beadId }, reason));
  }

  const sorted = [...candidates].sort(compareForCarryOver);
  const selected = sorted.slice(0, maxCarryOver);
  const suppressed = sorted.slice(maxCarryOver);

  return { selected, suppressed, skipped };
}

export default selectCarryOver;
