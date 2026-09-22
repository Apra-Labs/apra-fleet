// =============================================================================
// supervisor.sqlite migration 001 -- `projects` and `member_git`
// =============================================================================
//
// The first schema increment of the fleet-se supervisor store. It creates the
// two tables the project domain is built on:
//
//   projects    one row per console project: its identity, the backlog member
//               that owns the beads database, and the beads binding itself
//               (kind/dir/remote/prefix). The remote is a DEDICATED beads
//               remote supplied by the operator -- the console stores and
//               validates it but never creates it, which is why `beads_remote`
//               is nullable here (a project may be bound to a purely local
//               beads dir) and why nothing in this migration derives a remote.
//
//   member_git  the cached result of the per-member git probe, one row per
//               (project, member). `origin_slug` is the normalised host+path
//               of the member checkout's origin, and is the grouping key the
//               project overview and sprint-definition screens use to split a
//               project's members into repo groups; `upstream` feeds per-group
//               launch defaults. A member with no checkout still gets a row
//               (all the checkout columns NULL) so "bound but no checkout" is
//               representable and groupable, rather than being indistinguishable
//               from "never probed".
//
// Shape notes:
//   * Every migration module exports { version, name, up(db) }. `up` runs
//     inside a transaction opened by the migration runner in ../db.mjs; it must
//     not BEGIN/COMMIT itself.
//   * `projects.id` is an operator-chosen slug, not a surrogate key, so it is
//     the natural TEXT primary key and the FK target for member_git.
//   * member_git rows are meaningless without their project, hence
//     ON DELETE CASCADE. PRAGMA foreign_keys is turned ON by the store opener,
//     so the cascade (and the FK rejection) is actually enforced at runtime.
//   * Timestamps are ISO-8601 strings (TEXT), matching the JSON state files
//     this store is gradually replacing, so exported rows stay readable.
//   * `status_json` keeps the full probe payload verbatim alongside the
//     promoted columns, so a later probe-shape change does not lose fields that
//     no column exists for yet.

/** Monotonic schema increment applied by the store's migration runner. */
export const version = 1;

/** Human-readable migration name, recorded in `schema_version`. */
export const name = '001-projects';

/**
 * Create the `projects` and `member_git` tables.
 *
 * @param {import('node:sqlite').DatabaseSync} db An open supervisor store.
 * @returns {void}
 */
export function up(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            backlog_member  TEXT NOT NULL,
            beads_kind      TEXT NOT NULL DEFAULT 'clone',
            beads_dir       TEXT NOT NULL,
            beads_remote    TEXT,
            beads_prefix    TEXT,
            operator        TEXT,
            created_at      TEXT NOT NULL,
            updated_at      TEXT NOT NULL
        );
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS member_git (
            project_id    TEXT NOT NULL,
            member        TEXT NOT NULL,
            origin_slug   TEXT,
            origin_url    TEXT,
            checkout_path TEXT,
            branch        TEXT,
            upstream      TEXT,
            dirty         INTEGER NOT NULL DEFAULT 0,
            worktrees     TEXT,
            playbooks     TEXT,
            bible_commit  TEXT,
            status_json   TEXT,
            probed_at     TEXT,
            PRIMARY KEY (project_id, member),
            FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
        );
    `);

    // Grouping a project's members by repo is the hot read on the overview and
    // sprint-definition screens; the sprint side also looks a member up across
    // projects when validating role assignments.
    db.exec(`
        CREATE INDEX IF NOT EXISTS member_git_origin_slug_idx
            ON member_git (project_id, origin_slug);
    `);
    db.exec(`
        CREATE INDEX IF NOT EXISTS member_git_member_idx
            ON member_git (member);
    `);
}

export default { version, name, up };
