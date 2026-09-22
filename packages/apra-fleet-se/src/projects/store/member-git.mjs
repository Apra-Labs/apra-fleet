// =============================================================================
// supervisor.sqlite repository -- `member_git`
// =============================================================================
//
// Upsert/get/list over the `member_git` table created by migration
// 001-projects.mjs: the cached result of the per-member git probe, one row per
// (project, member), keyed by the composite primary key `(project_id,
// member)`. See ./db.mjs and ./migrations/001-projects.mjs for the schema and
// FK/cascade rationale; this module only knows CRUD and row shape.
//
// Upsert, not insert
// -------------------
// A probe re-runs on the SAME (project, member) pair every time the git
// drawer or health panel refreshes, so the write here is always "replace
// whatever we cached last" -- `upsertMemberGit` is an `INSERT ... ON
// CONFLICT(project_id, member) DO UPDATE`, never a plain INSERT that would
// need a separate update path.
//
// JSON columns
// ------------
// `worktrees`, `playbooks`, and `status_json` are TEXT columns holding
// serialized JSON (arrays/objects respectively). This module serializes on
// write (a plain string is passed through unserialized, matching the "already
// a JSON string" case) and parses on read, falling back to the raw string
// if it does not parse -- callers work with objects/arrays, never with
// hand-rolled JSON.stringify/parse at each call site.
//
// FK to `projects`
// -----------------
// `PRAGMA foreign_keys = ON` (db.mjs) makes `member_git.project_id`'s FK
// constraint real: upserting a row against a project id that does not exist
// fails at the SQLite layer with a `FOREIGN KEY constraint failed` error.
// `upsertMemberGit` catches that specific failure and re-throws it as a
// `StoreValidationError` on field `projectId` -- the same `{field, reason}`
// shape as a validation-time rejection -- so callers (and the future
// `/api/projects` route module) have exactly one error shape to handle for
// "this row cannot be written", not two.
// =============================================================================

import { StoreValidationError } from './projects.mjs';

export { StoreValidationError };

/** Columns making up the `member_git` table, in schema order. */
const COLUMNS = Object.freeze([
    'project_id', 'member', 'origin_slug', 'origin_url', 'checkout_path', 'branch',
    'upstream', 'dirty', 'worktrees', 'playbooks', 'bible_commit', 'status_json', 'probed_at',
]);

/** Columns whose TEXT storage is serialized JSON. */
const JSON_COLUMNS = Object.freeze(['worktrees', 'playbooks', 'status_json']);

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function isNullableString(value) {
    return value === undefined || value === null || isNonEmptyString(value);
}

/**
 * Serialize a value bound for a JSON TEXT column: `null`/`undefined` pass
 * through as `null`, a string is stored verbatim (already-serialized JSON),
 * anything else is `JSON.stringify`-ed.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function toJsonColumn(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
}

/**
 * Parse a JSON TEXT column back to an object/array. A value that fails to
 * parse (or is null) is returned as-is rather than throwing -- a probe cache
 * is best-effort, not a source of truth worth crashing a read over.
 *
 * @param {string | null} value
 * @returns {unknown}
 */
function fromJsonColumn(value) {
    if (value === null || value === undefined) return null;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

/**
 * Validate an upsert payload, collecting every violation.
 *
 * @param {object} input
 * @returns {Array<{field: string, reason: string}>}
 */
function validateFields(input) {
    const errors = [];

    if (!isNonEmptyString(input.projectId)) {
        errors.push({ field: 'projectId', reason: 'must be a non-empty string' });
    }
    if (!isNonEmptyString(input.member)) {
        errors.push({ field: 'member', reason: 'must be a non-empty string' });
    }
    for (const field of ['originSlug', 'originUrl', 'checkoutPath', 'branch', 'upstream', 'bibleCommit', 'probedAt']) {
        if (!isNullableString(input[field])) {
            errors.push({ field, reason: 'must be a non-empty string or null' });
        }
    }
    if (input.dirty !== undefined && input.dirty !== null
        && typeof input.dirty !== 'boolean' && input.dirty !== 0 && input.dirty !== 1) {
        errors.push({ field: 'dirty', reason: 'must be a boolean (or 0/1)' });
    }

    return errors;
}

/**
 * Map a `member_git` row (snake_case) to the object shape callers work with.
 *
 * @param {any} row
 * @returns {object | null}
 */
function fromRow(row) {
    if (!row) return null;
    return {
        projectId: row.project_id,
        member: row.member,
        originSlug: row.origin_slug ?? null,
        originUrl: row.origin_url ?? null,
        checkoutPath: row.checkout_path ?? null,
        branch: row.branch ?? null,
        upstream: row.upstream ?? null,
        dirty: Boolean(row.dirty),
        worktrees: fromJsonColumn(row.worktrees),
        playbooks: fromJsonColumn(row.playbooks),
        bibleCommit: row.bible_commit ?? null,
        statusJson: fromJsonColumn(row.status_json),
        probedAt: row.probed_at ?? null,
    };
}

function isForeignKeyViolation(err) {
    return typeof err?.message === 'string' && /FOREIGN KEY/i.test(err.message);
}

/**
 * Insert or replace the cached probe result for one (project, member) pair.
 *
 * @param {any} db An open supervisor store (see ../db.mjs `openStore`).
 * @param {object} input `{projectId, member, originSlug?, originUrl?, checkoutPath?,
 *   branch?, upstream?, dirty?, worktrees?, playbooks?, bibleCommit?, statusJson?, probedAt?}`.
 * @returns {object} The upserted row, in the shape returned by `getMemberGit`.
 * @throws {StoreValidationError} On a missing/malformed field, or when `projectId`
 *   references a project that does not exist (the FK violation is translated to
 *   the same `{field, reason}` shape as a validation-time rejection).
 */
export function upsertMemberGit(db, input) {
    const payload = input ?? {};
    const errors = validateFields(payload);
    if (errors.length > 0) throw new StoreValidationError(errors);

    try {
        db.prepare(
            `INSERT INTO member_git (project_id, member, origin_slug, origin_url, checkout_path, branch, upstream, dirty, worktrees, playbooks, bible_commit, status_json, probed_at)
             VALUES (@project_id, @member, @origin_slug, @origin_url, @checkout_path, @branch, @upstream, @dirty, @worktrees, @playbooks, @bible_commit, @status_json, @probed_at)
             ON CONFLICT(project_id, member) DO UPDATE SET
                origin_slug   = excluded.origin_slug,
                origin_url    = excluded.origin_url,
                checkout_path = excluded.checkout_path,
                branch        = excluded.branch,
                upstream      = excluded.upstream,
                dirty         = excluded.dirty,
                worktrees     = excluded.worktrees,
                playbooks     = excluded.playbooks,
                bible_commit  = excluded.bible_commit,
                status_json   = excluded.status_json,
                probed_at     = excluded.probed_at`,
        ).run({
            project_id: payload.projectId,
            member: payload.member,
            origin_slug: payload.originSlug ?? null,
            origin_url: payload.originUrl ?? null,
            checkout_path: payload.checkoutPath ?? null,
            branch: payload.branch ?? null,
            upstream: payload.upstream ?? null,
            dirty: payload.dirty ? 1 : 0,
            worktrees: toJsonColumn(payload.worktrees),
            playbooks: toJsonColumn(payload.playbooks),
            bible_commit: payload.bibleCommit ?? null,
            status_json: toJsonColumn(payload.statusJson),
            probed_at: payload.probedAt ?? null,
        });
    } catch (err) {
        if (isForeignKeyViolation(err)) {
            throw new StoreValidationError([
                { field: 'projectId', reason: `references a project that does not exist: ${payload.projectId}` },
            ]);
        }
        throw err;
    }

    return getMemberGit(db, payload.projectId, payload.member);
}

/**
 * Fetch one member_git row by its composite key.
 *
 * @param {any} db
 * @param {string} projectId
 * @param {string} member
 * @returns {object | null} `null` when no row matches.
 */
export function getMemberGit(db, projectId, member) {
    const row = db
        .prepare(`SELECT ${COLUMNS.join(', ')} FROM member_git WHERE project_id = ? AND member = ?`)
        .get(projectId, member);
    return fromRow(row);
}

/**
 * List every member_git row for a project, ordered by member for a
 * deterministic result.
 *
 * @param {any} db
 * @param {string} projectId
 * @returns {object[]}
 */
export function listMemberGit(db, projectId) {
    const rows = db
        .prepare(`SELECT ${COLUMNS.join(', ')} FROM member_git WHERE project_id = ? ORDER BY member`)
        .all(projectId);
    return rows.map(fromRow);
}

/**
 * Delete one member_git row. There is no cascade concern here (member_git has
 * no dependents) -- unlike `deleteProject`, this always just removes the row.
 *
 * @param {any} db
 * @param {string} projectId
 * @param {string} member
 * @returns {boolean} `true` if a row was deleted, `false` if it did not exist.
 */
export function deleteMemberGit(db, projectId, member) {
    const result = db.prepare('DELETE FROM member_git WHERE project_id = ? AND member = ?').run(projectId, member);
    const changes = typeof result?.changes === 'bigint' ? Number(result.changes) : result?.changes;
    return (changes ?? 0) > 0;
}
