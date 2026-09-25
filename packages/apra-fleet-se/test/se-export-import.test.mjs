import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { isNodeSqliteAvailable, openStore } from '../src/projects/store/db.mjs';
import { createProject, getProject } from '../src/projects/store/projects.mjs';
import { listMemberGit, upsertMemberGit } from '../src/projects/store/member-git.mjs';
import { createLedger } from '../src/supervisor/ledger.mjs';
import { exportProject, importProject } from '../bin/se.mjs';

// =============================================================================
// apra-fleet-vcnl.4.2 -- se-export-import.test.mjs
//
// Coverage for bin/se.mjs's exportProject()/importProject() functions plus a
// CLI smoke test. Every case drives its own temp data dir(s) via fs.mkdtemp
// (never the real ~/.apra-fleet-se) and closes/cleans up in after().
//
// node:sqlite is a Node builtin only from 22.13.0 -- this suite skips cleanly
// on an older runtime rather than failing with an opaque require error, same
// convention as projects-store.test.mjs.
// =============================================================================

const HAS_SQLITE = isNodeSqliteAvailable();
const skip = HAS_SQLITE ? false : 'node:sqlite is unavailable on this Node runtime';

const execFileAsync = promisify(execFile);
const SE_BIN = fileURLToPath(new URL('../bin/se.mjs', import.meta.url));

/** @type {string[]} */
const tmpDirs = [];
/** @type {Array<{close: () => void}>} */
const openStores = [];

async function tempDataDir() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'apra-fleet-se-export-'));
    tmpDirs.push(dir);
    return dir;
}

function openTempStore(dataDir) {
    const store = openStore({ dataDir });
    openStores.push(store);
    return store;
}

/**
 * Spawn `bin/se.mjs <args>` and resolve with its outcome instead of throwing
 * on a non-zero exit, so callers can assert on the exit-code contract
 * directly (0 ok, 1 usage, 2 unknown project/bad file, 3 refused).
 *
 * util.promisify(execFile) resolves {stdout, stderr} on exit 0; on a
 * non-zero exit it REJECTS with an error decorated with the same `.code`
 * (the child's exit code, not an errno string here) plus `.stdout`/`.stderr`
 * -- see Node's child_process docs for execFile's promisified form.
 *
 * NODE_TEST_CONTEXT is stripped from the child's env: it is set by the
 * OUTER `node --test` run executing THIS file, and if inherited,
 * se.mjs's isMainModule() guard treats the child as a reporter-driven
 * grandchild and silently no-ops instead of actually running the command.
 */
async function spawnSe(args) {
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    try {
        const { stdout, stderr } = await execFileAsync(process.execPath, [SE_BIN, ...args], {
            encoding: 'utf8',
            env: childEnv,
        });
        return { code: 0, stdout, stderr };
    } catch (err) {
        return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
}

after(async () => {
    for (const s of openStores) {
        try { s.close(); } catch { /* best-effort */ }
    }
    for (const dir of tmpDirs) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
});

/** Shallow clone of `obj` with the given keys removed, for "deep-equal modulo X" assertions. */
function omit(obj, keys) {
    const out = { ...obj };
    for (const k of keys) delete out[k];
    return out;
}

describe('se-export-import', { skip }, () => {
    test('round-trip: export from data dir A imports cleanly into empty data dir B', async () => {
        const dirA = await tempDataDir();
        const storeA = openTempStore(dirA);
        const ledgerA = createLedger({ dataDir: dirA });
        await ledgerA.start();

        createProject(storeA.db, {
            id: 'rt-1',
            name: 'Round Trip One',
            backlogMember: 'member-a',
            beads: { kind: 'clone', dir: '/tmp/rt-1/.beads', remote: 'git@example.com:o/beads.git', prefix: 'rt1' },
            operator: 'op-a',
        });
        upsertMemberGit(storeA.db, {
            projectId: 'rt-1',
            member: 'member-a',
            originSlug: 'example.com/o/r',
            originUrl: 'git@example.com:o/r.git',
            checkoutPath: '/home/member-a/r',
            branch: 'main',
            dirty: false,
            probedAt: '2026-01-01T00:00:00.000Z',
        });
        upsertMemberGit(storeA.db, {
            projectId: 'rt-1',
            member: 'member-b',
            originSlug: 'example.com/o/r2',
            branch: 'feature-x',
            dirty: true,
            probedAt: '2026-01-01T00:00:01.000Z',
        });

        const exported = exportProject({ db: storeA.db, ledger: ledgerA, projectId: 'rt-1' });
        assert.equal(exported.format, 'apra-fleet-se/project-export@1');
        assert.equal(exported.project.id, 'rt-1');
        assert.equal(exported.memberGit.length, 2);

        const originalProject = getProject(storeA.db, 'rt-1');
        const originalMemberGit = listMemberGit(storeA.db, 'rt-1');

        const dirB = await tempDataDir();
        const storeB = openTempStore(dirB);
        const ledgerB = createLedger({ dataDir: dirB });
        await ledgerB.start();

        importProject({ db: storeB.db, ledger: ledgerB, data: exported });

        const importedProject = getProject(storeB.db, 'rt-1');
        const importedMemberGit = listMemberGit(storeB.db, 'rt-1');

        // `updatedAt` is excluded because importing into an EMPTY store B
        // creates a brand-new row via createProject(), which always stamps
        // "now" into updated_at regardless of the export -- that field
        // legitimately reflects when the row was written into B, not A's
        // original last-update time.
        //
        // `createdAt`, in contrast, round-trips losslessly (apra-fleet-vcnl.8):
        // createProject() now accepts an explicit `createdAt` and
        // importProject() forwards the export's project.createdAt through on
        // the create path, so restoring a committed .fleet/project.json into
        // a fresh machine preserves the project's ORIGINAL creation time
        // instead of silently overwriting it with the import moment.
        assert.deepEqual(
            omit(importedProject, ['updatedAt']),
            omit(originalProject, ['updatedAt']),
            'imported project must deep-equal the original modulo updatedAt (createdAt must survive the round trip)',
        );
        assert.deepEqual(
            importedMemberGit,
            originalMemberGit,
            'imported member_git rows must deep-equal the original set (probedAt is caller-supplied, not regenerated)',
        );

        await ledgerA.stop();
        await ledgerB.stop();
    });

    test('import is an upsert: updates fields on a second import, no duplicate member_git rows, third import is a no-op', async () => {
        const dirA = await tempDataDir();
        const storeA = openTempStore(dirA);
        const ledgerA = createLedger({ dataDir: dirA });
        await ledgerA.start();

        createProject(storeA.db, {
            id: 'upsert-1',
            name: 'Upsert One',
            backlogMember: 'member-a',
            beads: { dir: '/tmp/upsert-1/.beads' },
        });
        upsertMemberGit(storeA.db, { projectId: 'upsert-1', member: 'member-a', branch: 'main' });
        const firstExport = exportProject({ db: storeA.db, ledger: ledgerA, projectId: 'upsert-1' });

        const dirB = await tempDataDir();
        const storeB = openTempStore(dirB);
        const ledgerB = createLedger({ dataDir: dirB });
        await ledgerB.start();

        importProject({ db: storeB.db, ledger: ledgerB, data: firstExport });
        assert.equal(getProject(storeB.db, 'upsert-1').name, 'Upsert One');
        assert.equal(listMemberGit(storeB.db, 'upsert-1').length, 1);

        // Change the source project, re-export, and import again: fields
        // must update in place, member_git rows must not duplicate.
        upsertMemberGit(storeA.db, { projectId: 'upsert-1', member: 'member-a', branch: 'renamed-branch' });
        const updatedInDb = { ...getProject(storeA.db, 'upsert-1') };
        // Simulate a rename by exporting a patched copy of the project payload.
        const secondExport = {
            ...firstExport,
            project: { ...updatedInDb, name: 'Upsert One Renamed' },
            memberGit: listMemberGit(storeA.db, 'upsert-1'),
        };

        importProject({ db: storeB.db, ledger: ledgerB, data: secondExport });
        const afterSecond = getProject(storeB.db, 'upsert-1');
        assert.equal(afterSecond.name, 'Upsert One Renamed');
        const memberGitAfterSecond = listMemberGit(storeB.db, 'upsert-1');
        assert.equal(memberGitAfterSecond.length, 1, 'second import must not duplicate the member_git row');
        assert.equal(memberGitAfterSecond[0].branch, 'renamed-branch');

        // Importing the SAME (already-applied) export again is a no-op:
        // fields stay the same, row count stays the same.
        importProject({ db: storeB.db, ledger: ledgerB, data: secondExport });
        const afterThird = getProject(storeB.db, 'upsert-1');
        assert.equal(afterThird.name, 'Upsert One Renamed');
        assert.equal(listMemberGit(storeB.db, 'upsert-1').length, 1, 'third (repeat) import must not duplicate rows');

        await ledgerA.stop();
        await ledgerB.stop();
    });

    test('refusal: a live ledger reservation covering a bound member refuses import; exitedAt lets it proceed', async () => {
        const dirA = await tempDataDir();
        const storeA = openTempStore(dirA);
        const ledgerA = createLedger({ dataDir: dirA });
        await ledgerA.start();

        createProject(storeA.db, {
            id: 'refuse-1',
            name: 'Refuse One',
            backlogMember: 'member-a',
            beads: { dir: '/tmp/refuse-1/.beads' },
        });
        upsertMemberGit(storeA.db, { projectId: 'refuse-1', member: 'member-a', branch: 'main' });
        const exported = exportProject({ db: storeA.db, ledger: ledgerA, projectId: 'refuse-1' });

        const dirB = await tempDataDir();
        const storeB = openTempStore(dirB);
        const ledgerB = createLedger({ dataDir: dirB });
        await ledgerB.start();

        // A live run in B (no exitedAt) whose members overlap the imported
        // project's backlogMember must refuse the import outright.
        await ledgerB.claim('live-sprint-1', { members: ['member-a'] });

        assert.throws(
            () => importProject({ db: storeB.db, ledger: ledgerB, data: exported }),
            { code: 'ERR_LIVE_RUN' },
        );
        assert.equal(getProject(storeB.db, 'refuse-1'), null, 'B\'s store must be unchanged after a refused import');
        assert.equal(listMemberGit(storeB.db, 'refuse-1').length, 0, 'B\'s store must be unchanged after a refused import');

        // Marking that same reservation exited lifts the refusal.
        await ledgerB.recordExit('live-sprint-1', {});
        const imported = importProject({ db: storeB.db, ledger: ledgerB, data: exported });
        assert.equal(imported.id, 'refuse-1');
        assert.equal(getProject(storeB.db, 'refuse-1').id, 'refuse-1');

        await ledgerA.stop();
        await ledgerB.stop();
    });

    test('refusal covers a member bound in the TARGET store even when the import payload never names it', async () => {
        // Regression for apra-fleet-vcnl.7: importProject() used to build its
        // affected-member set entirely from the incoming payload
        // (backlogMember + memberGit[].member). If a live reservation holds a
        // member that is bound to project P in the TARGET store but does NOT
        // appear in the file being imported, the refusal must still fire --
        // otherwise import silently rewrites P's row out from under a
        // running sprint on that resident member.
        const dirA = await tempDataDir();
        const storeA = openTempStore(dirA);
        const ledgerA = createLedger({ dataDir: dirA });
        await ledgerA.start();

        createProject(storeA.db, {
            id: 'resident-1',
            name: 'Resident One',
            backlogMember: 'member-y',
            beads: { dir: '/tmp/resident-1/.beads' },
        });
        // Export only mentions member-y -- NOT member-x.
        upsertMemberGit(storeA.db, { projectId: 'resident-1', member: 'member-y', branch: 'main' });
        const exported = exportProject({ db: storeA.db, ledger: ledgerA, projectId: 'resident-1' });
        assert.ok(
            !exported.memberGit.some((mg) => mg.member === 'member-x')
                && exported.project.backlogMember !== 'member-x',
            'sanity: the export payload must not name member-x anywhere',
        );

        const dirB = await tempDataDir();
        const storeB = openTempStore(dirB);
        const ledgerB = createLedger({ dataDir: dirB });
        await ledgerB.start();

        // Store B already has the SAME project bound to member-x (e.g. it
        // was bound after this export was taken, or was pruned from it).
        createProject(storeB.db, {
            id: 'resident-1',
            name: 'Resident One (in B)',
            backlogMember: 'member-x',
            beads: { dir: '/tmp/resident-1/.beads' },
        });
        upsertMemberGit(storeB.db, { projectId: 'resident-1', member: 'member-x', branch: 'main' });

        // A live run in B holds member-x.
        await ledgerB.claim('live-sprint-resident', { members: ['member-x'] });

        const beforeProject = getProject(storeB.db, 'resident-1');
        const beforeMemberGit = listMemberGit(storeB.db, 'resident-1');

        assert.throws(
            () => importProject({ db: storeB.db, ledger: ledgerB, data: exported }),
            { code: 'ERR_LIVE_RUN' },
        );

        assert.deepEqual(
            getProject(storeB.db, 'resident-1'),
            beforeProject,
            'B\'s resident project row must be unchanged after the refused import',
        );
        assert.deepEqual(
            listMemberGit(storeB.db, 'resident-1'),
            beforeMemberGit,
            'B\'s resident member_git rows must be unchanged after the refused import',
        );

        await ledgerA.stop();
        await ledgerB.stop();
    });

    test('export of an unknown project and import of a wrong-format file both fail without writing anything', async () => {
        const dirA = await tempDataDir();
        const storeA = openTempStore(dirA);
        const ledgerA = createLedger({ dataDir: dirA });
        await ledgerA.start();

        assert.throws(
            () => exportProject({ db: storeA.db, ledger: ledgerA, projectId: 'no-such-project' }),
            { code: 'ERR_PROJECT_NOT_FOUND' },
        );

        const dirB = await tempDataDir();
        const storeB = openTempStore(dirB);
        const ledgerB = createLedger({ dataDir: dirB });
        await ledgerB.start();

        assert.throws(
            () => importProject({ db: storeB.db, ledger: ledgerB, data: { format: 'not-the-right-format', project: {} } }),
            { code: 'ERR_BAD_FORMAT' },
        );
        assert.equal(getProject(storeB.db, 'no-such-project'), null);

        // A malformed export missing the `project` field is also ERR_BAD_FORMAT.
        assert.throws(
            () => importProject({
                db: storeB.db,
                ledger: ledgerB,
                data: { format: 'apra-fleet-se/project-export@1' },
            }),
            { code: 'ERR_BAD_FORMAT' },
        );

        await ledgerA.stop();
        await ledgerB.stop();
    });

    test('history: the export always carries an empty history array (no run-history table exists yet)', async () => {
        // bin/se.mjs accepts --with-history as a forward-compat no-op: the
        // underlying history table does not exist in supervisor.sqlite yet,
        // so exportProject() unconditionally returns `history: []` with a
        // note explaining why, regardless of whether the flag is passed.
        // This case exercises the flag-less default path at the function
        // level; the CLI-level "--with-history" case below exercises the
        // flag actually being passed through parseArgs.
        const dirA = await tempDataDir();
        const storeA = openTempStore(dirA);
        const ledgerA = createLedger({ dataDir: dirA });
        await ledgerA.start();

        createProject(storeA.db, {
            id: 'hist-1',
            name: 'History One',
            backlogMember: 'member-a',
            beads: { dir: '/tmp/hist-1/.beads' },
        });

        const exported = exportProject({ db: storeA.db, ledger: ledgerA, projectId: 'hist-1' });
        assert.deepEqual(exported.history, [], 'default export must carry an empty history array, not run data');
        assert.equal(typeof exported.note, 'string');

        await ledgerA.stop();
    });

    test('CLI smoke: spawning bin/se.mjs export <id> --data-dir <dir> prints the export as JSON on stdout', async () => {
        const dir = await tempDataDir();
        const store = openTempStore(dir);
        createProject(store.db, {
            id: 'cli-1',
            name: 'CLI One',
            backlogMember: 'member-a',
            beads: { dir: '/tmp/cli-1/.beads' },
        });
        // Release the in-process handle before the child process opens the
        // same sqlite file, so there's exactly one live connection at a time.
        store.close();
        openStores.splice(openStores.indexOf(store), 1);

        // NODE_TEST_CONTEXT is set by the OUTER `node --test` run executing
        // THIS file; if inherited, se.mjs's isMainModule() guard treats the
        // child as a reporter-driven grandchild and silently no-ops instead
        // of actually running export -- see bin/se.mjs's isMainModule() and
        // the same convention in supervisor-dashboard-backlog-no-live-spawn.test.mjs.
        const childEnv = { ...process.env };
        delete childEnv.NODE_TEST_CONTEXT;

        const { stdout } = await execFileAsync(
            process.execPath,
            [SE_BIN, 'export', 'cli-1', '--data-dir', dir],
            { encoding: 'utf8', env: childEnv },
        );

        const parsed = JSON.parse(stdout);
        assert.equal(parsed.format, 'apra-fleet-se/project-export@1');
        assert.equal(parsed.project.id, 'cli-1');
        assert.equal(parsed.project.name, 'CLI One');
        assert.deepEqual(parsed.history, []);
    });

    test('CLI exit codes: usage error (1) for no args and an unknown flag', async () => {
        let result = await spawnSe([]);
        assert.equal(result.code, 1, 'no args must exit 1');

        const dir = await tempDataDir();
        result = await spawnSe(['export', 'anything', '--bogus-flag', '--data-dir', dir]);
        assert.equal(result.code, 1, 'an unknown flag must exit 1');
    });

    test('CLI exit codes: operational error (2) for an unknown project and a wrong-format file', async () => {
        const dirUnknown = await tempDataDir();
        let result = await spawnSe(['export', 'no-such-project', '--data-dir', dirUnknown]);
        assert.equal(result.code, 2, 'export of an unknown project must exit 2');

        const dirBadFormat = await tempDataDir();
        const badFile = path.join(dirBadFormat, 'bad-export.json');
        await fsp.writeFile(
            badFile,
            JSON.stringify({ format: 'not-the-right-format', project: {} }),
            'utf-8',
        );
        result = await spawnSe(['import', badFile, '--data-dir', dirBadFormat]);
        assert.equal(result.code, 2, 'import of a wrong-format file must exit 2');
    });

    test('CLI exit codes: a live ledger reservation makes import refuse with exit code 3', async () => {
        const dir = await tempDataDir();
        const store = openTempStore(dir);
        const ledger = createLedger({ dataDir: dir });
        await ledger.start();

        createProject(store.db, {
            id: 'cli-live-1',
            name: 'CLI Live One',
            backlogMember: 'member-live',
            beads: { dir: '/tmp/cli-live-1/.beads' },
        });
        const liveExport = exportProject({ db: store.db, ledger, projectId: 'cli-live-1' });

        // A live run (no exitedAt) whose members overlap the exported
        // project's backlogMember must make the CLI's import subcommand
        // exit 3, not just throw ERR_LIVE_RUN in-process.
        await ledger.claim('live-sprint-cli', { members: ['member-live'] });
        await ledger.stop();

        // Release the in-process handle before the child process opens the
        // same sqlite/ledger files, so there's exactly one live connection
        // at a time (same convention as the CLI smoke test above).
        store.close();
        openStores.splice(openStores.indexOf(store), 1);

        const exportFile = path.join(dir, 'export.json');
        await fsp.writeFile(exportFile, JSON.stringify(liveExport), 'utf-8');

        const result = await spawnSe(['import', exportFile, '--data-dir', dir]);
        assert.equal(result.code, 3, 'import must refuse with exit 3 while the reservation is live');
    });

    test('CLI: --with-history is an accepted no-op flag; export still carries an empty history array', async () => {
        const dir = await tempDataDir();
        const store = openTempStore(dir);
        createProject(store.db, {
            id: 'hist-cli-1',
            name: 'History CLI One',
            backlogMember: 'member-a',
            beads: { dir: '/tmp/hist-cli-1/.beads' },
        });
        store.close();
        openStores.splice(openStores.indexOf(store), 1);

        const result = await spawnSe(['export', 'hist-cli-1', '--with-history', '--data-dir', dir]);
        assert.equal(result.code, 0, '--with-history must not be a usage error');
        const parsed = JSON.parse(result.stdout);
        assert.equal(parsed.project.id, 'hist-cli-1');
        assert.deepEqual(parsed.history, [], '--with-history must still emit an empty history array');
    });
});
