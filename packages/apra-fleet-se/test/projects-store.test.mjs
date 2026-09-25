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
import {
    StoreValidationError,
    createProject,
    deleteProject,
    getProject,
    listProjects,
    updateProject,
} from '../src/projects/store/projects.mjs';
import {
    deleteMemberGit,
    getMemberGit,
    listMemberGit,
    upsertMemberGit,
} from '../src/projects/store/member-git.mjs';

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

describe('projects repository', { skip }, () => {
    /** @type {{db: any, close: () => void}} */
    let store;

    before(async () => {
        const dir = await tempDataDir();
        store = openStore({ dataDir: dir });
    });

    after(() => {
        store?.close();
    });

    test('createProject round-trips through getProject', () => {
        const created = createProject(store.db, {
            id: 'crud-1',
            name: 'CRUD One',
            backlogMember: 'member-a',
            beads: { kind: 'clone', dir: '/tmp/crud-1/.beads', remote: 'git@example.com:o/beads.git', prefix: 'c1' },
            operator: 'op-a',
        });
        assert.equal(created.id, 'crud-1');
        assert.equal(created.beads.kind, 'clone');
        assert.equal(typeof created.createdAt, 'string');
        assert.equal(created.createdAt, created.updatedAt);

        const fetched = getProject(store.db, 'crud-1');
        assert.deepEqual(fetched, created);
    });

    test('createProject accepts an explicit createdAt (apra-fleet-vcnl.8), but updatedAt always gets "now"', () => {
        const explicitCreatedAt = '2020-01-01T00:00:00.000Z';
        const before = new Date();
        const created = createProject(store.db, {
            id: 'crud-explicit-created-at',
            name: 'Explicit CreatedAt',
            backlogMember: 'member-a',
            beads: { dir: '/tmp/crud-explicit-created-at/.beads' },
            createdAt: explicitCreatedAt,
        });
        assert.equal(created.createdAt, explicitCreatedAt, 'explicit createdAt must be used verbatim');
        assert.notEqual(created.updatedAt, explicitCreatedAt, 'updatedAt must still be stamped to "now", not the explicit createdAt');
        assert.ok(
            new Date(created.updatedAt) >= before,
            'updatedAt must reflect the moment of this create call',
        );

        const fetched = getProject(store.db, 'crud-explicit-created-at');
        assert.equal(fetched.createdAt, explicitCreatedAt);
    });

    test('createProject rejects an empty-string createdAt with {field: "createdAt"}', () => {
        assert.throws(
            () => createProject(store.db, {
                id: 'crud-bad-created-at',
                name: 'Bad CreatedAt',
                backlogMember: 'member-a',
                beads: { dir: '/tmp/crud-bad-created-at/.beads' },
                createdAt: '',
            }),
            (err) => {
                assert.equal(err.field, 'createdAt');
                return true;
            },
        );
    });

    test('createProject defaults beads.kind to clone when omitted', () => {
        const created = createProject(store.db, {
            id: 'crud-default-kind',
            name: 'Default Kind',
            backlogMember: 'member-a',
            beads: { dir: '/tmp/crud-default-kind/.beads' },
        });
        assert.equal(created.beads.kind, 'clone');
        assert.equal(created.beads.remote, null);
        assert.equal(created.operator, null);
    });

    test('getProject returns null for a missing id', () => {
        assert.equal(getProject(store.db, 'no-such-project'), null);
    });

    test('listProjects returns every project ordered by id', () => {
        createProject(store.db, {
            id: 'crud-list-b',
            name: 'List B',
            backlogMember: 'member-b',
            beads: { dir: '/tmp/list-b/.beads' },
        });
        createProject(store.db, {
            id: 'crud-list-a',
            name: 'List A',
            backlogMember: 'member-a',
            beads: { dir: '/tmp/list-a/.beads' },
        });
        const ids = listProjects(store.db).map((p) => p.id);
        const listIndexA = ids.indexOf('crud-list-a');
        const listIndexB = ids.indexOf('crud-list-b');
        assert.ok(listIndexA >= 0 && listIndexB >= 0);
        assert.ok(listIndexA < listIndexB, 'expected ascending id order');
    });

    test('createProject rejects a missing required field with {field, reason}', () => {
        assert.throws(
            () => createProject(store.db, { id: 'bad', name: '', backlogMember: 'm', beads: { dir: '/tmp/bad' } }),
            (err) => {
                assert.ok(err instanceof StoreValidationError);
                assert.ok(err.errors.some((e) => e.field === 'name'));
                return true;
            },
        );
    });

    test('createProject rejects a missing beads.dir', () => {
        assert.throws(
            () => createProject(store.db, { id: 'bad2', name: 'Bad Two', backlogMember: 'm', beads: {} }),
            (err) => {
                assert.ok(err instanceof StoreValidationError);
                assert.ok(err.errors.some((e) => e.field === 'beads.dir'));
                return true;
            },
        );
    });

    test('createProject rejects a duplicate id', () => {
        createProject(store.db, {
            id: 'dup-1', name: 'Dup', backlogMember: 'm', beads: { dir: '/tmp/dup-1' },
        });
        assert.throws(() => createProject(store.db, {
            id: 'dup-1', name: 'Dup Again', backlogMember: 'm', beads: { dir: '/tmp/dup-1' },
        }));
    });

    test('updateProject patches only the given fields and bumps updated_at', async () => {
        const created = createProject(store.db, {
            id: 'upd-1',
            name: 'Update One',
            backlogMember: 'member-a',
            beads: { dir: '/tmp/upd-1/.beads', remote: 'git@example.com:o/r.git' },
            operator: 'op-a',
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        const updated = updateProject(store.db, 'upd-1', { name: 'Update One Renamed' });
        assert.equal(updated.name, 'Update One Renamed');
        assert.equal(updated.backlogMember, created.backlogMember);
        assert.equal(updated.beads.remote, created.beads.remote);
        assert.equal(updated.operator, created.operator);
        assert.notEqual(updated.updatedAt, created.updatedAt);
        assert.equal(updated.createdAt, created.createdAt);
    });

    test('updateProject rejects a malformed field', () => {
        createProject(store.db, { id: 'upd-bad', name: 'Upd Bad', backlogMember: 'm', beads: { dir: '/tmp/upd-bad' } });
        assert.throws(
            () => updateProject(store.db, 'upd-bad', { name: '' }),
            (err) => {
                assert.ok(err instanceof StoreValidationError);
                assert.ok(err.errors.some((e) => e.field === 'name'));
                return true;
            },
        );
    });

    test('updateProject throws ERR_PROJECT_NOT_FOUND for a missing id', () => {
        assert.throws(
            () => updateProject(store.db, 'no-such-project', { name: 'x' }),
            { code: 'ERR_PROJECT_NOT_FOUND' },
        );
    });

    test('deleteProject removes the row and cascades member_git (delete cascades, per doc s4.3)', () => {
        createProject(store.db, { id: 'del-1', name: 'Del One', backlogMember: 'm', beads: { dir: '/tmp/del-1' } });
        upsertMemberGit(store.db, { projectId: 'del-1', member: 'm' });
        assert.equal(listMemberGit(store.db, 'del-1').length, 1);

        const result = deleteProject(store.db, 'del-1');
        assert.equal(result, true);
        assert.equal(getProject(store.db, 'del-1'), null);
        assert.equal(listMemberGit(store.db, 'del-1').length, 0, 'member_git rows must cascade-delete with their project');
    });

    test('deleteProject returns false for a missing id', () => {
        assert.equal(deleteProject(store.db, 'no-such-project'), false);
    });
});

describe('member_git repository', { skip }, () => {
    /** @type {{db: any, close: () => void}} */
    let store;

    before(async () => {
        const dir = await tempDataDir();
        store = openStore({ dataDir: dir });
        createProject(store.db, { id: 'mg-p1', name: 'MG P1', backlogMember: 'member-a', beads: { dir: '/tmp/mg-p1' } });
    });

    after(() => {
        store?.close();
    });

    test('upsertMemberGit inserts then round-trips through getMemberGit', () => {
        const row = upsertMemberGit(store.db, {
            projectId: 'mg-p1',
            member: 'member-a',
            originSlug: 'example.com/o/r',
            originUrl: 'git@example.com:o/r.git',
            checkoutPath: '/home/member-a/r',
            branch: 'main',
            upstream: 'origin/main',
            dirty: true,
            worktrees: [{ path: '/home/member-a/r', branch: 'main' }],
            playbooks: ['deploy.md'],
            bibleCommit: 'abc123',
            statusJson: { ok: true },
            probedAt: '2026-01-01T00:00:00.000Z',
        });
        assert.equal(row.projectId, 'mg-p1');
        assert.equal(row.member, 'member-a');
        assert.equal(row.dirty, true);
        assert.deepEqual(row.worktrees, [{ path: '/home/member-a/r', branch: 'main' }]);
        assert.deepEqual(row.playbooks, ['deploy.md']);
        assert.deepEqual(row.statusJson, { ok: true });

        const fetched = getMemberGit(store.db, 'mg-p1', 'member-a');
        assert.deepEqual(fetched, row);
    });

    test('upsertMemberGit on the same (project, member) replaces the row rather than duplicating it', () => {
        upsertMemberGit(store.db, { projectId: 'mg-p1', member: 'member-upsert', branch: 'main', dirty: false });
        upsertMemberGit(store.db, { projectId: 'mg-p1', member: 'member-upsert', branch: 'feature-x', dirty: true });

        const rows = listMemberGit(store.db, 'mg-p1').filter((r) => r.member === 'member-upsert');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].branch, 'feature-x');
        assert.equal(rows[0].dirty, true);
    });

    test('upsertMemberGit represents a member with no checkout (nullable columns)', () => {
        const row = upsertMemberGit(store.db, { projectId: 'mg-p1', member: 'member-nocheckout', probedAt: 'now' });
        assert.equal(row.originSlug, null);
        assert.equal(row.checkoutPath, null);
        assert.equal(row.worktrees, null);
        assert.equal(row.probedAt, 'now');
    });

    test('getMemberGit returns null for a missing composite key', () => {
        assert.equal(getMemberGit(store.db, 'mg-p1', 'no-such-member'), null);
    });

    test('listMemberGit returns every row for a project ordered by member', () => {
        upsertMemberGit(store.db, { projectId: 'mg-p1', member: 'z-member' });
        upsertMemberGit(store.db, { projectId: 'mg-p1', member: 'a-member' });
        const members = listMemberGit(store.db, 'mg-p1').map((r) => r.member);
        assert.ok(members.indexOf('a-member') < members.indexOf('z-member'));
    });

    test('upsertMemberGit rejects a missing required field with {field, reason}', () => {
        assert.throws(
            () => upsertMemberGit(store.db, { projectId: 'mg-p1' }),
            (err) => {
                assert.ok(err instanceof StoreValidationError);
                assert.ok(err.errors.some((e) => e.field === 'member'));
                return true;
            },
        );
    });

    test('upsertMemberGit rejects a row whose project does not exist (FK violation surfaced as {field, reason})', () => {
        assert.throws(
            () => upsertMemberGit(store.db, { projectId: 'no-such-project', member: 'member-x' }),
            (err) => {
                assert.ok(err instanceof StoreValidationError);
                assert.equal(err.field, 'projectId');
                assert.match(err.reason, /does not exist/);
                return true;
            },
        );
    });

    test('deleteMemberGit removes a single row without touching its project', () => {
        upsertMemberGit(store.db, { projectId: 'mg-p1', member: 'member-del' });
        assert.equal(deleteMemberGit(store.db, 'mg-p1', 'member-del'), true);
        assert.equal(getMemberGit(store.db, 'mg-p1', 'member-del'), null);
        assert.notEqual(getProject(store.db, 'mg-p1'), null, 'deleting a member_git row must not delete its project');
    });

    test('deleteMemberGit returns false for a missing composite key', () => {
        assert.equal(deleteMemberGit(store.db, 'mg-p1', 'no-such-member'), false);
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
