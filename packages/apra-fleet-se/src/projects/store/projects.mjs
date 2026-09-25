// =============================================================================
// supervisor.sqlite repository -- `projects`
// =============================================================================
//
// CRUD over the `projects` table created by migration 001-projects.mjs. This
// module owns row shape, validation, and timestamp bookkeeping; it does not
// open or migrate the store (see ./db.mjs) and does not know about routes,
// HTTP, or the beads client -- those layer on top.
//
// Row <-> object mapping
// -----------------------
// The table's `beads_*` columns are grouped into a nested `beads` object on
// the returned/accepted project shape (`{kind, dir, remote, prefix}`), matching
// the create-payload shape documented in the v0.5 sprint plan (doc s4.3,
// V05-S3-F4): `{id, name, backlogMember, beads:{kind,dir,remote,prefix},
// operator}`. Nothing else about the row is renamed.
//
// Validation
// ----------
// `createProject`/`updateProject` reject an invalid row with a
// `StoreValidationError` carrying one or more `{field, reason}` entries --
// the shape the future `/api/projects` route module (V05-S3-F4) maps directly
// onto its 400 responses. A row that violates the `member_git` foreign key
// (i.e. deleting a project that still has cached member rows) is instead a
// SQLite constraint, not a validation error; see `deleteProject` below for how
// that is surfaced.
//
// Delete semantics
// -----------------
// `deleteProject` CASCADES: migration 001 declares
// `member_git.project_id REFERENCES projects(id) ON DELETE CASCADE`, and
// `PRAGMA foreign_keys = ON` (set once per connection in db.mjs) makes that
// cascade real. Deleting a project therefore also deletes every `member_git`
// row that referenced it -- there is no separate "refuse if members are
// bound" mode. This is a deliberate reading of doc s4.3: `member_git` rows are
// a probe CACHE, not durable state of their own, so losing them alongside
// their project is the correct (and only) behaviour, not a hazard to guard
// against with a pre-delete check.
// =============================================================================

/** Columns making up the `projects` table, in schema order. */
const COLUMNS = Object.freeze([
    'id', 'name', 'backlog_member', 'beads_kind', 'beads_dir', 'beads_remote',
    'beads_prefix', 'operator', 'created_at', 'updated_at',
]);

/**
 * Thrown by createProject/updateProject when the given row is invalid.
 * `errors` is always a non-empty array of `{field, reason}`; `field`/`reason`
 * on the instance mirror the first entry for callers that only care about one.
 */
export class StoreValidationError extends Error {
    /** @param {Array<{field: string, reason: string}>} errors */
    constructor(errors) {
        const list = Array.isArray(errors) ? errors : [errors];
        super(`invalid row: ${list.map((e) => `${e.field} (${e.reason})`).join(', ')}`);
        this.name = 'StoreValidationError';
        this.errors = list;
        this.field = list[0]?.field;
        this.reason = list[0]?.reason;
    }
}

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function nowIso() {
    return new Date().toISOString();
}

/**
 * Validate a create/update payload's fields that are present, collecting
 * every violation rather than stopping at the first. Which fields are
 * REQUIRED differs between create and update, so that is passed in.
 *
 * @param {object} input
 * @param {{requireAll: boolean}} options
 * @returns {Array<{field: string, reason: string}>}
 */
function validateFields(input, { requireAll }) {
    const errors = [];
    const has = (key) => Object.prototype.hasOwnProperty.call(input, key);

    if (requireAll || has('id')) {
        if (!isNonEmptyString(input.id)) errors.push({ field: 'id', reason: 'must be a non-empty string' });
    }
    if (requireAll || has('name')) {
        if (!isNonEmptyString(input.name)) errors.push({ field: 'name', reason: 'must be a non-empty string' });
    }
    if (requireAll || has('backlogMember')) {
        if (!isNonEmptyString(input.backlogMember)) {
            errors.push({ field: 'backlogMember', reason: 'must be a non-empty string' });
        }
    }

    const beads = input.beads ?? {};
    const beadsProvided = requireAll || has('beads');
    if (beadsProvided && (typeof beads !== 'object' || beads === null || Array.isArray(beads))) {
        errors.push({ field: 'beads', reason: 'must be an object' });
    } else if (beadsProvided) {
        if (Object.prototype.hasOwnProperty.call(beads, 'kind') && beads.kind !== undefined
            && !isNonEmptyString(beads.kind)) {
            errors.push({ field: 'beads.kind', reason: 'must be a non-empty string' });
        }
        const dirRequired = requireAll || Object.prototype.hasOwnProperty.call(beads, 'dir');
        if (dirRequired && !isNonEmptyString(beads.dir)) {
            errors.push({ field: 'beads.dir', reason: 'must be a non-empty string' });
        }
        if (beads.remote !== undefined && beads.remote !== null && !isNonEmptyString(beads.remote)) {
            errors.push({ field: 'beads.remote', reason: 'must be a non-empty string or null' });
        }
        if (beads.prefix !== undefined && beads.prefix !== null && !isNonEmptyString(beads.prefix)) {
            errors.push({ field: 'beads.prefix', reason: 'must be a non-empty string or null' });
        }
    }

    if (has('operator') && input.operator !== undefined && input.operator !== null
        && !isNonEmptyString(input.operator)) {
        errors.push({ field: 'operator', reason: 'must be a non-empty string or null' });
    }

    return errors;
}

/**
 * Map a `projects` row (snake_case, `beads_*` columns flat) to the nested
 * object shape callers work with. Returns null for a missing row so callers
 * can `if (!project) ...` instead of checking `undefined` vs `null`.
 *
 * @param {any} row
 * @returns {object | null}
 */
function fromRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        backlogMember: row.backlog_member,
        beads: {
            kind: row.beads_kind,
            dir: row.beads_dir,
            remote: row.beads_remote ?? null,
            prefix: row.beads_prefix ?? null,
        },
        operator: row.operator ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/**
 * Create a project row.
 *
 * @param {any} db An open supervisor store (see ./db.mjs `openStore`).
 * @param {object} input `{id, name, backlogMember, beads:{kind?, dir, remote?, prefix?}, operator?, createdAt?}`.
 *   `beads.kind` defaults to `'clone'` (matching the column default) when omitted.
 *   `createdAt`, when given, is an ISO-8601 string used verbatim for the
 *   `created_at` column instead of "now" -- this is what lets
 *   `bin/se.mjs`'s `importProject()` restore a project's ORIGINAL creation
 *   time from an export into a fresh store, rather than stamping the moment
 *   of import (see se-export-import.test.mjs's round-trip case). Untrusted
 *   callers (e.g. the `POST /api/projects` HTTP route) must not forward a
 *   client-supplied `createdAt` -- that route strips it before calling in.
 *   `updated_at` always gets "now", regardless of `createdAt`.
 * @returns {object} The created project, in the shape returned by `getProject`.
 * @throws {StoreValidationError} On a missing/malformed required field.
 * @throws {Error} On a duplicate `id` (SQLite UNIQUE/PRIMARY KEY violation).
 */
export function createProject(db, input) {
    const errors = validateFields(input ?? {}, { requireAll: true });
    if (Object.prototype.hasOwnProperty.call(input ?? {}, 'createdAt')
        && !isNonEmptyString(input.createdAt)) {
        errors.push({ field: 'createdAt', reason: 'must be a non-empty string' });
    }
    if (errors.length > 0) throw new StoreValidationError(errors);

    const beads = input.beads ?? {};
    const now = nowIso();
    const createdAt = isNonEmptyString(input.createdAt) ? input.createdAt : now;

    db.prepare(
        `INSERT INTO projects (id, name, backlog_member, beads_kind, beads_dir, beads_remote, beads_prefix, operator, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        input.id,
        input.name,
        input.backlogMember,
        beads.kind ?? 'clone',
        beads.dir,
        beads.remote ?? null,
        beads.prefix ?? null,
        input.operator ?? null,
        createdAt,
        now,
    );

    return getProject(db, input.id);
}

/**
 * Fetch one project by id.
 *
 * @param {any} db
 * @param {string} id
 * @returns {object | null} `null` when no row matches.
 */
export function getProject(db, id) {
    const row = db.prepare(`SELECT ${COLUMNS.join(', ')} FROM projects WHERE id = ?`).get(id);
    return fromRow(row);
}

/**
 * List every project, ordered by id for a deterministic result.
 *
 * @param {any} db
 * @returns {object[]}
 */
export function listProjects(db) {
    const rows = db.prepare(`SELECT ${COLUMNS.join(', ')} FROM projects ORDER BY id`).all();
    return rows.map(fromRow);
}

/**
 * Patch an existing project. Only the fields present in `patch` are
 * validated and written; `id` and timestamps are not patchable (an `id` in
 * `patch` is ignored -- the primary key never changes, and a rename is a
 * delete+create at the call site, matching doc s4.3). `updated_at` is always
 * refreshed to now.
 *
 * @param {any} db
 * @param {string} id
 * @param {object} patch Any subset of `{name, backlogMember, beads:{kind,dir,remote,prefix}, operator}`.
 * @returns {object} The updated project.
 * @throws {StoreValidationError} On a malformed field in `patch`.
 * @throws {Error} `{code: 'ERR_PROJECT_NOT_FOUND'}` if `id` does not exist.
 */
export function updateProject(db, id, patch) {
    const existing = getProject(db, id);
    if (!existing) {
        const err = new Error(`project not found: ${id}`);
        err.code = 'ERR_PROJECT_NOT_FOUND';
        throw err;
    }

    const input = patch ?? {};
    const errors = validateFields(input, { requireAll: false });
    if (errors.length > 0) throw new StoreValidationError(errors);

    const beadsPatch = input.beads ?? {};
    const next = {
        name: Object.prototype.hasOwnProperty.call(input, 'name') ? input.name : existing.name,
        backlogMember: Object.prototype.hasOwnProperty.call(input, 'backlogMember')
            ? input.backlogMember : existing.backlogMember,
        beadsKind: Object.prototype.hasOwnProperty.call(beadsPatch, 'kind') ? beadsPatch.kind : existing.beads.kind,
        beadsDir: Object.prototype.hasOwnProperty.call(beadsPatch, 'dir') ? beadsPatch.dir : existing.beads.dir,
        beadsRemote: Object.prototype.hasOwnProperty.call(beadsPatch, 'remote')
            ? (beadsPatch.remote ?? null) : existing.beads.remote,
        beadsPrefix: Object.prototype.hasOwnProperty.call(beadsPatch, 'prefix')
            ? (beadsPatch.prefix ?? null) : existing.beads.prefix,
        operator: Object.prototype.hasOwnProperty.call(input, 'operator')
            ? (input.operator ?? null) : existing.operator,
    };

    db.prepare(
        `UPDATE projects
         SET name = ?, backlog_member = ?, beads_kind = ?, beads_dir = ?, beads_remote = ?, beads_prefix = ?, operator = ?, updated_at = ?
         WHERE id = ?`,
    ).run(
        next.name,
        next.backlogMember,
        next.beadsKind,
        next.beadsDir,
        next.beadsRemote,
        next.beadsPrefix,
        next.operator,
        nowIso(),
        id,
    );

    return getProject(db, id);
}

/**
 * Delete a project. CASCADES to its `member_git` rows via the FK declared in
 * migration 001 (see module header) -- there is no "refuse while members are
 * bound" mode.
 *
 * @param {any} db
 * @param {string} id
 * @returns {boolean} `true` if a row was deleted, `false` if `id` did not exist.
 */
export function deleteProject(db, id) {
    const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    const changes = typeof result?.changes === 'bigint' ? Number(result.changes) : result?.changes;
    return (changes ?? 0) > 0;
}
