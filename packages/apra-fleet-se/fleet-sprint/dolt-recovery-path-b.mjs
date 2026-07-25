// apra-fleet-eft.9.5 (Plan 3.4 -- Dolt conflict recovery ladder, Path B).
//
// Path B is the FALLBACK dolt recovery for a wedged clone that Path A
// (dolt-recovery.mjs, apra-fleet-eft.9.4) refuses to touch: either the
// conflict shape failed one of Path A's two deterministic gates
// (multi-row, or a table outside the allowlist), or a genuine operational
// failure made resolve-in-place unsafe. Where Path A resolves the conflict
// in place with zero data loss, Path B is deliberately more destructive but
// simpler and more robust: DISCARD the wedged clone's local dolt state
// entirely and re-bootstrap fresh from the shared remote, then replay back
// in the ONE local mutation that mattered (the doer streak's own write that
// triggered the D-push in the first place). Everything else the loser
// clone had locally that never made it to the remote is discarded on
// purpose -- by construction (single-writer token passing, one streak
// between D-pull and D-push) that is always small, and it is enumerated in
// the log rather than silently dropped.
//
// -----------------------------------------------------------------------------
// The VERIFIED runbook (implemented exactly, in this order):
//
//   1. Guard (Windows gotcha #1): assert config.yaml exists and still
//      carries a non-empty `sync.remote` BEFORE touching anything. On
//      Windows, `bd bootstrap` derives a broken `git+C:/...` URL when
//      sync.remote is absent from config.yaml -- config.yaml is therefore
//      the one file this recovery NEVER removes, but if it already lacks
//      sync.remote the same breakage would occur regardless of how careful
//      we are, so this is checked and escalated (never silently proceeded
//      past) rather than discovered after the fact.
//   2. Enumerate: log every piece of local-only state about to be
//      discarded (opts.listLocalState), so the loser clone's other
//      unsynced writes are never silently dropped from the record even
//      though they are not recovered.
//   3. Discard: remove `.beads/embeddeddolt`, `.beads/metadata.json`,
//      `.beads/backup` -- KEEPING config.yaml untouched.
//   4. Re-bootstrap: `BD_NON_INTERACTIVE=1 bd bootstrap --yes` against the
//      now-clean `.beads` dir (config.yaml + its sync.remote still in
//      place is what lets bootstrap re-clone the shared remote correctly).
//   5. Windows gotcha #2 guard: if that bootstrap attempt fails because a
//      leftover EMPTY database is still on disk (isBootstrapEmptyDbFailure
//      classifies this from bootstrap's own output text), remove
//      `.beads/embeddeddolt` again and retry bootstrap exactly ONCE more --
//      bounded, never an unbounded retry loop.
//   6. Replay: re-issue the ONE pending mutation (opts.pendingMutation) --
//      the loser clone's own local write -- against the freshly bootstrapped
//      clone, so it is not lost even though everything else local was
//      discarded in step 3.
//   7. Republish: `bd dolt push` the replayed mutation back to the shared
//      remote.
//
// Any genuine operational failure (guard failure, bootstrap failure that
// survives the one bounded retry, a failed mutation replay, or a push still
// rejected) throws a typed DoltSyncError/DoltDivergedError so the caller
// (Tier 2 escalation, apra-fleet-eft.9.6) can route it onward -- Path B never
// silently swallows a failure the way it deliberately discards non-critical
// local state.
// =============================================================================

import { DoltDivergedError, DoltSyncError } from './errors.mjs';

/** The three paths Path B ALWAYS removes (in this order), never anything
 *  else. `.beads/config.yaml` (with its `sync.remote`) is deliberately never
 *  in this list -- see Windows gotcha #1 in the module doc above. */
export const DEFAULT_PATH_B_REMOVE_PATHS = [
    '.beads/embeddeddolt',
    '.beads/metadata.json',
    '.beads/backup',
];

/** The one path this recovery must NEVER remove. */
export const DEFAULT_CONFIG_PATH = '.beads/config.yaml';

/** Default local-backup dir enumerated (not removed by this module directly
 *  -- it is one of DEFAULT_PATH_B_REMOVE_PATHS -- but its contents are
 *  listed BEFORE removal so the discard is enumerated, not silent). */
export const DEFAULT_BACKUP_DIR = '.beads/backup';

/** Default embedded dolt data dir, re-removed on the bounded Windows
 *  gotcha #2 retry (a leftover empty DB there makes the first bootstrap
 *  retry fail until it is removed again). */
export const DEFAULT_EMBEDDED_DATA_DIR = '.beads/embeddeddolt';

/**
 * Substrings in a failed `bd bootstrap` attempt that mark it as the verified
 * Windows gotcha #2: a leftover EMPTY database left on disk (e.g. by a
 * partially-completed prior bootstrap) makes the retry fail until
 * `.beads/embeddeddolt` is removed again. Distinguished from any other
 * bootstrap failure, which is NOT retried and instead thrown.
 * @type {RegExp[]}
 */
const BOOTSTRAP_EMPTY_DB_PATTERNS = [
    /database already exists/i,
    /directory not empty/i,
    /already initiali[sz]ed/i,
    /empty (database|db)/i,
    /existing (dolt )?data ?dir/i,
];

/**
 * Does this `bd bootstrap` failure output describe the verified Windows
 * gotcha #2 (leftover empty DB), as opposed to any other bootstrap failure
 * that must not be blindly retried?
 *
 * @param {string} output
 * @returns {boolean}
 */
export function isBootstrapEmptyDbFailure(output) {
    const text = String(output == null ? '' : output);
    return BOOTSTRAP_EMPTY_DB_PATTERNS.some((re) => re.test(text));
}

/**
 * Naive (dependency-free) check for a non-empty `sync.remote` under a
 * top-level `sync:` block in a config.yaml's raw text. Deliberately not a
 * full YAML parse (no yaml dependency in this package) -- Path B only ever
 * needs a yes/no guard on this one field, and callers/tests can inject their
 * own `readConfig` for anything more precise.
 *
 * @param {string} raw
 * @returns {boolean}
 */
export function hasSyncRemoteInYaml(raw) {
    const text = String(raw == null ? '' : raw);
    const syncBlockMatch = text.match(/^sync:\s*\n((?:[ \t]+.*\n?)*)/m);
    if (!syncBlockMatch) return false;
    return /remote:\s*\S+/.test(syncBlockMatch[1]);
}

/**
 * Default `readConfig()`: reads DEFAULT_CONFIG_PATH off disk and reports
 * whether it exists and carries a non-empty `sync.remote`. Injectable
 * (opts.readConfig) in tests so no real filesystem is touched.
 *
 * @param {string} [configPath]
 * @returns {Promise<{ exists: boolean, raw: string|null, hasSyncRemote: boolean }>}
 */
export async function defaultReadConfig(configPath = DEFAULT_CONFIG_PATH) {
    const fs = await import('node:fs/promises');
    let raw = null;
    try {
        raw = await fs.readFile(configPath, 'utf8');
    } catch {
        return { exists: false, raw: null, hasSyncRemote: false };
    }
    return { exists: true, raw, hasSyncRemote: hasSyncRemoteInYaml(raw) };
}

/**
 * Default `removePath()`: `fs.rm(path, { recursive: true, force: true })`.
 * Cross-platform (works identically on Windows and POSIX) -- deliberately
 * NOT a shelled-out `rm -rf`, which does not exist natively on Windows.
 * Injectable (opts.removePath) in tests so no real filesystem is touched.
 *
 * @param {string} targetPath
 * @returns {Promise<void>}
 */
export async function defaultRemovePath(targetPath) {
    const fs = await import('node:fs/promises');
    await fs.rm(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/**
 * Default `listLocalState()`: enumerates the contents of the local backup
 * dir (the one piece of loser-clone-only state most likely to hold real,
 * never-to-be-recovered local writes) so the discard is logged rather than
 * silent. Injectable (opts.listLocalState) in tests so no real filesystem is
 * touched.
 *
 * @param {string} [backupDir]
 * @returns {Promise<string[]>}
 */
export async function defaultListLocalState(backupDir = DEFAULT_BACKUP_DIR) {
    const fs = await import('node:fs/promises');
    try {
        const entries = await fs.readdir(backupDir);
        if (entries.length === 0) {
            return [`local backup dir '${backupDir}' is empty (nothing else to discard there)`];
        }
        return [`local backup dir '${backupDir}' contains ${entries.length} file(s), about to be discarded: ${entries.join(', ')}`];
    } catch {
        return [`local backup dir '${backupDir}' does not exist (nothing to enumerate there)`];
    }
}

/**
 * Path B: discard-and-re-bootstrap fallback dolt conflict recovery, with
 * mutation replay and the two verified Windows gotchas guarded. Runs the
 * VERIFIED runbook end-to-end via injected command()/removePath()/
 * readConfig()/listLocalState() -- no agent dispatch.
 *
 * Return contract (never partial): on success returns
 * `{ ok:true, recovered:true, mutationReplayed, removedPaths, discarded, reason }`.
 * Any genuine operational failure (config guard, bootstrap failure surviving
 * the one bounded retry, a failed mutation replay, or a still-rejected
 * republish push) throws DoltSyncError/DoltDivergedError so the caller
 * (apra-fleet-eft.9.6 Tier 2 escalation) can route it onward.
 *
 * @param {{
 *   member: string,
 *   command: (cmd: string, opts?: object) => Promise<{ ok: boolean, output?: string, error?: string|null }>,
 *   readConfig?: (configPath?: string) => Promise<{ exists: boolean, raw: string|null, hasSyncRemote: boolean }>,
 *   removePath?: (targetPath: string) => Promise<void>,
 *   listLocalState?: () => Promise<string[]>,
 *   configPath?: string,
 *   removePaths?: string[],
 *   embeddedDataDir?: string,
 *   pendingMutation?: { description: string, cmd: string } | null,
 *   log?: (msg: string) => void,
 * }} opts
 * @returns {Promise<{ ok: boolean, recovered: boolean, mutationReplayed: boolean, removedPaths: string[], discarded: string[], reason: string }>}
 */
export async function recoverDoltConflictPathB(opts = {}) {
    const {
        member,
        command,
        readConfig = defaultReadConfig,
        removePath = defaultRemovePath,
        listLocalState = defaultListLocalState,
        configPath = DEFAULT_CONFIG_PATH,
        removePaths = DEFAULT_PATH_B_REMOVE_PATHS,
        embeddedDataDir = DEFAULT_EMBEDDED_DATA_DIR,
        pendingMutation = null,
        log = () => {},
    } = opts;

    if (typeof command !== 'function') throw new Error('recoverDoltConflictPathB requires an injected command() in opts');
    if (typeof readConfig !== 'function') throw new Error('recoverDoltConflictPathB requires an injected readConfig() in opts');
    if (typeof removePath !== 'function') throw new Error('recoverDoltConflictPathB requires an injected removePath() in opts');
    if (typeof listLocalState !== 'function') throw new Error('recoverDoltConflictPathB requires an injected listLocalState() in opts');

    // --- Step 1: Windows gotcha #1 guard -- config.yaml must exist and
    // already carry a non-empty sync.remote BEFORE we touch anything. We
    // never remove config.yaml, but if it already lacks sync.remote the
    // broken git+C:/ URL derivation would happen regardless of that care. ---
    const configBefore = await readConfig(configPath);
    if (!configBefore || !configBefore.exists) {
        throw new DoltSyncError(
            `[Dolt] Path B guard failed for member '${member}': '${configPath}' does not exist -- cannot safely re-bootstrap (Windows gotcha #1: bootstrap derives a broken git+C:/ URL without sync.remote). Escalating rather than proceeding blind.`,
            { member, doltOutput: null },
        );
    }
    if (!configBefore.hasSyncRemote) {
        throw new DoltSyncError(
            `[Dolt] Path B guard failed for member '${member}': '${configPath}' has no 'sync.remote' set -- re-bootstrapping would hit the verified Windows gotcha #1 (broken git+C:/ URL derivation). Escalating rather than proceeding blind.`,
            { member, doltOutput: configBefore.raw },
        );
    }
    log(`[Dolt] Path B guard passed for member '${member}': '${configPath}' present with sync.remote set -- safe to discard and re-bootstrap.`);

    // --- Step 2: enumerate what is about to be discarded (never silent) ---
    const discarded = await listLocalState();
    for (const line of discarded) {
        log(`[Dolt] Path B for member '${member}': DISCARDING (will NOT be recovered) -- ${line}`);
    }

    // --- Step 3: discard the wedged clone's local dolt state, keeping
    // config.yaml untouched ---
    const removedPaths = [];
    for (const p of removePaths) {
        log(`[Dolt] Path B for member '${member}': removing '${p}'.`);
        await removePath(p);
        removedPaths.push(p);
    }

    // --- Step 4: re-bootstrap fresh from the shared remote ---
    const bootstrapCmd = 'BD_NON_INTERACTIVE=1 bd bootstrap --yes';
    let bootstrap = await command(bootstrapCmd, { member_name: member, silent: true, failSoft: true, label: `Path B bootstrap for '${member}'` });

    // --- Step 5: Windows gotcha #2 -- a leftover empty DB fails the first
    // bootstrap attempt until embeddeddolt is removed again. Bounded: exactly
    // ONE retry, never an unbounded loop. ---
    if (bootstrap && bootstrap.ok === false && isBootstrapEmptyDbFailure(bootstrap.error || bootstrap.output)) {
        log(`[Dolt] Path B for member '${member}': bootstrap failed with the verified Windows gotcha #2 (leftover empty DB) -- removing '${embeddedDataDir}' again and retrying bootstrap ONCE.`);
        await removePath(embeddedDataDir);
        bootstrap = await command(bootstrapCmd, { member_name: member, silent: true, failSoft: true, label: `Path B bootstrap retry (gotcha #2) for '${member}'` });
    }

    if (bootstrap && bootstrap.ok === false) {
        throw new DoltSyncError(
            `[Dolt] Path B bootstrap failed for member '${member}' and did not recover after the bounded gotcha #2 retry: ${bootstrap.error}`,
            { member, doltOutput: bootstrap.error },
        );
    }
    log(`[Dolt] Path B for member '${member}': re-bootstrapped clean from the shared remote.`);

    // --- Step 6: replay the one pending mutation, so it is not lost even
    // though everything else local was just discarded ---
    let mutationReplayed = false;
    if (pendingMutation && pendingMutation.cmd) {
        log(`[Dolt] Path B for member '${member}': replaying the one pending mutation -- ${pendingMutation.description || pendingMutation.cmd}`);
        const replay = await command(pendingMutation.cmd, { member_name: member, silent: true, failSoft: true, label: `Path B mutation replay for '${member}'` });
        if (replay && replay.ok === false) {
            throw new DoltSyncError(
                `[Dolt] Path B re-bootstrapped member '${member}' but replaying the pending mutation failed -- it would be lost: ${replay.error}`,
                { member, doltOutput: replay.error },
            );
        }
        mutationReplayed = true;
    } else {
        log(`[Dolt] Path B for member '${member}': no pending mutation to replay.`);
    }

    // --- Step 7: republish the replayed clone ---
    const push = await command('bd dolt push', { member_name: member, silent: true, failSoft: true, label: `Path B post-recovery D-push for '${member}'` });
    if (push && push.ok === false) {
        throw new DoltDivergedError(
            `[Dolt] Path B recovered and replayed member '${member}' but the republishing push was still rejected: ${push.error}`,
            { member, doltOutput: push.error, operation: 'path-b-push' },
        );
    }

    log(`[Dolt] Path B SUCCEEDED for member '${member}': discarded and re-bootstrapped clean, replayed ${mutationReplayed ? 'the pending mutation' : 'no pending mutation'}, and republished.`);
    return {
        ok: true,
        recovered: true,
        mutationReplayed,
        removedPaths,
        discarded,
        reason: `Path B discarded and re-bootstrapped member '${member}'${mutationReplayed ? ', replayed the pending mutation,' : ''} and republished`,
    };
}
