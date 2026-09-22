// =============================================================================
// fleet-se supervisor store -- open, pragmas, schema_version, migration runner
// =============================================================================
//
// One SQLite file, `supervisor.sqlite`, holding the console's durable state.
// This module owns three things and nothing else:
//
//   1. WHERE the file lives. The path derives from the service data-dir knob
//      (`FLEET_SE_DATA_DIR`, else `~/.apra-fleet-se`) via `defaultDataDir()` in
//      ../../supervisor/ledger.mjs -- the SAME knob every other piece of
//      supervisor state already honours. There is deliberately no second
//      home-directory literal in this file: an isolated store (a test, a
//      sandbox deploy, two supervisors on one host) is obtained purely by
//      pointing the data-dir knob somewhere else, and any code that hardcoded
//      a home path would silently escape that isolation.
//
//   2. HOW it is opened. WAL journalling (so a reader never blocks the writer
//      and a crash mid-write does not truncate the db) and
//      `PRAGMA foreign_keys = ON`, which SQLite leaves OFF by default -- the
//      schema's ON DELETE CASCADE / FK rejections only exist if this is set on
//      every connection, so it is set here rather than per-repository.
//
//   3. HOW the schema moves forward. A `schema_version` table with one row per
//      applied migration, and an ordered, idempotent runner. Reopening an
//      already-migrated store applies nothing and leaves the version where it
//      was; a new migration file is picked up by appending it to MIGRATIONS.
//
// Repositories (projects, member_git, ...) layer on top of the handle this
// module returns; nothing here knows what the tables mean.
//
// node:sqlite availability
// ------------------------
// node:sqlite is a Node builtin, but only an unflagged, usable one from Node
// 22.13.0 onward. On an older runtime `require('node:sqlite')` throws an
// opaque "No such built-in module" error from somewhere deep in the call
// stack. We therefore require it lazily through createRequire (a static
// `import` would throw at module-evaluation time, where no caller can catch
// it) and re-throw a NodeSqliteUnavailableError that names the runtime, the
// floor, and the remedy. Callers that can degrade instead of failing -- tests,
// optional features -- use `isNodeSqliteAvailable()` to skip cleanly.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { defaultDataDir } from '../../supervisor/ledger.mjs';
import migration001 from './migrations/001-projects.mjs';

/** Filename of the supervisor store inside the service data directory. */
export const STORE_FILENAME = 'supervisor.sqlite';

/**
 * Lowest Node release on which node:sqlite is a usable, unflagged builtin.
 * Quoted in the unavailability error so the remedy is actionable.
 */
export const NODE_SQLITE_MIN_VERSION = '22.13.0';

/**
 * Every migration, in application order. Appending a module here is the only
 * step needed to ship a schema change; the runner does the rest.
 * @type {ReadonlyArray<{version: number, name: string, up: (db: any) => void}>}
 */
export const MIGRATIONS = Object.freeze([migration001]);

/** The schema version a freshly opened store converges to. */
export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

/**
 * Thrown when the running Node has no usable node:sqlite. Carries a stable
 * `code` so callers can distinguish "this runtime cannot host the store" from
 * "the store is corrupt".
 */
export class NodeSqliteUnavailableError extends Error {
    /** @param {unknown} [cause] The original require failure, if any. */
    constructor(cause) {
        super(
            `node:sqlite is not available on this Node runtime (${process.version}). ` +
            `The fleet-se supervisor store requires Node >= ${NODE_SQLITE_MIN_VERSION}, ` +
            `where node:sqlite is a built-in module and no longer behind a flag. ` +
            `Upgrade Node to run the supervisor store.`,
        );
        this.name = 'NodeSqliteUnavailableError';
        this.code = 'ERR_NODE_SQLITE_UNAVAILABLE';
        if (cause !== undefined) this.cause = cause;
    }
}

const requireFromHere = createRequire(import.meta.url);

/** @type {{DatabaseSync: any} | null | undefined} */
let sqliteModule;

/**
 * Load node:sqlite, or throw a NodeSqliteUnavailableError naming the runtime.
 * The result (success or failure) is cached -- the answer cannot change within
 * a process.
 *
 * @returns {{DatabaseSync: any}}
 */
export function loadNodeSqlite() {
    if (sqliteModule === undefined) {
        try {
            const mod = requireFromHere('node:sqlite');
            sqliteModule = typeof mod?.DatabaseSync === 'function' ? mod : null;
            if (sqliteModule === null) throw new Error('node:sqlite has no DatabaseSync export');
        } catch (err) {
            sqliteModule = null;
            throw new NodeSqliteUnavailableError(err);
        }
    }
    if (sqliteModule === null) throw new NodeSqliteUnavailableError();
    return sqliteModule;
}

/**
 * Whether this runtime can host the store. Never throws -- intended for
 * skip-guards in tests and optional call sites.
 *
 * @returns {boolean}
 */
export function isNodeSqliteAvailable() {
    try {
        loadNodeSqlite();
        return true;
    } catch {
        return false;
    }
}

/**
 * Absolute path of the supervisor store.
 *
 * @param {{dataDir?: string}} [options] `dataDir` overrides the data-dir knob
 *   (tests and per-instance stores); omitted, the knob decides.
 * @returns {string}
 */
export function defaultStorePath(options = {}) {
    const dir = options.dataDir ? path.resolve(options.dataDir) : defaultDataDir();
    return path.join(dir, STORE_FILENAME);
}

/**
 * Highest migration version recorded in the store, or 0 on a store that has
 * never been migrated.
 *
 * @param {any} db An open database.
 * @returns {number}
 */
export function readSchemaVersion(db) {
    const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get();
    const version = row?.version;
    return typeof version === 'number' ? version : 0;
}

function ensureSchemaVersionTable(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
            version    INTEGER PRIMARY KEY,
            name       TEXT NOT NULL,
            applied_at TEXT NOT NULL
        );
    `);
}

function validateMigrations(migrations) {
    const seen = new Set();
    for (const migration of migrations) {
        const { version, name, up } = migration ?? {};
        if (!Number.isInteger(version) || version < 1) {
            throw new TypeError(`migration "${name ?? '?'}" must have an integer version >= 1`);
        }
        if (typeof name !== 'string' || name.length === 0) {
            throw new TypeError(`migration ${version} must have a non-empty name`);
        }
        if (typeof up !== 'function') {
            throw new TypeError(`migration ${name} must export an up(db) function`);
        }
        if (seen.has(version)) {
            throw new TypeError(`duplicate migration version ${version} (${name})`);
        }
        seen.add(version);
    }
    return [...migrations].sort((a, b) => a.version - b.version);
}

/**
 * Apply every migration newer than the store's recorded version, in ascending
 * version order, each in its own transaction together with its `schema_version`
 * row -- so a failing migration leaves neither half-applied DDL nor a version
 * row claiming it succeeded. Already-applied migrations are skipped, which is
 * what makes reopening an existing store a no-op.
 *
 * @param {any} db An open database.
 * @param {ReadonlyArray<{version: number, name: string, up: (db: any) => void}>} [migrations]
 * @returns {{from: number, to: number, applied: string[]}}
 */
export function applyMigrations(db, migrations = MIGRATIONS) {
    const ordered = validateMigrations(migrations);
    ensureSchemaVersionTable(db);

    const from = readSchemaVersion(db);
    const applied = [];

    for (const migration of ordered) {
        if (migration.version <= from) continue;
        db.exec('BEGIN');
        try {
            migration.up(db);
            db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)')
                .run(migration.version, migration.name, new Date().toISOString());
            db.exec('COMMIT');
        } catch (err) {
            try { db.exec('ROLLBACK'); } catch { /* the failure below is the real one */ }
            throw new Error(
                `supervisor store migration ${migration.version} (${migration.name}) failed: ${err?.message ?? err}`,
                { cause: err },
            );
        }
        applied.push(migration.name);
    }

    return { from, to: readSchemaVersion(db), applied };
}

/**
 * Open (creating if absent) the supervisor store and bring it to the latest
 * schema version.
 *
 * @param {object} [options]
 * @param {string} [options.dataDir] Data directory override; defaults to the
 *   `FLEET_SE_DATA_DIR` knob, else `~/.apra-fleet-se`.
 * @param {string} [options.file] Full path to the store file, bypassing the
 *   data-dir join (per-project instances, `:memory:` in tests).
 * @param {ReadonlyArray<{version: number, name: string, up: (db: any) => void}>} [options.migrations]
 * @returns {{db: any, path: string, version: number, applied: string[], close: () => void}}
 * @throws {NodeSqliteUnavailableError} On a Node without a usable node:sqlite.
 */
export function openStore(options = {}) {
    const { DatabaseSync } = loadNodeSqlite();

    const inMemory = options.file === ':memory:';
    const storePath = inMemory ? ':memory:' : (options.file ? path.resolve(options.file) : defaultStorePath(options));
    if (!inMemory) fs.mkdirSync(path.dirname(storePath), { recursive: true });

    const db = new DatabaseSync(storePath);
    try {
        // WAL is meaningless for an in-memory db and SQLite silently keeps
        // journal_mode=memory there, so only ask for it on a real file.
        if (!inMemory) db.exec('PRAGMA journal_mode = WAL');
        // OFF by default in SQLite, and per-connection -- without this the
        // schema's foreign keys are documentation, not constraints.
        db.exec('PRAGMA foreign_keys = ON');

        const { applied } = applyMigrations(db, options.migrations ?? MIGRATIONS);

        return {
            db,
            path: storePath,
            version: readSchemaVersion(db),
            applied,
            close() { db.close(); },
        };
    } catch (err) {
        try { db.close(); } catch { /* the open failure below is the real one */ }
        throw err;
    }
}
