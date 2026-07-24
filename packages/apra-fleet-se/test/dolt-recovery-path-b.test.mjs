import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    recoverDoltConflictPathB,
    isBootstrapEmptyDbFailure,
    hasSyncRemoteInYaml,
    DEFAULT_PATH_B_REMOVE_PATHS,
    DEFAULT_CONFIG_PATH,
    DEFAULT_EMBEDDED_DATA_DIR,
} from '../auto-sprint/dolt-recovery-path-b.mjs';
import { DoltSyncError, DoltDivergedError } from '../auto-sprint/errors.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-eft.9.5 -- Path B: discard-and-re-bootstrap fallback dolt
// conflict recovery, with mutation replay and the two verified Windows
// gotchas guarded.
//
// These tests drive the full runbook against an in-memory stateful fixture
// (fake filesystem + fake command()) so no real dolt/git/filesystem is ever
// touched, the same dependency-injection posture as the Path A suite. They
// assert:
//   - the happy path removes exactly the three paths (never config.yaml),
//     re-bootstraps, replays the one pending mutation, and republishes;
//   - config.yaml with sync.remote is preserved and asserted BEFORE anything
//     is touched (Windows gotcha #1 guard) -- missing/absent sync.remote
//     aborts loudly instead of proceeding blind;
//   - the leftover-empty-DB bootstrap failure (Windows gotcha #2) is
//     recovered via exactly one bounded retry after removing embeddeddolt
//     again; any OTHER bootstrap failure is NOT retried and throws;
//   - discarded local state is enumerated (logged), never silently dropped;
//   - a failed mutation replay or a still-rejected republish push throws.
// =============================================================================

function makeFixture({
    configExists = true,
    configHasRemote = true,
    backupEntries = ['note.json'],
    bootstrapOk = true,
    bootstrapEmptyDbThenOk = false,
    pushOk = true,
    replayOk = true,
} = {}) {
    const removedPaths = [];
    const cmdCalls = [];
    let bootstrapAttempts = 0;

    const command = async (cmd, opts = {}) => {
        cmdCalls.push({ cmd, opts });
        if (cmd.includes('bd bootstrap')) {
            bootstrapAttempts += 1;
            if (bootstrapEmptyDbThenOk) {
                if (bootstrapAttempts === 1) {
                    return { ok: false, output: '', error: 'directory not empty: leftover data' };
                }
                return { ok: true, output: '', error: null };
            }
            return bootstrapOk ? { ok: true, output: '', error: null } : { ok: false, output: '', error: 'bootstrap: unrecognized fatal error' };
        }
        if (cmd.includes('bd dolt push')) {
            return pushOk ? { ok: true, output: '', error: null } : { ok: false, output: '', error: 'updates were rejected' };
        }
        // any other command is treated as the replayed mutation
        return replayOk ? { ok: true, output: '', error: null } : { ok: false, output: '', error: 'mutation replay failed' };
    };

    const readConfig = async () => {
        if (!configExists) return { exists: false, raw: null, hasSyncRemote: false };
        const raw = configHasRemote ? 'sync:\n  remote: origin\n' : 'sync:\n  remote:\n';
        return { exists: true, raw, hasSyncRemote: configHasRemote };
    };

    const removePath = async (p) => { removedPaths.push(p); };

    const listLocalState = async () => (backupEntries.length > 0
        ? [`local backup dir '.beads/backup' contains ${backupEntries.length} file(s), about to be discarded: ${backupEntries.join(', ')}`]
        : [`local backup dir '.beads/backup' is empty (nothing else to discard there)`]);

    return {
        command, readConfig, removePath, listLocalState,
        get removedPaths() { return removedPaths; },
        get cmdCalls() { return cmdCalls; },
        get bootstrapAttempts() { return bootstrapAttempts; },
    };
}

function baseOpts(fx, over = {}) {
    return {
        member: 'sprint-eft',
        command: fx.command,
        readConfig: fx.readConfig,
        removePath: fx.removePath,
        listLocalState: fx.listLocalState,
        log: () => {},
        ...over,
    };
}

// --- Happy path -------------------------------------------------------------
test('Path B discards, re-bootstraps, replays the pending mutation, and republishes end-to-end', async () => {
    const fx = makeFixture();
    const res = await recoverDoltConflictPathB(baseOpts(fx, {
        pendingMutation: { description: 'bd close apra-fleet-eft.9.5', cmd: 'bd close apra-fleet-eft.9.5' },
    }));

    check(res.ok === true, 'result ok');
    check(res.recovered === true, 'recovered');
    check(res.mutationReplayed === true, 'mutation replayed');
    check(res.removedPaths.length === DEFAULT_PATH_B_REMOVE_PATHS.length, 'removed exactly the three paths');
    check(DEFAULT_PATH_B_REMOVE_PATHS.every((p) => res.removedPaths.includes(p)), 'removed paths match the fixed list');
    check(!res.removedPaths.includes(DEFAULT_CONFIG_PATH), 'config.yaml was NEVER removed');
    check(fx.removedPaths.every((p) => p !== DEFAULT_CONFIG_PATH), 'removePath() was never called with config.yaml');

    const cmds = fx.cmdCalls.map((c) => c.cmd);
    check(cmds.some((c) => c.includes('bd bootstrap') && c.includes('BD_NON_INTERACTIVE=1') && c.includes('--yes')), 'bootstrap invoked with BD_NON_INTERACTIVE=1 and --yes');
    check(cmds.some((c) => c === 'bd close apra-fleet-eft.9.5'), 'the pending mutation was replayed verbatim');
    check(cmds.some((c) => c.includes('bd dolt push')), 'republished with bd dolt push');
    check(res.discarded.length > 0, 'discarded local state was enumerated');
});

test('Path B with no pending mutation still recovers and republishes, replaying nothing', async () => {
    const fx = makeFixture();
    const res = await recoverDoltConflictPathB(baseOpts(fx));
    check(res.ok === true, 'ok');
    check(res.mutationReplayed === false, 'nothing replayed');
});

// --- Windows gotcha #1: config.yaml guard -----------------------------------
test('Path B guard REJECTS and never touches disk when config.yaml is missing', async () => {
    const fx = makeFixture({ configExists: false });
    await assert.rejects(
        () => recoverDoltConflictPathB(baseOpts(fx)),
        (err) => err instanceof DoltSyncError,
        'missing config.yaml throws DoltSyncError',
    );
    check(fx.removedPaths.length === 0, 'nothing was removed before the guard rejected');
    check(fx.cmdCalls.length === 0, 'no command was run before the guard rejected');
});

test('Path B guard REJECTS when config.yaml has no sync.remote (Windows gotcha #1)', async () => {
    const fx = makeFixture({ configHasRemote: false });
    await assert.rejects(
        () => recoverDoltConflictPathB(baseOpts(fx)),
        (err) => err instanceof DoltSyncError,
        'missing sync.remote throws DoltSyncError',
    );
    check(fx.removedPaths.length === 0, 'nothing was removed before the guard rejected');
});

test('hasSyncRemoteInYaml recognizes a present vs absent sync.remote', () => {
    check(hasSyncRemoteInYaml('sync:\n  remote: origin\n') === true, 'present remote detected');
    check(hasSyncRemoteInYaml('sync:\n  remote:\n') === false, 'empty remote value is not present');
    check(hasSyncRemoteInYaml('other: true\n') === false, 'no sync block at all');
    check(hasSyncRemoteInYaml('') === false, 'empty text');
});

// --- Windows gotcha #2: leftover empty DB retry -----------------------------
test('Path B recovers from the leftover-empty-DB bootstrap failure via exactly one bounded retry (Windows gotcha #2)', async () => {
    const fx = makeFixture({ bootstrapEmptyDbThenOk: true });
    const res = await recoverDoltConflictPathB(baseOpts(fx));
    check(res.ok === true, 'recovered after the retry');
    check(fx.bootstrapAttempts === 2, 'bootstrap was attempted exactly twice (one bounded retry)');
    check(fx.removedPaths.filter((p) => p === DEFAULT_EMBEDDED_DATA_DIR).length === 2,
        'embeddeddolt was removed once up front and once again for the gotcha #2 retry');
});

test('isBootstrapEmptyDbFailure classifies the leftover-empty-DB text and rejects other failures', () => {
    check(isBootstrapEmptyDbFailure('directory not empty: leftover data') === true, 'leftover data detected');
    check(isBootstrapEmptyDbFailure('database already exists') === true, 'already exists detected');
    check(isBootstrapEmptyDbFailure('network unreachable') === false, 'unrelated failure not classified as gotcha #2');
});

test('Path B does NOT retry and throws on a bootstrap failure that is not the leftover-empty-DB shape', async () => {
    const fx = makeFixture({ bootstrapOk: false });
    await assert.rejects(
        () => recoverDoltConflictPathB(baseOpts(fx)),
        (err) => err instanceof DoltSyncError,
        'an unrecognized bootstrap failure throws DoltSyncError',
    );
    check(fx.bootstrapAttempts === 1, 'bootstrap was attempted exactly once -- no blind retry on an unrecognized failure');
});

// --- Mutation replay / republish failure ------------------------------------
test('Path B throws when replaying the pending mutation fails -- it would otherwise be silently lost', async () => {
    const fx = makeFixture({ replayOk: false });
    await assert.rejects(
        () => recoverDoltConflictPathB(baseOpts(fx, {
            pendingMutation: { description: 'bd close apra-fleet-eft.9.5', cmd: 'bd close apra-fleet-eft.9.5' },
        })),
        (err) => err instanceof DoltSyncError,
        'a failed mutation replay throws DoltSyncError',
    );
});

test('Path B throws when the post-recovery republish push is still rejected', async () => {
    const fx = makeFixture({ pushOk: false });
    await assert.rejects(
        () => recoverDoltConflictPathB(baseOpts(fx)),
        (err) => err instanceof DoltDivergedError,
        'a still-rejected republish push throws DoltDivergedError',
    );
});

// --- Discard enumeration -----------------------------------------------------
test('Path B enumerates local state to be discarded even when the backup dir is empty', async () => {
    const fx = makeFixture({ backupEntries: [] });
    const res = await recoverDoltConflictPathB(baseOpts(fx));
    check(res.discarded.some((line) => /is empty/.test(line)), 'empty backup dir is still enumerated, not silently skipped');
});
