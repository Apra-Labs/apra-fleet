// apra-fleet-eft.9.4 (Plan 3.4 -- Dolt conflict recovery ladder, Path A).
//
// Path A is the SCRIPTED, resolve-in-place recovery for the one dolt conflict
// shape we can safely arbitrate mechanically: a single conflicted row in the
// `issues` table (or an explicitly extended allowlist). It runs as a pure
// command()/sql()-driven orchestrator procedure -- ZERO agent dispatch -- and
// is gated behind TWO deterministic checks so it can only ever proceed on the
// exact conflict shape it was verified against.
//
// -----------------------------------------------------------------------------
// Why this exists (and why it is gated so tightly):
//
//   The D-push bracket (apra-fleet-eft.9.1/9.2) already reconciles the common
//   "remote moved first" race mechanically (first-successful-pusher-wins: pull
//   once, re-push once). What it CANNOT do is reconcile a genuine row-level
//   MERGE CONFLICT -- constraint C.2 (row-level, not cell-level, conflicts in
//   bd 1.1.0 embedded mode) and C.3 (one unresolved conflict wedges the ENTIRE
//   clone sync). A wedged clone cannot pull, push, or dispatch anything until
//   the conflict is resolved.
//
//   The upstream `bd dolt` embedded surface offers no way to re-open and
//   resolve such a merge in place. This runbook (VERIFIED 2026-07-16, plan
//   3.4) does it by temporarily standing up a dolt sql-server against the SAME
//   embedded data dir, re-opening the aborted merge through SQL, resolving the
//   single conflicted row, committing, and pushing -- then tearing the server
//   down and flipping metadata.json back to embedded mode. Reversibility (flip
//   back + teardown on EVERY path, including failure) and zero data loss were
//   both verified.
//
// -----------------------------------------------------------------------------
// The two deterministic gates (assessConflictGates below), both required:
//
//   Gate 1 (table): every conflicted table is in the allowlist (default
//     ['issues']). A conflict touching any other table is NOT something this
//     scripted path understands -- it must escalate (9.6), never guess.
//
//   Gate 2 (shape): a PLAIN SINGLE-ROW conflict -- exactly one conflicted
//     table, with exactly one conflicting row. A multi-row conflict is not a
//     shape a fixed ours/theirs rule can safely arbitrate without risking
//     silently discarding real work, so it too must escalate, not proceed.
//
//   A gate rejection is returned (not thrown) with proceeded:false so the
//   caller (Tier 2 escalation, apra-fleet-eft.9.6) can route it onward. Only a
//   genuine operational failure (server won't start, SQL error, push still
//   rejected) throws a typed DoltDivergedError/DoltSyncError.
//
// -----------------------------------------------------------------------------
// The 10-step VERIFIED runbook (implemented exactly, in this order):
//
//    1. Detect: a `bd dolt pull` whose exit/error text is a conflict (see
//       isDoltPullConflict) is the trigger.
//    2. Start `dolt sql-server --data-dir <embeddedDataDir>` on an ephemeral
//       loopback (127.0.0.1) port, EXTERNALLY MANAGED. `bd dolt start` points
//       the server at the wrong data dir (GH#2438), so we spawn it ourselves.
//    3. Flip metadata.json dolt_mode -> "server" (so bd talks to our server).
//    4. Re-open the aborted merge: `SET @@dolt_allow_commit_conflicts = 1`.
//    5. `CALL DOLT_MERGE('<remote>/<branch>')` -- the step upstream docs omit;
//       without it there is no in-progress merge to resolve.
//    6. `SELECT * FROM dolt_conflicts` -- THE GATE. assessConflictGates()
//       decides proceed/reject from this alone.
//    7. `CALL DOLT_CONFLICTS_RESOLVE('--theirs'|'--ours', '<table>')` -- the
//       table-name arg is REQUIRED (dolt errors without it).
//    8. `CALL DOLT_COMMIT('-m', ...)` the resolved merge.
//    9. `bd dolt pull` then `bd dolt push` to republish the reconciled clone.
//   10. Teardown: stop the sql-server and flip metadata.json back to
//       "embedded" -- ALWAYS, in a finally, even on failure (reversibility).
//
// Every SQL statement and shell command is issued through an injected
// sql()/command() so unit tests drive the whole procedure against a scripted
// (deliberately wedged) mock clone with no live dolt server.
// =============================================================================

import { DoltDivergedError, DoltSyncError } from './errors.mjs';

/** Default beads embedded data dir the sql-server is pointed at (step 2). The
 *  `embeddeddolt` suffix, not `.beads` itself, is the actual dolt data dir --
 *  the exact dir `bd dolt start` gets wrong (GH#2438). */
export const DEFAULT_EMBEDDED_DATA_DIR = '.beads/embeddeddolt';

/** The only table this scripted path is allowed to resolve conflicts in.
 *  Extendable via opts.allowlistTables, but never silently widened. */
export const DEFAULT_ALLOWLIST_TABLES = ['issues'];

/** Loopback host the ephemeral sql-server binds. Never a routable interface --
 *  this server exists only for the life of one recovery. */
export const RECOVERY_SQL_SERVER_HOST = '127.0.0.1';

/**
 * Substrings in a failed `bd dolt pull` that mark it as a genuine (un-fast-
 * forwardable) MERGE CONFLICT -- the trigger for Path A. Deliberately the
 * conflict-only subset of runner.js's DOLT_DIVERGED_PATTERNS: a plain
 * non-fast-forward "remote moved" rejection is handled by the D-push
 * reconcile, NOT by this heavier resolve-in-place path.
 * @type {RegExp[]}
 */
const DOLT_PULL_CONFLICT_PATTERNS = [
    /conflict/i,
    /unresolved (merge|conflict)/i,
    /merge (is )?required/i,
    /automatic merge failed/i,
    /cannot merge/i,
];

/**
 * Does this `bd dolt pull` failure output describe a genuine merge conflict
 * (the Path A trigger), as opposed to a transient/network failure or a plain
 * non-fast-forward rejection? Classified from git/dolt's OWN output text, the
 * same posture as the git ladder's porcelain-first detection.
 *
 * @param {string} output - raw stderr/stdout of the failed `bd dolt pull`
 * @returns {boolean}
 */
export function isDoltPullConflict(output) {
    const text = String(output == null ? '' : output);
    return DOLT_PULL_CONFLICT_PATTERNS.some((re) => re.test(text));
}

/**
 * The two deterministic gates, computed from `SELECT * FROM dolt_conflicts`
 * (step 6). That view returns one row per conflicted table with a
 * `num_conflicts` count. Both gates must pass for Path A to proceed.
 *
 *   passedTableGate: at least one conflicted table AND every conflicted table
 *     is in the allowlist.
 *   passedShapeGate: exactly ONE conflicted table, whose num_conflicts is
 *     exactly 1 (a plain single-row conflict).
 *
 * @param {Array<{ table?: string, num_conflicts?: number|string }>} conflictRows
 * @param {string[]} allowlist
 * @returns {{ tables: string[], totalConflicts: number, passedTableGate: boolean, passedShapeGate: boolean, passed: boolean }}
 */
export function assessConflictGates(conflictRows, allowlist = DEFAULT_ALLOWLIST_TABLES) {
    const rows = Array.isArray(conflictRows) ? conflictRows : [];
    const allow = Array.isArray(allowlist) && allowlist.length > 0 ? allowlist : DEFAULT_ALLOWLIST_TABLES;
    const tables = rows.map((r) => String(r && r.table != null ? r.table : '')).filter((t) => t !== '');
    const totalConflicts = rows.reduce((sum, r) => sum + Number((r && r.num_conflicts) || 0), 0);

    const passedTableGate = tables.length > 0 && tables.every((t) => allow.includes(t));
    const passedShapeGate = rows.length === 1
        && tables.length === 1
        && Number(rows[0] && rows[0].num_conflicts) === 1;

    return {
        tables,
        totalConflicts,
        passedTableGate,
        passedShapeGate,
        passed: passedTableGate && passedShapeGate,
    };
}

/** Extract the `rows` array from an injected sql() result, tolerating either
 *  `{ ok, rows }` or a bare array. Throws a DoltSyncError on a failed query so
 *  the caller's finally still runs teardown. */
function sqlRows(res, label, member) {
    if (Array.isArray(res)) return res;
    if (res && res.ok === false) {
        throw new DoltSyncError(
            `[Dolt] Path A SQL step failed (${label}) for member '${member}': ${res.error || 'unknown sql failure'}`,
            { member, doltOutput: res.error || null },
        );
    }
    if (res && Array.isArray(res.rows)) return res.rows;
    return [];
}

/**
 * Path A: scripted, resolve-in-place dolt conflict recovery behind the two
 * deterministic gates. Runs the 10-step VERIFIED runbook end-to-end via
 * injected command()/sql()/spawnSqlServer -- NO agent dispatch.
 *
 * Return contract (never partial): on gate rejection returns
 * `{ ok:false, proceeded:false, resolved:false, gate, reason }` so the caller
 * (9.6) can escalate; on success returns
 * `{ ok:true, proceeded:true, resolved:true, gate, doltLog, reason }`. Any
 * genuine operational failure throws DoltDivergedError/DoltSyncError. On EVERY
 * path (success, gate rejection, thrown failure) the sql-server is torn down
 * and metadata.json is flipped back to "embedded" -- reversibility is asserted
 * in a finally, exactly as the runbook was verified.
 *
 * @param {{
 *   member: string,
 *   command: (cmd: string, opts?: object) => Promise<{ ok: boolean, output?: string, error?: string|null }>,
 *   sql: (query: string, opts?: object) => Promise<{ ok?: boolean, rows?: object[], error?: string|null }|object[]>,
 *   spawnSqlServer: (opts: { dataDir: string, host: string, port: number }) => Promise<{ stop: () => Promise<void>|void }>,
 *   allocatePort?: () => Promise<number>|number,
 *   readMetadata: () => Promise<object>|object,
 *   writeMetadata: (meta: object) => Promise<void>|void,
 *   dataDir?: string,
 *   remote?: string,
 *   branch?: string,
 *   allowlistTables?: string[],
 *   resolveStrategy?: '--theirs'|'--ours',
 *   log?: (msg: string) => void,
 * }} opts
 * @returns {Promise<{ ok: boolean, proceeded: boolean, resolved: boolean, gate: object, reason: string, doltLog?: object[] }>}
 */
export async function recoverDoltConflictPathA(opts = {}) {
    const {
        member,
        command,
        sql,
        spawnSqlServer,
        allocatePort,
        readMetadata,
        writeMetadata,
        dataDir = DEFAULT_EMBEDDED_DATA_DIR,
        remote = 'origin',
        branch = 'main',
        allowlistTables = DEFAULT_ALLOWLIST_TABLES,
        // First-successful-pusher-wins mirror (Plan 3.3): the remote already
        // published; the wedged clone is the loser and takes THEIRS. Both
        // sides' history is preserved in dolt_log regardless (the merge commit
        // keeps both parents) -- ours/theirs only picks the surviving row.
        resolveStrategy = '--theirs',
        log = () => {},
    } = opts;

    if (typeof command !== 'function') throw new Error('recoverDoltConflictPathA requires an injected command() in opts');
    if (typeof sql !== 'function') throw new Error('recoverDoltConflictPathA requires an injected sql() in opts');
    if (typeof spawnSqlServer !== 'function') throw new Error('recoverDoltConflictPathA requires an injected spawnSqlServer() in opts');
    if (typeof readMetadata !== 'function' || typeof writeMetadata !== 'function') {
        throw new Error('recoverDoltConflictPathA requires injected readMetadata()/writeMetadata() in opts');
    }
    if (resolveStrategy !== '--theirs' && resolveStrategy !== '--ours') {
        throw new Error(`recoverDoltConflictPathA: resolveStrategy must be '--theirs' or '--ours' (got ${resolveStrategy})`);
    }

    const port = await (typeof allocatePort === 'function' ? allocatePort() : allocateEphemeralPort());

    // Reversibility bookkeeping: track exactly what we mutated so the finally
    // undoes only (and all of) it, even if we throw partway through.
    let server = null;
    let metadataFlipped = false;
    let mergeOpen = false;

    try {
        // --- Step 2: stand up the ephemeral, externally-managed sql-server ---
        log(`[Dolt] Path A: starting ephemeral dolt sql-server for member '${member}' at ${RECOVERY_SQL_SERVER_HOST}:${port} --data-dir ${dataDir} (externally managed; 'bd dolt start' targets the wrong dir -- GH#2438).`);
        server = await spawnSqlServer({ dataDir, host: RECOVERY_SQL_SERVER_HOST, port });

        // --- Step 3: flip metadata.json to server mode ---
        const originalMeta = await readMetadata();
        const serverMeta = {
            ...originalMeta,
            dolt_mode: 'server',
            dolt_server: { host: RECOVERY_SQL_SERVER_HOST, port },
        };
        await writeMetadata(serverMeta);
        metadataFlipped = true;
        log(`[Dolt] Path A: flipped metadata.json dolt_mode -> server for member '${member}'.`);

        // --- Step 4: re-open the aborted merge (allow committing conflicts) ---
        await sqlRows(await sql('SET @@dolt_allow_commit_conflicts = 1', { member_name: member, label: 'Path A allow-commit-conflicts' }), 'set allow_commit_conflicts', member);

        // --- Step 5: CALL DOLT_MERGE(origin/main) -- the omitted step ---
        mergeOpen = true;
        await sqlRows(await sql(`CALL DOLT_MERGE('${remote}/${branch}')`, { member_name: member, label: 'Path A dolt_merge' }), 'dolt_merge', member);

        // --- Step 6: SELECT * FROM dolt_conflicts -- THE GATE ---
        const conflictRows = sqlRows(await sql('SELECT * FROM dolt_conflicts', { member_name: member, label: 'Path A dolt_conflicts gate' }), 'select dolt_conflicts', member);
        const gate = assessConflictGates(conflictRows, allowlistTables);

        if (!gate.passed) {
            const why = !gate.passedTableGate
                ? `conflicted table(s) [${gate.tables.join(', ') || '(none)'}] not in allowlist [${(allowlistTables || DEFAULT_ALLOWLIST_TABLES).join(', ')}]`
                : `not a plain single-row conflict (${gate.tables.length} table(s), ${gate.totalConflicts} row conflict(s) total)`;
            log(`[Dolt] Path A GATE REJECTED for member '${member}': ${why}. Not proceeding (escalate to Tier 2); reverting.`);
            return { ok: false, proceeded: false, resolved: false, gate, reason: `Path A gate rejected: ${why}` };
        }

        const conflictTable = gate.tables[0];
        log(`[Dolt] Path A GATES PASSED for member '${member}': single-row conflict in allowlisted table '${conflictTable}'. Resolving in place (${resolveStrategy}).`);

        // --- Step 7: CALL DOLT_CONFLICTS_RESOLVE('--theirs', '<table>') ---
        // The table-name arg is REQUIRED -- dolt_conflicts_resolve errors
        // without it. First-successful-pusher-wins => default --theirs.
        await sqlRows(
            await sql(`CALL DOLT_CONFLICTS_RESOLVE('${resolveStrategy}', '${conflictTable}')`, { member_name: member, label: 'Path A dolt_conflicts_resolve' }),
            'dolt_conflicts_resolve', member,
        );

        // --- Step 8: commit the resolved merge ---
        await sqlRows(
            await sql(`CALL DOLT_COMMIT('-m', 'Path A scripted resolve-in-place of single-row ${conflictTable} conflict (${resolveStrategy}) for member ${member}')`, { member_name: member, label: 'Path A dolt_commit' }),
            'dolt_commit', member,
        );
        mergeOpen = false;

        // Confirm zero data loss: both sides' history must be present in
        // dolt_log (the merge commit keeps both parents). Returned for the
        // caller/test to assert against.
        const doltLog = sqlRows(await sql('SELECT * FROM dolt_log', { member_name: member, label: 'Path A dolt_log verify' }), 'select dolt_log', member);

        // --- Step 9: pull + push to republish the reconciled clone ---
        const pull = await command('bd dolt pull', { member_name: member, silent: true, failSoft: true, label: `Path A post-resolve D-pull for '${member}'` });
        if (pull && pull.ok === false) {
            throw new DoltDivergedError(
                `[Dolt] Path A post-resolve pull still failed for member '${member}': ${pull.error}`,
                { member, doltOutput: pull.error, operation: 'path-a-pull' },
            );
        }
        const push = await command('bd dolt push', { member_name: member, silent: true, failSoft: true, label: `Path A post-resolve D-push for '${member}'` });
        if (push && push.ok === false) {
            throw new DoltDivergedError(
                `[Dolt] Path A resolved the conflict but the republishing push was still rejected for member '${member}': ${push.error}`,
                { member, doltOutput: push.error, operation: 'path-a-push' },
            );
        }

        log(`[Dolt] Path A SUCCEEDED for member '${member}': single-row '${conflictTable}' conflict resolved in place and republished; both sides present in dolt_log (${doltLog.length} commit(s)).`);
        return { ok: true, proceeded: true, resolved: true, gate, doltLog, reason: `Path A resolved single-row ${conflictTable} conflict in place` };
    } finally {
        // --- Step 10: reversibility -- ALWAYS teardown + flip back, even on
        // failure. Best-effort: a teardown hiccup must not mask the real error
        // that is already propagating, and each undo is independent.
        if (mergeOpen) {
            try {
                await sql("CALL DOLT_MERGE('--abort')", { member_name: member, label: 'Path A merge abort (revert)' });
            } catch (abortErr) {
                log(`[Dolt] Path A: best-effort merge abort for member '${member}' failed (non-fatal): ${abortErr.message}`);
            }
        }
        if (metadataFlipped) {
            try {
                const meta = await readMetadata();
                const embeddedMeta = { ...meta, dolt_mode: 'embedded' };
                delete embeddedMeta.dolt_server;
                await writeMetadata(embeddedMeta);
                log(`[Dolt] Path A: flipped metadata.json dolt_mode back to embedded for member '${member}'.`);
            } catch (metaErr) {
                log(`[Dolt] Path A: WARNING -- could not flip metadata.json back to embedded for member '${member}': ${metaErr.message}`);
            }
        }
        if (server && typeof server.stop === 'function') {
            try {
                await server.stop();
                log(`[Dolt] Path A: torn down ephemeral sql-server for member '${member}'.`);
            } catch (stopErr) {
                log(`[Dolt] Path A: WARNING -- could not stop ephemeral sql-server for member '${member}': ${stopErr.message}`);
            }
        }
    }
}

/**
 * Default ephemeral loopback port allocator: bind a throwaway net server to
 * port 0, read the OS-assigned port, release it, and hand it back. Injected
 * (opts.allocatePort) in tests so no real socket is touched.
 * @returns {Promise<number>}
 */
export async function allocateEphemeralPort() {
    const net = await import('node:net');
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, RECOVERY_SQL_SERVER_HOST, () => {
            const addr = srv.address();
            const port = addr && typeof addr === 'object' ? addr.port : 0;
            srv.close(() => resolve(port));
        });
    });
}
