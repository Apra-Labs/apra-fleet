import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    recoverDoltConflictPathA,
    assessConflictGates,
    isDoltPullConflict,
    DEFAULT_EMBEDDED_DATA_DIR,
    RECOVERY_SQL_SERVER_HOST,
} from '../auto-sprint/dolt-recovery.mjs';
import { DoltDivergedError } from '../auto-sprint/errors.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-eft.9.4 -- Path A: scripted resolve-in-place dolt conflict
// recovery behind two deterministic gates.
//
// These tests drive the full 10-step runbook against a DELIBERATELY WEDGED
// test clone modeled by an in-memory stateful fixture (a fake dolt sql-server:
// dolt_conflicts / dolt_conflicts_resolve / dolt_commit / dolt_log). No live
// dolt server is touched -- every SQL statement and shell command runs through
// the injected sql()/command()/spawnSqlServer, exactly the dependency-injection
// posture the rest of the dolt bracket suite uses. They assert:
//   - a plain single-row `issues` conflict passes both gates, resolves end to
//     end with ZERO agent dispatch, keeps BOTH sides' history in dolt_log, and
//     leaves metadata.json flipped back to embedded + the server torn down;
//   - the dolt_merge step and the REQUIRED table-name arg to
//     dolt_conflicts_resolve are actually issued;
//   - a non-issues-table conflict and a multi-row conflict are REJECTED by the
//     gate (proceeded:false, no resolve) yet still fully reverted;
//   - reversibility holds even when a later step throws (flip-back + teardown
//     asserted in the finally path).
// =============================================================================

/**
 * Build a wedged-clone fixture. `conflicts` is the rows `SELECT * FROM
 * dolt_conflicts` reports for this wedged clone (one row per conflicted
 * table). Options let a test force a failing push, etc.
 */
function makeWedgedClone({ conflicts, pushOk = true, pullOk = true } = {}) {
    const state = {
        conflicts: conflicts ?? [{ table: 'issues', num_conflicts: 1 }],
        merged: false,
        resolvedTables: [],
        committed: false,
        // dolt_log seeded with BOTH sides' history already present -- the merge
        // commit (added on DOLT_COMMIT) keeps both parents; zero data loss.
        log: [
            { commit_hash: 'aaa', message: 'ours: local sprint work' },
            { commit_hash: 'bbb', message: 'theirs: remote sprint work' },
        ],
    };
    const sqlCalls = [];
    const sql = async (query, opts = {}) => {
        sqlCalls.push({ query, opts });
        const q = String(query);
        if (/CALL DOLT_MERGE\('--abort'\)/i.test(q)) { state.merged = false; return { ok: true, rows: [] }; }
        if (/CALL DOLT_MERGE/i.test(q)) { state.merged = true; return { ok: true, rows: [] }; }
        if (/SELECT \* FROM dolt_conflicts/i.test(q)) { return { ok: true, rows: state.conflicts }; }
        if (/CALL DOLT_CONFLICTS_RESOLVE/i.test(q)) {
            const m = q.match(/DOLT_CONFLICTS_RESOLVE\('[^']+',\s*'([^']+)'\)/i);
            state.resolvedTables.push(m ? m[1] : null);
            return { ok: true, rows: [] };
        }
        if (/CALL DOLT_COMMIT/i.test(q)) {
            state.committed = true;
            state.log.push({ commit_hash: 'ccc', message: 'merge commit (both parents)' });
            return { ok: true, rows: [] };
        }
        if (/SELECT \* FROM dolt_log/i.test(q)) { return { ok: true, rows: state.log }; }
        return { ok: true, rows: [] };
    };

    const cmdCalls = [];
    const command = async (cmd, opts = {}) => {
        cmdCalls.push({ cmd, opts });
        if (cmd.includes('bd dolt pull')) return pullOk ? { ok: true, output: '', error: null } : { ok: false, output: '', error: 'still conflicted' };
        if (cmd.includes('bd dolt push')) return pushOk ? { ok: true, output: '', error: null } : { ok: false, output: '', error: 'updates were rejected' };
        return { ok: true, output: '', error: null };
    };

    let serverStops = 0;
    let serverStartArgs = null;
    const spawnSqlServer = async (args) => {
        serverStartArgs = args;
        return { stop: () => { serverStops += 1; } };
    };

    let metadata = { dolt_mode: 'embedded', remote: 'origin' };
    const metaWrites = [];
    const readMetadata = () => ({ ...metadata });
    const writeMetadata = (m) => { metadata = { ...m }; metaWrites.push({ ...m }); };

    return {
        state, sqlCalls, cmdCalls, command, sql, spawnSqlServer,
        allocatePort: () => 34567,
        readMetadata, writeMetadata,
        get metadata() { return metadata; },
        get serverStops() { return serverStops; },
        get serverStartArgs() { return serverStartArgs; },
        metaWrites,
    };
}

function baseOpts(fx, over = {}) {
    return {
        member: 'sprint-eft',
        command: fx.command,
        sql: fx.sql,
        spawnSqlServer: fx.spawnSqlServer,
        allocatePort: fx.allocatePort,
        readMetadata: fx.readMetadata,
        writeMetadata: fx.writeMetadata,
        log: () => {},
        ...over,
    };
}

// --- Happy path: single-row issues conflict resolves end to end ------------
test('Path A resolves a plain single-row issues conflict end-to-end with zero agent dispatch', async () => {
    const fx = makeWedgedClone({ conflicts: [{ table: 'issues', num_conflicts: 1 }] });
    const res = await recoverDoltConflictPathA(baseOpts(fx));

    check(res.ok === true, 'result ok');
    check(res.proceeded === true, 'proceeded past both gates');
    check(res.resolved === true, 'resolved');
    check(res.gate.passed === true, 'gate passed');

    const sqlText = fx.sqlCalls.map((c) => c.query).join('\n');
    // Step 5: the dolt_merge step upstream docs omit MUST be present.
    check(/CALL DOLT_MERGE\('origin\/main'\)/i.test(sqlText), 'dolt_merge(origin/main) issued');
    // Step 7: dolt_conflicts_resolve MUST carry the required table-name arg.
    check(fx.state.resolvedTables.length === 1 && fx.state.resolvedTables[0] === 'issues',
        'dolt_conflicts_resolve called with the required table-name arg (issues)');
    check(/DOLT_CONFLICTS_RESOLVE\('--theirs',\s*'issues'\)/i.test(sqlText), 'resolve strategy + table arg present');
    // Step 8: commit.
    check(fx.state.committed === true, 'resolved merge committed');
    // Step 9: pull + push republished.
    const cmds = fx.cmdCalls.map((c) => c.cmd);
    check(cmds.some((c) => c.includes('bd dolt pull')) && cmds.some((c) => c.includes('bd dolt push')),
        'republished with pull + push');

    // Zero data loss: BOTH sides present in dolt_log.
    check(res.doltLog.some((r) => /ours/.test(r.message)) && res.doltLog.some((r) => /theirs/.test(r.message)),
        'both sides history present in dolt_log');

    // Reversibility: metadata flipped back to embedded, server torn down.
    check(fx.metadata.dolt_mode === 'embedded', 'metadata.json flipped back to embedded');
    check(fx.metadata.dolt_server === undefined, 'transient dolt_server removed from metadata');
    check(fx.serverStops === 1, 'ephemeral sql-server torn down exactly once');
});

test('Path A points the sql-server at the embedded data dir on loopback (GH#2438 workaround)', async () => {
    const fx = makeWedgedClone();
    await recoverDoltConflictPathA(baseOpts(fx));
    check(fx.serverStartArgs.dataDir === DEFAULT_EMBEDDED_DATA_DIR, 'server started with embedded data dir');
    check(fx.serverStartArgs.host === RECOVERY_SQL_SERVER_HOST, 'server bound to loopback host');
    // metadata was flipped to server mode mid-flight before being reverted.
    check(fx.metaWrites.some((m) => m.dolt_mode === 'server'), 'metadata flipped to server mode during recovery');
    check(fx.metaWrites[fx.metaWrites.length - 1].dolt_mode === 'embedded', 'final metadata write is embedded');
});

// --- Gate rejection: non-issues table --------------------------------------
test('Path A gate REJECTS a conflict in a non-allowlisted table and does not resolve', async () => {
    const fx = makeWedgedClone({ conflicts: [{ table: 'labels', num_conflicts: 1 }] });
    const res = await recoverDoltConflictPathA(baseOpts(fx));

    check(res.ok === false, 'not ok');
    check(res.proceeded === false, 'did not proceed past gate');
    check(res.resolved === false, 'not resolved');
    check(res.gate.passedTableGate === false, 'table gate failed');
    check(fx.state.resolvedTables.length === 0, 'dolt_conflicts_resolve was NOT called');
    check(fx.state.committed === false, 'nothing committed');
    // Still fully reverted.
    check(fx.metadata.dolt_mode === 'embedded', 'metadata reverted to embedded even on gate rejection');
    check(fx.serverStops === 1, 'server torn down even on gate rejection');
});

// --- Gate rejection: multi-row conflict ------------------------------------
test('Path A gate REJECTS a multi-row issues conflict and does not resolve', async () => {
    const fx = makeWedgedClone({ conflicts: [{ table: 'issues', num_conflicts: 3 }] });
    const res = await recoverDoltConflictPathA(baseOpts(fx));

    check(res.proceeded === false, 'did not proceed on multi-row conflict');
    check(res.gate.passedTableGate === true, 'table gate still passes (issues is allowlisted)');
    check(res.gate.passedShapeGate === false, 'shape gate fails on >1 row');
    check(fx.state.resolvedTables.length === 0, 'no resolve on multi-row conflict');
    check(fx.metadata.dolt_mode === 'embedded', 'reverted to embedded');
    check(fx.serverStops === 1, 'server torn down');
});

// --- Gate rejection: two conflicted tables ---------------------------------
test('Path A gate REJECTS when more than one table is conflicted', async () => {
    const fx = makeWedgedClone({ conflicts: [{ table: 'issues', num_conflicts: 1 }, { table: 'dependencies', num_conflicts: 1 }] });
    const res = await recoverDoltConflictPathA(baseOpts(fx));
    check(res.proceeded === false, 'did not proceed with two conflicted tables');
    check(res.gate.passedShapeGate === false, 'shape gate fails on multiple tables');
    check(fx.state.resolvedTables.length === 0, 'no resolve');
});

// --- Reversibility on a mid-procedure failure ------------------------------
test('Path A reverts metadata and tears down the server even when the republishing push is rejected', async () => {
    const fx = makeWedgedClone({ conflicts: [{ table: 'issues', num_conflicts: 1 }], pushOk: false });
    await assert.rejects(
        () => recoverDoltConflictPathA(baseOpts(fx)),
        (err) => err instanceof DoltDivergedError,
        'a still-rejected republish push throws DoltDivergedError',
    );
    // reversibility asserted on the throwing path.
    check(fx.metadata.dolt_mode === 'embedded', 'metadata reverted to embedded on failure');
    check(fx.metadata.dolt_server === undefined, 'dolt_server removed on failure');
    check(fx.serverStops === 1, 'server torn down on failure');
});

// --- An explicitly extended allowlist proceeds -----------------------------
test('Path A honors an explicitly extended table allowlist', async () => {
    const fx = makeWedgedClone({ conflicts: [{ table: 'issue_labels', num_conflicts: 1 }] });
    const res = await recoverDoltConflictPathA(baseOpts(fx, { allowlistTables: ['issues', 'issue_labels'] }));
    check(res.proceeded === true, 'proceeded for an explicitly allowlisted table');
    check(fx.state.resolvedTables[0] === 'issue_labels', 'resolved the extended-allowlist table');
});

// --- Pure unit tests: gates + detection ------------------------------------
test('assessConflictGates: single-row issues conflict passes both gates', () => {
    const g = assessConflictGates([{ table: 'issues', num_conflicts: 1 }]);
    check(g.passed === true, 'passes');
    check(g.passedTableGate && g.passedShapeGate, 'both gates');
    check(g.totalConflicts === 1, 'one conflict');
});

test('assessConflictGates: empty conflicts fails the table gate (nothing to resolve)', () => {
    const g = assessConflictGates([]);
    check(g.passed === false, 'empty does not pass');
    check(g.passedTableGate === false, 'no conflicted table');
});

test('assessConflictGates: non-issues table fails the table gate', () => {
    const g = assessConflictGates([{ table: 'labels', num_conflicts: 1 }]);
    check(g.passedTableGate === false, 'table gate fails');
});

test('assessConflictGates: multi-row fails the shape gate', () => {
    const g = assessConflictGates([{ table: 'issues', num_conflicts: 2 }]);
    check(g.passedTableGate === true, 'table gate ok');
    check(g.passedShapeGate === false, 'shape gate fails');
});

test('isDoltPullConflict distinguishes a genuine merge conflict from noise', () => {
    check(isDoltPullConflict('merge conflict in table issues') === true, 'conflict detected');
    check(isDoltPullConflict('automatic merge failed; fix conflicts') === true, 'automatic merge failed detected');
    check(isDoltPullConflict('could not resolve host github.com') === false, 'transient network failure is not a Path A trigger');
    check(isDoltPullConflict('') === false, 'empty is not a conflict');
});
