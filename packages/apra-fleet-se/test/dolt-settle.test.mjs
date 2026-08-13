import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    settleDoltConflicts,
    resolveDoltAsset,
    resolveDoltStatus,
    ensurePinnedDolt,
    DOLT_VERSION,
    DEFAULT_EMBEDDED_DATA_DIR,
    RECOVERY_SQL_SERVER_HOST,
    DEFAULT_PORT_RANGE,
    escapeSqlForShell,
    parseDoltJsonRows,
} from '../fleet-sprint/dolt-settle.mjs';
import { DoltDivergedError, DoltSyncError, DoltBinaryUnavailableError } from '../fleet-sprint/errors.mjs';

const check = (cond, msg) => assert.ok(cond, msg);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// =============================================================================
// dolt-settle.mjs -- the single deterministic, zero-agent-dispatch conflict
// settlement function that replaces the whole Path A / Path B / Tier 2
// ladder. See docs/dolt-sync-redesign.md.
//
// Every SQL/shell interaction goes through ONE injected command(); these
// tests drive a scripted fake command() that pattern-matches the exact
// shell command strings the module constructs (dolt version probes, the
// WMI/nohup spawn incantations, `dolt --no-tls ... sql -r json -q "..."`,
// `bd dolt pull/push`, TCP probes) against an in-memory wedged-clone
// fixture -- no live dolt server is ever touched.
// =============================================================================

// ---------------------------------------------------------------------------
// resolveDoltAsset -- pure mapping, must mirror src/cli/dolt-install.ts.
// ---------------------------------------------------------------------------

test('resolveDoltAsset: known platform/arch combos resolve to the pinned v2.2.0 asset URL', () => {
    const win = resolveDoltAsset('win32', 'x64');
    check(win.url === `https://github.com/dolthub/dolt/releases/download/${DOLT_VERSION}/dolt-windows-amd64.zip`, 'windows asset URL');
    check(win.binaryName === 'dolt.exe', 'windows binary name');
    check(win.archiveType === 'zip', 'windows archive type');

    const linux = resolveDoltAsset('linux', 'x64');
    check(linux.url.endsWith('dolt-linux-amd64.tar.gz'), 'linux asset URL');
    check(linux.binaryName === 'dolt', 'linux binary name');

    const macIntel = resolveDoltAsset('darwin', 'x64');
    check(macIntel.url.endsWith('dolt-darwin-amd64.tar.gz'), 'darwin/x64 asset URL');

    const macArm = resolveDoltAsset('darwin', 'arm64');
    check(macArm.url.endsWith('dolt-darwin-arm64.tar.gz'), 'darwin/arm64 asset URL');
});

test('resolveDoltAsset: unsupported platform/arch throws rather than silently no-op', () => {
    assert.throws(() => resolveDoltAsset('win32', 'arm64'), /unsupported platform\/arch/i);
    assert.throws(() => resolveDoltAsset('linux', 'arm64'), /unsupported platform\/arch/i);
    assert.throws(() => resolveDoltAsset('freebsd', 'x64'), /unsupported platform\/arch/i);
});

// ---------------------------------------------------------------------------
// Shell dialect. Every settle command runs in the MEMBER's own shell, and the
// two dialects disagree in ways that broke settle outright when it assumed one
// of them (found by running against real members):
//   - bash treats a backtick inside double quotes as command substitution;
//     PowerShell treats it as its escape character.
//   - a leading `&` is PowerShell's call operator and a bash syntax error.
// ---------------------------------------------------------------------------

test('escapeSqlForShell: a backtick-quoted SQL identifier survives bash command substitution', () => {
    const bq = String.fromCharCode(96);
    const sql = `SELECT ${bq}table${bq} FROM dolt_conflicts;`;
    const escaped = escapeSqlForShell('linux', sql);
    check(escaped.includes('\\' + bq), 'bash needs the backtick backslash-escaped or the shell would EXECUTE the identifier');
    check(!/(^|[^\\])`/.test(escaped), 'no unescaped backtick may survive into a bash double-quoted argument');
});

test('escapeSqlForShell: PowerShell gets doubled backticks and backtick-escaped quotes/dollars, not backslashes', () => {
    const bq = String.fromCharCode(96);
    const escaped = escapeSqlForShell('win32', `SELECT ${bq}x${bq} FROM t WHERE a = "b" AND c = '$d';`);
    check(escaped.includes(bq + bq), 'a literal backtick in PowerShell is a DOUBLED backtick');
    check(escaped.includes(bq + '"'), 'a literal double quote in PowerShell is backtick-quote');
    check(escaped.includes(bq + '$'), 'a literal $ must be escaped or PowerShell would expand it as a variable');
    check(!escaped.includes('\\' + bq), 'backslash is NOT an escape character in PowerShell');
});

test('escapeSqlForShell: single quotes (every DOLT_CONFLICTS_RESOLVE argument) pass through untouched in both dialects', () => {
    const sql = "CALL DOLT_CONFLICTS_RESOLVE('--theirs', 'issues');";
    assert.equal(escapeSqlForShell('linux', sql), sql);
    assert.equal(escapeSqlForShell('win32', sql), sql);
});

// ---------------------------------------------------------------------------
// `dolt sql -r json` output shape. VERBATIM from fleet-lin-dev1: a
// multi-statement -q emits one JSON document PER STATEMENT, concatenated. Every
// settle query carries a `USE beads; SET ...;` preamble, so this is the normal
// shape -- and parsing only the first/whole document made settle see ZERO
// conflicted tables on a genuinely conflicted clone.
// ---------------------------------------------------------------------------

/** The real concatenated-document shape, used by the fixtures below. */
function realDoltJson(rows) {
    return `{}\n\n${JSON.stringify({ rows })}\n`;
}

test('parseDoltJsonRows: reads the LAST row-bearing document out of a real multi-statement batch', () => {
    const live = '{}\n\n{"rows": [{"num_conflicts":"1","table":"issues"}]}\n';
    assert.deepEqual(parseDoltJsonRows(live), [{ num_conflicts: '1', table: 'issues' }]);
});

test('parseDoltJsonRows: no-result statements and empty output yield no rows, never a throw', () => {
    assert.deepEqual(parseDoltJsonRows('{}\n{}\n'), []);
    assert.deepEqual(parseDoltJsonRows(''), []);
    assert.deepEqual(parseDoltJsonRows(null), []);
    assert.deepEqual(parseDoltJsonRows('Warning: something\nnot json at all'), []);
});

test('parseDoltJsonRows: a single well-formed document still parses (both legacy shapes)', () => {
    assert.deepEqual(parseDoltJsonRows('{"rows": [{"a":1}]}'), [{ a: 1 }]);
    assert.deepEqual(parseDoltJsonRows('[{"a":1}]'), [{ a: 1 }]);
});

// ---------------------------------------------------------------------------
// Drift guard (design doc Part 5.4): dolt-settle.mjs's own DOLT_VERSION must
// never silently diverge from src/cli/dolt-install.ts's pin.
// ---------------------------------------------------------------------------

test('DOLT_VERSION matches src/cli/dolt-install.ts pin (drift guard)', () => {
    const installTsPath = path.join(__dirname, '..', '..', '..', 'src', 'cli', 'dolt-install.ts');
    const source = fs.readFileSync(installTsPath, 'utf-8');
    const match = source.match(/export const DOLT_VERSION = '([^']+)'/);
    check(match, 'dolt-install.ts still exports a DOLT_VERSION constant in the expected shape');
    assert.equal(DOLT_VERSION, match[1], 'dolt-settle.mjs DOLT_VERSION must equal dolt-install.ts DOLT_VERSION -- a pin bump that touches one file and not the other must fail this test');
});

// ---------------------------------------------------------------------------
// resolveDoltStatus -- parsing `bd dolt status`, never hardcoding the data dir.
// ---------------------------------------------------------------------------

test('resolveDoltStatus: parses embedded mode and its real data dir', async () => {
    const command = async () => ({ ok: true, output: 'Dolt engine: embedded (in-process, no server)\n  Data: C:\\fleet\\.beads\\embeddeddolt\n', error: null });
    const status = await resolveDoltStatus({ command, member: 'm1' });
    assert.equal(status.mode, 'embedded');
    assert.equal(status.dataDir, 'C:\\fleet\\.beads\\embeddeddolt');
});

test('resolveDoltStatus: parses an already-live server mode and its host:port', async () => {
    const command = async () => ({ ok: true, output: 'Dolt engine: server, connected to 127.0.0.1:62336\n', error: null });
    const status = await resolveDoltStatus({ command, member: 'm1' });
    assert.equal(status.mode, 'server');
    assert.equal(status.host, '127.0.0.1');
    assert.equal(status.port, 62336);
});

test('resolveDoltStatus: unparseable output falls back to the default data dir, loudly', async () => {
    const logs = [];
    const command = async () => ({ ok: true, output: 'garbage', error: null });
    const status = await resolveDoltStatus({ command, member: 'm1', log: (m) => logs.push(m) });
    assert.equal(status.mode, 'unknown');
    assert.equal(status.dataDir, DEFAULT_EMBEDDED_DATA_DIR);
    check(logs.some((l) => /WARNING/.test(l)), 'a fallback to the default data dir must be logged loudly, never silent');
});

// ---------------------------------------------------------------------------
// ensurePinnedDolt -- the member-side probe/install/kill-retry/fallback ladder.
// ---------------------------------------------------------------------------

function makeInstallFixture({ initialVersion = null, installOk = true, installLockedThenOk = false } = {}) {
    const calls = [];
    let installed = initialVersion;
    let installAttempts = 0;
    const command = async (cmd) => {
        calls.push(cmd);
        if (/version$/.test(cmd.trim()) || /& ".*" version/.test(cmd)) {
            return installed ? { ok: true, output: `dolt version ${installed}\n`, error: null } : { ok: false, output: '', error: 'not found' };
        }
        if (/Invoke-WebRequest|curl -fL/.test(cmd)) {
            installAttempts += 1;
            if (installLockedThenOk && installAttempts === 1) {
                return { ok: false, output: '', error: 'Access to the path is denied: being used by another process' };
            }
            if (!installOk) return { ok: false, output: '', error: 'network unreachable' };
            installed = DOLT_VERSION.replace(/^v/, '');
            return { ok: true, output: '', error: null };
        }
        if (/Stop-Process|pkill/.test(cmd)) {
            return { ok: true, output: '', error: null };
        }
        return { ok: true, output: '', error: null };
    };
    return { command, calls, getInstalled: () => installed };
}

test('ensurePinnedDolt: already correctly pinned -- no install attempted', async () => {
    const { command, calls } = makeInstallFixture({ initialVersion: DOLT_VERSION.replace(/^v/, '') });
    const result = await ensurePinnedDolt({ command, member: 'm1', platform: 'win32' });
    assert.equal(result.pinned, true);
    assert.equal(result.warnings.length, 0);
    check(!calls.some((c) => /Invoke-WebRequest/.test(c)), 'no download should be attempted when the binary is already pinned');
});

test('ensurePinnedDolt: missing binary is installed from the pinned asset URL', async () => {
    const { command } = makeInstallFixture({ initialVersion: null, installOk: true });
    const result = await ensurePinnedDolt({ command, member: 'm1', platform: 'linux' });
    assert.equal(result.pinned, true);
    assert.equal(result.version, DOLT_VERSION.replace(/^v/, ''));
});

test('ensurePinnedDolt: locked file (in-use) triggers kill-then-retry, succeeds on retry', async () => {
    const { command, calls } = makeInstallFixture({ initialVersion: '1.86.3', installLockedThenOk: true });
    const result = await ensurePinnedDolt({ command, member: 'm1', platform: 'win32' });
    assert.equal(result.pinned, true);
    check(calls.some((c) => /Stop-Process/.test(c)), 'a locked-file install failure must trigger a kill attempt before falling back');
});

test('ensurePinnedDolt: hard install failure (not a lock) throws DoltBinaryUnavailableError, never silently proceeds', async () => {
    const { command } = makeInstallFixture({ initialVersion: null, installOk: false });
    await assert.rejects(
        () => ensurePinnedDolt({ command, member: 'm1', platform: 'linux' }),
        DoltBinaryUnavailableError,
    );
});

// ---------------------------------------------------------------------------
// settleDoltConflicts -- the full orchestrator, happy path end to end.
// ---------------------------------------------------------------------------

/**
 * A wedged-clone fixture whose `command()` pattern-matches the exact shell
 * strings settleDoltConflicts() issues: version probe, WMI spawn, TCP probe,
 * `dolt --no-tls ... sql -r json -q "..."`, `bd dolt pull/push`, kill.
 */
function makeSettleFixture({
    conflictTables = [{ table: 'issues' }],
    issuesHasUpdatedAt = true,
    pushOk = true,
    // Per-table schema the fake information_schema answers with. `columns` is
    // what information_schema.columns returns; `pk` is what
    // key_column_usage returns for CONSTRAINT_NAME = 'PRIMARY'.
    schema = {
        labels: { columns: ['issue_id', 'label'], pk: ['issue_id', 'label'] },
    },
} = {}) {
    const state = {
        conflicts: conflictTables,
        resolvedTables: [],
        merged: false,
        committed: false,
        inserts: [],   // every INSERT INTO ... statement settle issued
        updates: [],   // every UPDATE ... statement settle issued
    };
    const timeline = [];
    let serverKilledBeforePush = null;
    let pushCalled = false;
    let activePort = null; // the port the spawned server is actually listening on

    const command = async (cmd) => {
        timeline.push(cmd);

        // Step 0: bd dolt status -- embedded mode, default data dir.
        if (cmd === 'bd dolt status') {
            return { ok: true, output: `Dolt engine: embedded (in-process, no server)\n  Data: ${DEFAULT_EMBEDDED_DATA_DIR}\n`, error: null };
        }

        // Step 1: dolt version probe -- already pinned, no install needed.
        if (/version"?$/.test(cmd.trim())) {
            return { ok: true, output: `dolt version ${DOLT_VERSION.replace(/^v/, '')}\n`, error: null };
        }

        // Port selection: ONE dispatch that scans the range member-side (never
        // one round trip per candidate port) and prints the first free one.
        if (/FREEPORT/.test(cmd)) {
            return { ok: true, output: 'FREEPORT:13300', error: null };
        }

        // Single-port TCP probes (wait-for-ready + teardown-verify). Only the
        // port the server actually spawned on (once spawned, and until torn
        // down) answers. Written per shell dialect -- PowerShell TcpClient on
        // Windows, /dev/tcp on POSIX -- so both shapes are matched here.
        if (/PROBE:True/.test(cmd)) {
            const portMatch = cmd.match(/net.connect\((\d+),/);
            const probedPort = portMatch ? Number(portMatch[1] || portMatch[2]) : null;
            const up = activePort !== null && probedPort === activePort && serverKilledBeforePush !== true;
            return { ok: true, output: up ? 'PROBE:True' : 'PROBE:False', error: null };
        }

        // Step 2: spawn ephemeral server (Win32_Process.Create on Windows,
        // nohup+disown on POSIX).
        if (/Invoke-CimMethod/.test(cmd) || /nohup .* sql-server/.test(cmd)) {
            const portMatch = cmd.match(/--port (\d+)/);
            activePort = portMatch ? Number(portMatch[1]) : null;
            return { ok: true, output: 'PID:4242', error: null };
        }

        // Step 5 (corrected order): kill the server BEFORE republish.
        if (/Stop-Process -Id 4242|^kill 4242/.test(cmd)) {
            serverKilledBeforePush = true;
            check(!pushCalled, 'the server must be torn down BEFORE bd dolt push is ever called (design doc Part 7.2 ordering fix)');
            return { ok: true, output: '', error: null };
        }

        // Step 3/4: raw dolt sql -r json -q "..."
        if (/--no-tls --host=/.test(cmd)) {
            check(/--no-tls --host=/.test(cmd), '--no-tls must precede --host/--port');
            check(!/--user|--password/.test(cmd), 'settle must NEVER pass --user/--password (the ga61 credential-prompt landmine)');
            const q = cmd;

            // NOTE: every query now carries the SET preamble (each dolt sql
            // invocation is its own session), so this must NOT be matched as
            // a statement in its own right -- it would swallow every query.
            check(/SET @@dolt_allow_commit_conflicts = 1;/.test(q), 'every settle query must carry the allow-commit-conflicts preamble, since each dolt sql invocation is a fresh session');
            if (/CALL DOLT_MERGE/.test(q)) { state.merged = true; return { ok: true, output: '', error: null }; }
            if (/SELECT \* FROM dolt_conflicts/.test(q)) {
                return { ok: true, output: realDoltJson(state.conflicts), error: null };
            }
            if (/information_schema\.columns/.test(q)) {
                const t = (q.match(/TABLE_NAME = '([^']+)'/) || [])[1];
                const defaultCols = issuesHasUpdatedAt
                    ? ['id', 'title', 'status', 'updated_at']
                    : ['id', 'title', 'status'];
                const cols = (schema[t] && schema[t].columns) || defaultCols;
                return { ok: true, output: realDoltJson(cols.map((c) => ({ COLUMN_NAME: c }))), error: null };
            }
            if (/information_schema\.key_column_usage/.test(q)) {
                const t = (q.match(/TABLE_NAME = '([^']+)'/) || [])[1];
                const pk = (schema[t] && schema[t].pk) || [];
                return { ok: true, output: realDoltJson(pk.map((c) => ({ COLUMN_NAME: c }))), error: null };
            }
            if (/INSERT INTO /.test(q)) {
                // Store the UNESCAPED SQL: runDoltSql escapes backticks/quotes
                // for the member shell dialect, which is not what the union
                // assertions below are about.
                state.inserts.push(q.split('\\' + String.fromCharCode(96)).join(String.fromCharCode(96)).split('\\"').join('"'));
                return { ok: true, output: '', error: null };
            }
            if (/UPDATE `/.test(q)) { state.updates.push(q); return { ok: true, output: '', error: null }; }
            if (/CALL DOLT_CONFLICTS_RESOLVE/.test(q)) {
                const m = q.match(/DOLT_CONFLICTS_RESOLVE\\?\('[^']+',\s*'([^']+)'\)/);
                if (m) state.resolvedTables.push(m[1]);
                return { ok: true, output: '', error: null };
            }
            if (/CALL DOLT_COMMIT/.test(q)) { state.committed = true; return { ok: true, output: '', error: null }; }
            if (/SELECT COUNT\(\*\) AS n FROM dolt_conflicts/.test(q)) {
                return { ok: true, output: realDoltJson([{ n: 0 }]), error: null };
            }
            return { ok: true, output: '', error: null };
        }

        // Step 6: republish.
        if (cmd === 'bd dolt pull') return { ok: true, output: '', error: null };
        if (cmd === 'bd dolt push') {
            pushCalled = true;
            check(serverKilledBeforePush === true, 'bd dolt push must only run AFTER the ephemeral server has been torn down');
            return pushOk ? { ok: true, output: '', error: null } : { ok: false, output: '', error: 'updates were rejected' };
        }

        return { ok: true, output: '', error: null };
    };

    return { command, state, timeline };
}

test('settleDoltConflicts: resolves a single-row issues conflict end to end, tears down before republish', async () => {
    const { command, state } = makeSettleFixture({ conflictTables: [{ table: 'issues' }] });
    const result = await settleDoltConflicts('fleet-win-dev1', { command, platform: 'win32' });

    assert.equal(result.ok, true);
    assert.deepEqual(result.resolvedTables, ['issues']);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.doltVersionUsed, DOLT_VERSION.replace(/^v/, ''));
    check(state.merged, 'DOLT_MERGE must have been called');
    check(state.committed, 'DOLT_COMMIT must have been called');
    assert.deepEqual(state.resolvedTables, ['issues']);
});

test('settleDoltConflicts: resolves multiple conflicted tables with no allowlist (total, not gated)', async () => {
    const { command, state } = makeSettleFixture({ conflictTables: [{ table: 'issues' }, { table: 'labels' }, { table: 'some_future_table' }] });
    const result = await settleDoltConflicts('fleet-lin-dev1', { command, platform: 'linux' });

    assert.equal(result.ok, true);
    assert.deepEqual(result.resolvedTables.sort(), ['issues', 'labels', 'some_future_table'].sort());
    check(state.resolvedTables.includes('some_future_table'), 'an unnamed table must still be resolved via the generic fallback, proving settle is total rather than an allowlist');
});

test('settleDoltConflicts: a table with no updated_at column resolves via plain --theirs, not a broken LWW UPDATE', async () => {
    const { command, state } = makeSettleFixture({ conflictTables: [{ table: 'issues' }], issuesHasUpdatedAt: false });
    const result = await settleDoltConflicts('fleet-mac', { command, platform: 'darwin' });
    assert.equal(result.ok, true);
    check(state.resolvedTables.includes('issues'), 'issues must still resolve even without updated_at');
});

// ---------------------------------------------------------------------------
// labels set-union (design doc Part 3.2 step 4). A plain --theirs resolve is
// NOT enough for an add/add conflict: it drops the other side's added rows.
// Settle must INSERT the missing their_* rows first, keyed on the table's REAL
// uniqueness key read from information_schema, and only then clear the markers.
// ---------------------------------------------------------------------------

test('settleDoltConflicts: labels conflict fires a real set-union INSERT keyed on the live-read primary key, then clears the markers', async () => {
    const { command, state } = makeSettleFixture({
        conflictTables: [{ table: 'labels' }],
        schema: { labels: { columns: ['issue_id', 'label'], pk: ['issue_id', 'label'] } },
    });
    const result = await settleDoltConflicts('m1', { command, platform: 'linux' });
    assert.equal(result.ok, true);

    check(state.inserts.length === 1, `labels must be resolved with exactly one set-union INSERT (got ${state.inserts.length})`);
    const sql = state.inserts[0];
    check(/INSERT INTO `labels` \(`issue_id`, `label`\)/.test(sql), `the INSERT must target the real column list read from information_schema: ${sql}`);
    check(/SELECT c\.their_issue_id, c\.their_label/.test(sql), 'the union must select the their_* projection (our rows are already in the working set)');
    check(/FROM dolt_conflicts_labels c/.test(sql), 'the union must read from the table-specific dolt_conflicts_ view');
    check(/NOT EXISTS/.test(sql), 'the union must skip their_* rows already present on our side, never blind-insert duplicates');
    check(/t\.`issue_id` = c\.their_issue_id AND t\.`label` = c\.their_label/.test(sql), `the NOT EXISTS identity must use EVERY primary-key column, not a hardcoded single column: ${sql}`);
    check(!/hardcoded|our_issue_id/.test(sql), 'settle must not re-insert our own rows -- they already exist in the working set');
    check(state.resolvedTables.includes('labels'), 'the conflict markers must still be cleared after the data-level union');
});

test('settleDoltConflicts: labels set-union honours a DIFFERENT uniqueness key without any hardcoded column names', async () => {
    const { command, state } = makeSettleFixture({
        conflictTables: [{ table: 'labels' }],
        schema: { labels: { columns: ['bead_id', 'name', 'created_at'], pk: ['bead_id', 'name'] } },
    });
    await settleDoltConflicts('m1', { command, platform: 'linux' });
    const sql = state.inserts[0];
    check(/INSERT INTO `labels` \(`bead_id`, `name`, `created_at`\)/.test(sql), `column list must come from the live schema: ${sql}`);
    check(/t\.`bead_id` = c\.their_bead_id AND t\.`name` = c\.their_name/.test(sql), `identity must come from the live PK, not a guessed (issue_id,label): ${sql}`);
    check(!/created_at` = c\.their_created_at/.test(sql), 'a non-key audit column must not participate in the uniqueness identity');
});

test('settleDoltConflicts: labels with no declared PRIMARY KEY falls back to whole-row identity rather than skipping the union', async () => {
    const { command, state } = makeSettleFixture({
        conflictTables: [{ table: 'labels' }],
        schema: { labels: { columns: ['issue_id', 'label'], pk: [] } },
    });
    await settleDoltConflicts('m1', { command, platform: 'linux' });
    const sql = state.inserts[0];
    check(/t\.`issue_id` = c\.their_issue_id AND t\.`label` = c\.their_label/.test(sql), `with no PK the union must fall back to full-row identity: ${sql}`);
});

test('settleDoltConflicts: a union table whose columns cannot be read degrades to --theirs instead of issuing a broken INSERT', async () => {
    const { command, state } = makeSettleFixture({
        conflictTables: [{ table: 'labels' }],
        schema: { labels: { columns: [], pk: [] } },
    });
    const result = await settleDoltConflicts('m1', { command, platform: 'linux' });
    assert.equal(result.ok, true);
    assert.equal(state.inserts.length, 0, 'no INSERT may be issued when the column list is unknown');
    check(state.resolvedTables.includes('labels'), 'settle must still resolve the table (totality), just via plain --theirs');
});

test('settleDoltConflicts: requires platform to be explicitly supplied, never assumes process.platform', async () => {
    const { command } = makeSettleFixture();
    await assert.rejects(
        () => settleDoltConflicts('m1', { command }),
        /requires opts.platform/,
    );
});

test('settleDoltConflicts: a still-rejected republish push surfaces as DoltDivergedError, not a silent success', async () => {
    const { command } = makeSettleFixture({ pushOk: false });
    await assert.rejects(
        () => settleDoltConflicts('m1', { command, platform: 'win32' }),
        DoltDivergedError,
    );
});

test('settleDoltConflicts: teardown still runs on a mid-procedure throw (finally-block guarantee)', async () => {
    let serverSpawned = false;
    let killedInFinally = false;
    const command = async (cmd) => {
        if (cmd === 'bd dolt status') return { ok: true, output: `Dolt engine: embedded (in-process, no server)\n  Data: ${DEFAULT_EMBEDDED_DATA_DIR}\n`, error: null };
        if (/version"?$/.test(cmd.trim())) return { ok: true, output: `dolt version ${DOLT_VERSION.replace(/^v/, '')}\n`, error: null };
        if (/FREEPORT/.test(cmd)) return { ok: true, output: 'FREEPORT:13300', error: null };
        if (/PROBE:True/.test(cmd)) return { ok: true, output: (serverSpawned && !killedInFinally) ? 'PROBE:True' : 'PROBE:False', error: null };
        if (/Invoke-CimMethod/.test(cmd)) { serverSpawned = true; return { ok: true, output: 'PID:9999', error: null }; }
        if (/Stop-Process -Id 9999/.test(cmd)) { killedInFinally = true; return { ok: true, output: '', error: null }; }
        if (/--no-tls --host=/.test(cmd) && /CALL DOLT_MERGE/.test(cmd)) {
            throw new DoltSyncError('simulated mid-procedure SQL failure', { member: 'm1' });
        }
        return { ok: true, output: '', error: null };
    };

    await assert.rejects(() => settleDoltConflicts('m1', { command, platform: 'win32' }));
    check(serverSpawned, 'server must have been spawned before the simulated failure');
    check(killedInFinally, 'the finally block must have torn the server down even though the procedure threw mid-way');
});
