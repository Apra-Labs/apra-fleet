import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    STORE_FILENAME,
    LATEST_SCHEMA_VERSION,
    MIGRATIONS,
    NodeSqliteUnavailableError,
    applyMigrations,
    defaultStorePath,
    isNodeSqliteAvailable,
    openStore,
    readSchemaVersion,
} from '../src/projects/store/db.mjs';

// =============================================================================
// supervisor.sqlite store skeleton: db.mjs + migration runner + 001-projects.
//
// Every test here drives the store through a TEMP data dir -- either the
// FLEET_SE_DATA_DIR knob or the explicit `dataDir` option -- and asserts the
// resulting file lands under that dir. That is the isolation rule the store
// exists to honour: nothing may resolve to the real `~/.apra-fleet-se`, or a
// CI run would scribble on (and read state from) the runner's home directory.
//
// node:sqlite is a Node builtin only from 22.13.0. The suite skips cleanly on
// an older runtime rather than failing with an opaque require error; the CI
// matrix (macOS/Linux/Windows on current Node 22.x) always runs it for real.
// =============================================================================

const HAS_SQLITE = isNodeSqliteAvailable();
const skip = HAS_SQLITE ? false : 'node:sqlite is unavailable on this Node runtime';

/** @type {string[]} */
const tmpDirs = [];

async function tempDataDir() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'apra-fleet-se-store-'));
    tmpDirs.push(dir);
    return dir;
}

after(async () => {
    for (const dir of tmpDirs) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
});

describe('defaultStorePath', () => {
    const originalDataDir = process.env.FLEET_SE_DATA_DIR;
    after(() => {
        if (originalDataDir === undefined) delete process.env.FLEET_SE_DATA_DIR;
        else process.env.FLEET_SE_DATA_DIR = originalDataDir;
    });

    test('derives the store path from the FLEET_SE_DATA_DIR knob', async () => {
        const dir = await tempDataDir();
        process.env.FLEET_SE_DATA_DIR = dir;
        assert.equal(defaultStorePath(), path.join(dir, STORE_FILENAME));
    });

    test('an explicit dataDir option wins over the env knob', async () => {
        const envDir = await tempDataDir();
        const optDir = await tempDataDir();
        process.env.FLEET_SE_DATA_DIR = envDir;
        assert.equal(defaultStorePath({ dataDir: optDir }), path.join(optDir, STORE_FILENAME));
    });

    test('never resolves into the real home directory when the knob is set', async () => {
        const dir = await tempDataDir();
        process.env.FLEET_SE_DATA_DIR = dir;
        const resolved = defaultStorePath();
        assert.equal(resolved.startsWith(path.resolve(dir)), true);
        assert.equal(resolved.includes('.apra-fleet-se'), false);
    });
});

describe('openStore', { skip }, () => {
    test('creates supervisor.sqlite under the temp data dir', async () => {
        const dir = await tempDataDir();
        const store = openStore({ dataDir: dir });
        try {
            assert.equal(store.path, path.join(dir, STORE_FILENAME));
            assert.equal(fs.existsSync(store.path), true);
        } finally {
            store.close();
        }
    });

    test('creates a missing data directory rather than failing', async () => {
        const parent = await tempDataDir();
        const dir = path.join(parent, 'nested', 'data');
        const store = openStore({ dataDir: dir });
        try {
            assert.equal(fs.existsSync(path.join(dir, STORE_FILENAME)), true);
        } finally {
            store.close();
        }
    });

    test('honours the FLEET_SE_DATA_DIR knob with no explicit dataDir', async () => {
        const dir = await tempDataDir();
        const original = process.env.FLEET_SE_DATA_DIR;
        process.env.FLEET_SE_DATA_DIR = dir;
        try {
            const store = openStore();
            try {
                assert.equal(store.path, path.join(dir, STORE_FILENAME));
                assert.equal(fs.existsSync(store.path), true);
            } finally {
                store.close();
            }
        } finally {
            if (original === undefined) delete process.env.FLEET_SE_DATA_DIR;
            else process.env.FLEET_SE_DATA_DIR = original;
        }
    });

    test('schema_version is 1 after a first open', async () => {
        const dir = await tempDataDir();
        const store = openStore({ dataDir: dir });
        try {
            assert.equal(store.version, 1);
            assert.equal(store.version, LATEST_SCHEMA_VERSION);
            assert.equal(readSchemaVersion(store.db), 1);
            assert.deepEqual(store.applied, ['001-projects']);
        } finally {
            store.close();
        }
    });

    test('records one schema_version row per applied migration', async () => {
        const dir = await tempDataDir();
        const store = openStore({ dataDir: dir });
        try {
            const rows = store.db.prepare('SELECT version, name, applied_at FROM schema_version ORDER BY version').all();
            assert.equal(rows.length, MIGRATIONS.length);
            assert.equal(rows[0].version, 1);
            assert.equal(rows[0].name, '001-projects');
            assert.equal(typeof rows[0].applied_at, 'string');
            assert.equal(Number.isNaN(Date.parse(rows[0].applied_at)), false);
        } finally {
            store.close();
        }
    });

    test('PRAGMA foreign_keys is ON', async () => {
        const dir = await tempDataDir();
        const store = openStore({ dataDir: dir });
        try {
            const row = store.db.prepare('PRAGMA foreign_keys').get();
            assert.equal(Number(row.foreign_keys), 1);
        } finally {
            store.close();
        }
    });

    test('journal mode is WAL', async () => {
        const dir = await tempDataDir();
        const store = openStore({ dataDir: dir });
        try {
            const row = store.db.prepare('PRAGMA journal_mode').get();
            assert.equal(String(row.journal_mode).toLowerCase(), 'wal');
        } finally {
            store.close();
        }
    });

    test('reopen is idempotent: no migration re-runs, version stays 1, data survives', async () => {
        const dir = await tempDataDir();

        const first = openStore({ dataDir: dir });
        try {
            first.db.prepare(
                `INSERT INTO projects (id, name, backlog_member, beads_kind, beads_dir, beads_remote, beads_prefix, operator, created_at, updated_at)
                 VALUES (?, ?, ?, 'clone', ?, ?, ?, ?, ?, ?)`,
            ).run('p1', 'Project One', 'member-a', '/tmp/p1/.beads', 'git@example.com:o/beads.git', 'p1', 'op', 'now', 'now');
        } finally {
            first.close();
        }

        const second = openStore({ dataDir: dir });
        try {
            assert.equal(second.version, 1);
            assert.deepEqual(second.applied, [], 'reopen must apply no migrations');
            const rows = second.db.prepare('SELECT COUNT(*) AS n FROM schema_version').get();
            assert.equal(Number(rows.n), 1, 'schema_version must not gain a duplicate row');
            const project = second.db.prepare('SELECT id, name, beads_kind FROM projects WHERE id = ?').get('p1');
            assert.equal(project.name, 'Project One');
            assert.equal(project.beads_kind, 'clone');
        } finally {
            second.close();
        }

        const third = openStore({ dataDir: dir });
        try {
            assert.equal(third.version, 1);
            assert.deepEqual(third.applied, []);
        } finally {
            third.close();
        }
    });
});

describe('001-projects schema', { skip }, () => {
    /** @type {{db: any, close: () => void}} */
    let store;

    before(async () => {
        const dir = await tempDataDir();
        store = openStore({ dataDir: dir });
    });

    after(() => {
        store?.close();
    });

    test('creates the projects and member_git tables', () => {
        const names = store.db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .all()
            .map((r) => r.name);
        assert.ok(names.includes('projects'), `expected projects table, saw ${names.join(', ')}`);
        assert.ok(names.includes('member_git'), `expected member_git table, saw ${names.join(', ')}`);
        assert.ok(names.includes('schema_version'));
    });

    test('projects carries the beads binding columns', () => {
        const cols = store.db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
        for (const col of ['id', 'name', 'backlog_member', 'beads_kind', 'beads_dir', 'beads_remote', 'beads_prefix', 'operator', 'created_at', 'updated_at']) {
            assert.ok(cols.includes(col), `projects is missing column ${col}`);
        }
    });

    test('member_git carries the probe cache columns and a composite key', () => {
        const info = store.db.prepare('PRAGMA table_info(member_git)').all();
        const cols = info.map((c) => c.name);
        for (const col of ['project_id', 'member', 'origin_slug', 'origin_url', 'checkout_path', 'branch', 'upstream', 'probed_at']) {
            assert.ok(cols.includes(col), `member_git is missing column ${col}`);
        }
        const key = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
        assert.deepEqual(key, ['project_id', 'member']);
    });

    test('member_git rejects a row whose project does not exist', () => {
        assert.throws(
            () => store.db
                .prepare('INSERT INTO member_git (project_id, member) VALUES (?, ?)')
                .run('no-such-project', 'member-x'),
            /FOREIGN KEY/i,
        );
    });

    test('deleting a project cascades its member_git rows', () => {
        store.db.prepare(
            `INSERT INTO projects (id, name, backlog_member, beads_kind, beads_dir, created_at, updated_at)
             VALUES ('cascade', 'Cascade', 'm', 'clone', '/tmp/c/.beads', 'now', 'now')`,
        ).run();
        store.db.prepare(
            "INSERT INTO member_git (project_id, member, origin_slug) VALUES ('cascade', 'm', 'example.com/o/r')",
        ).run();
        assert.equal(Number(store.db.prepare("SELECT COUNT(*) AS n FROM member_git WHERE project_id = 'cascade'").get().n), 1);

        store.db.prepare("DELETE FROM projects WHERE id = 'cascade'").run();
        assert.equal(Number(store.db.prepare("SELECT COUNT(*) AS n FROM member_git WHERE project_id = 'cascade'").get().n), 0);
    });

    test('a member with no checkout is representable (checkout columns null)', () => {
        store.db.prepare(
            `INSERT INTO projects (id, name, backlog_member, beads_kind, beads_dir, created_at, updated_at)
             VALUES ('nocheckout', 'No Checkout', 'm', 'clone', '/tmp/n/.beads', 'now', 'now')`,
        ).run();
        store.db.prepare(
            "INSERT INTO member_git (project_id, member, probed_at) VALUES ('nocheckout', 'm', 'now')",
        ).run();
        const row = store.db.prepare("SELECT * FROM member_git WHERE project_id = 'nocheckout'").get();
        assert.equal(row.origin_slug, null);
        assert.equal(row.checkout_path, null);
        assert.equal(row.probed_at, 'now');
    });
});

describe('applyMigrations', { skip }, () => {
    test('applies migrations in ascending version order', async () => {
        const dir = await tempDataDir();
        const order = [];
        const fake = [
            { version: 3, name: 'c', up: () => order.push(3) },
            { version: 1, name: 'a', up: () => order.push(1) },
            { version: 2, name: 'b', up: () => order.push(2) },
        ];
        const store = openStore({ dataDir: dir, migrations: fake });
        try {
            assert.deepEqual(order, [1, 2, 3]);
            assert.deepEqual(store.applied, ['a', 'b', 'c']);
            assert.equal(store.version, 3);
        } finally {
            store.close();
        }
    });

    test('a later migration applied to an existing store bumps only the delta', async () => {
        const dir = await tempDataDir();
        const first = openStore({ dataDir: dir });
        let db;
        try {
            db = first.db;
            const result = applyMigrations(db, [
                ...MIGRATIONS,
                { version: 2, name: '002-extra', up: (d) => d.exec('CREATE TABLE extra (x TEXT)') },
            ]);
            assert.equal(result.from, 1);
            assert.equal(result.to, 2);
            assert.deepEqual(result.applied, ['002-extra']);
            const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='extra'").all();
            assert.equal(names.length, 1);
        } finally {
            first.close();
        }
    });

    test('a failing migration rolls back its DDL and records no version row', async () => {
        const dir = await tempDataDir();
        const boom = [
            { version: 1, name: 'ok', up: (d) => d.exec('CREATE TABLE kept (x TEXT)') },
            {
                version: 2,
                name: 'bad',
                up: (d) => {
                    d.exec('CREATE TABLE half (x TEXT)');
                    throw new Error('deliberate failure');
                },
            },
        ];
        assert.throws(
            () => openStore({ dataDir: dir, migrations: boom }),
            /migration 2 \(bad\) failed/,
        );

        const store = openStore({ dataDir: dir, migrations: [boom[0]] });
        try {
            assert.equal(store.version, 1, 'the failed migration must not be recorded');
            const half = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='half'").all();
            assert.equal(half.length, 0, 'the failed migration DDL must be rolled back');
            const kept = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kept'").all();
            assert.equal(kept.length, 1, 'the earlier committed migration must survive');
        } finally {
            store.close();
        }
    });

    test('rejects duplicate migration versions', async () => {
        const dir = await tempDataDir();
        assert.throws(
            () => openStore({
                dataDir: dir,
                migrations: [
                    { version: 1, name: 'a', up: () => {} },
                    { version: 1, name: 'b', up: () => {} },
                ],
            }),
            /duplicate migration version 1/,
        );
    });

    test('rejects a malformed migration module', async () => {
        const dir = await tempDataDir();
        assert.throws(
            () => openStore({ dataDir: dir, migrations: [{ version: 1, name: 'a' }] }),
            /must export an up\(db\) function/,
        );
        assert.throws(
            () => openStore({ dataDir: dir, migrations: [{ version: 0, name: 'a', up: () => {} }] }),
            /integer version >= 1/,
        );
    });
});

describe('node:sqlite guard', () => {
    test('NodeSqliteUnavailableError names the runtime, the floor and the remedy', () => {
        const err = new NodeSqliteUnavailableError(new Error('No such built-in module'));
        assert.equal(err.code, 'ERR_NODE_SQLITE_UNAVAILABLE');
        assert.match(err.message, /node:sqlite is not available/);
        assert.ok(err.message.includes(process.version), 'message should name the running Node version');
        assert.match(err.message, /22\.13\.0/);
        assert.match(err.message, /Upgrade Node/);
    });

    test('isNodeSqliteAvailable never throws and agrees with openStore', async () => {
        const available = isNodeSqliteAvailable();
        assert.equal(typeof available, 'boolean');
        const dir = await tempDataDir();
        if (available) {
            const store = openStore({ dataDir: dir });
            store.close();
        } else {
            assert.throws(() => openStore({ dataDir: dir }), { code: 'ERR_NODE_SQLITE_UNAVAILABLE' });
        }
    });
});
