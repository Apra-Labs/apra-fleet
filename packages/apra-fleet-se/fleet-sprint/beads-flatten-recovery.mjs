// =============================================================================
// Automatic recovery of a beads clone whose shared remote no longer shares
// history with it (a flattened or otherwise rewritten remote): the pull fails
// with "no common ancestor" (dolt-sync.mjs DoltUnrelatedHistoryError) and no
// merge can ever succeed. The only fix is to re-bootstrap the clone from the
// remote -- which would silently drop any local work the remote does not hold.
//
// One implementation, several callers: the sprint-launch beads-health gate
// (dolt-sync.mjs preflightBeadsHealthGate), the member beads set-up
// (beads-identity-check.mjs setupMemberBeads), the identity preflight's
// no-database path (leftover restore only) and the operator entry point
// dolt-sync.mjs repair().
//
// The procedure (every step one member-bound command, built per member
// OS/shell by the SE command primitives -- never shell variable expansion):
//
//   1. Export the clone (`bd export --all`) into .beads, BEFORE anything
//      destructive, and read it back (every line must parse; the count bd
//      reports must match).
//   2. Rename .beads to `.beads.flatten-pending-<stamp>` (never delete), seed
//      a new .beads with the old config files, check `bd bootstrap` would
//      clone from the remote, `bd bootstrap --yes`, export the fresh clone.
//   3. Compare (findLocalOnlyWork): a record is local-only work when its id
//      is absent from the fresh export, or its local updated_at is newer
//      (a memory: its value differs).
//   4. No local-only work: re-check with `bd status`, rename the pending
//      backup to `.beads.flatten-backup-<stamp>` (the "recovery finished"
//      marker) and log ONE warning naming the member, the backup path and
//      that the remote was flattened.
//   5. Local-only work: REFUSE -- the fresh clone is moved aside and dropped,
//      the original .beads is renamed back (left exactly as before, plus the
//      two export files) and BeadsFlattenRecoveryRefusedError names the ids,
//      the export path and the manual fix. Nothing is ever auto-replayed.
//   6. Any step failing after the rename puts the original .beads back the
//      same way before BeadsFlattenRecoveryFailedError is thrown. A pending
//      backup found later (a crash mid-recovery) is restored before anything
//      else runs (restoreLeftoverFlattenBackup).
//
// The backup and export names are kept out of every later commit on the
// member (git info/exclude, a no-op outside a git work tree).
//
// ASCII only.
// =============================================================================

import { BeadsFlattenRecoveryFailedError, BeadsFlattenRecoveryRefusedError } from './errors.mjs';

export const BEADS_DIR = '.beads';
export const FLATTEN_PENDING_PREFIX = '.beads.flatten-pending-';
export const FLATTEN_BACKUP_PREFIX = '.beads.flatten-backup-';
export const FLATTEN_DISCARD_PREFIX = '.beads.flatten-discard-';
export const FLATTEN_LOCAL_EXPORT = 'flatten-recovery-local.jsonl';
export const FLATTEN_FRESH_EXPORT = 'flatten-recovery-fresh.jsonl';
// The beads config files carried into the re-bootstrapped .beads (the sync
// remote lives in one of them; bootstrap needs it to clone).
export const FLATTEN_CARRIED_CONFIG = Object.freeze(['config.yaml', 'config.local.yaml']);
// git info/exclude entries: no '/' so they match below a work folder that is
// a subdirectory of its repository too.
export const FLATTEN_GIT_EXCLUDES = Object.freeze(['.beads.flatten-*', 'flatten-recovery-*.jsonl']);
export const FLATTEN_RECOVERY_WARNING_PREFIX = '[beads-flatten-recovery] WARNING: ';
// A bootstrap clones the whole beads history.
export const FLATTEN_RECOVERY_TIMEOUT_S = 600;

export const FLATTEN_RECOVERY_COMMANDS = Object.freeze({
    exportTo: (relPath) => `bd export --all -o ${relPath}`,
    plan: 'bd bootstrap --dry-run --json',
    bootstrap: 'bd bootstrap --yes',
    status: 'bd status --json',
});

const LABEL = 'beads-flatten-recovery';

/** A sortable, path-safe stamp: 2026-11-25T07:00:28.123Z -> 20261125T070028123Z. */
export function flattenStamp(nowMs) {
    return new Date(nowMs).toISOString().replace(/[^0-9TZ]/g, '');
}

function summarize(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return '(no output)';
    return t.length > 400 ? `${t.slice(0, 400)}...` : t;
}

function parseFirstJson(text) {
    const t = String(text || '');
    const start = t.indexOf('{');
    if (start < 0) return null;
    try {
        return JSON.parse(t.slice(start));
    } catch {
        return null;
    }
}

/**
 * Parse a `bd export` JSONL body into records. Every non-blank line must be
 * a JSON object -- a truncated or garbled read throws instead of silently
 * dropping records (a dropped local record would hide local-only work).
 * @param {string} text
 * @returns {object[]}
 */
export function parseBeadsExport(text) {
    const records = [];
    const lines = String(text || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        let obj;
        try {
            obj = JSON.parse(line);
        } catch {
            throw new Error(`line ${i + 1} of the export is not JSON (${summarize(line)})`);
        }
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            throw new Error(`line ${i + 1} of the export is not a JSON object`);
        }
        records.push(obj);
    }
    return records;
}

/**
 * The record count `bd export -o` reports ("Exported 2 issues and 1
 * memories to ..."), or null when the output carries no such line.
 * @param {string} output
 * @returns {number|null}
 */
export function parseExportCount(output) {
    const m = /Exported\s+(\d+)\s+issues?(?:\s+and\s+(\d+)\s+memor(?:y|ies))?/i.exec(String(output || ''));
    if (!m) return null;
    return Number(m[1]) + (m[2] ? Number(m[2]) : 0);
}

/** The comparison key of an export record: issue id, or memory:<key>. */
export function exportRecordKey(record) {
    if (!record || typeof record !== 'object') return null;
    if (record._type === 'memory') return typeof record.key === 'string' && record.key ? `memory:${record.key}` : null;
    return typeof record.id === 'string' && record.id ? record.id : null;
}

function isNewer(localTs, freshTs) {
    const l = Date.parse(String(localTs || ''));
    const f = Date.parse(String(freshTs || ''));
    if (Number.isNaN(l) || Number.isNaN(f)) {
        // Unreadable timestamps: different strings count as local work
        // (the safe direction -- a refusal never loses data).
        return String(localTs || '') !== String(freshTs || '');
    }
    return l > f;
}

/**
 * The local-only work of a clone: records of the LOCAL export the FRESH
 * export (the rewritten remote) does not hold -- an id absent from it, or a
 * local updated_at newer than the fresh copy's (a memory: a different value).
 * Pure.
 * @param {object[]} localRecords
 * @param {object[]} freshRecords
 * @returns {Array<{ id: string, reason: 'absent'|'newer'|'changed', localUpdatedAt?: string, freshUpdatedAt?: string }>}
 */
export function findLocalOnlyWork(localRecords, freshRecords) {
    const fresh = new Map();
    for (const r of freshRecords || []) {
        const k = exportRecordKey(r);
        if (k) fresh.set(k, r);
    }
    const out = [];
    for (const r of localRecords || []) {
        const k = exportRecordKey(r);
        if (!k) continue;
        const f = fresh.get(k);
        if (!f) {
            out.push({ id: k, reason: 'absent', localUpdatedAt: r.updated_at });
            continue;
        }
        if (r._type === 'memory') {
            if (String(r.value ?? '') !== String(f.value ?? '')) out.push({ id: k, reason: 'changed' });
            continue;
        }
        if (isNewer(r.updated_at, f.updated_at)) {
            out.push({ id: k, reason: 'newer', localUpdatedAt: r.updated_at, freshUpdatedAt: f.updated_at });
        }
    }
    return out;
}

/** Pick what a leftover check must put back, from a work-folder listing. */
export function pickLeftoverBackup(names) {
    const list = (names || []).map((n) => String(n).trim()).filter(Boolean);
    const hasBeads = list.includes(BEADS_DIR);
    const pending = list.filter((n) => n.startsWith(FLATTEN_PENDING_PREFIX)).sort();
    if (pending.length) return { backup: pending[pending.length - 1], pending: true, hasBeads };
    if (hasBeads) return { backup: null, pending: false, hasBeads };
    const finished = list.filter((n) => n.startsWith(FLATTEN_BACKUP_PREFIX)).sort();
    if (finished.length) return { backup: finished[finished.length - 1], pending: false, hasBeads };
    return { backup: null, pending: false, hasBeads };
}

function makeRunner({ command, member, timeoutS }) {
    return async (cmd) => {
        let res;
        try {
            res = await command(cmd, { member_name: member, silent: true, failSoft: true, label: LABEL, timeout_s: timeoutS });
        } catch (err) {
            res = { ok: false, output: '', error: err && err.message ? err.message : String(err) };
        }
        const output = res && typeof res === 'object' ? String(res.output || '') : String(res || '');
        const failed = res && typeof res === 'object' && res.ok === false;
        return { ok: !failed, output, error: failed ? String(res.error || 'command failed') : null };
    };
}

function assertShell(shell) {
    const need = ['listDirectory', 'renamePath', 'copyFileIfPresent', 'readFile', 'removeDirectory', 'ensureFile', 'ensureGitExcluded'];
    const missing = !shell ? need : need.filter((m) => typeof shell[m] !== 'function');
    if (missing.length) {
        throw new TypeError(`beads flatten recovery needs the member's SE command primitives (missing: ${missing.join(', ')})`);
    }
}

function build(fn) {
    try {
        return { cmd: String(fn() || '') };
    } catch (err) {
        return { cmd: '', error: err && err.message ? err.message : String(err) };
    }
}

/**
 * A crash mid-recovery leaves `.beads.flatten-pending-<stamp>` behind (with or
 * without a not-yet-verified fresh .beads); a missing .beads may also sit next
 * to a finished `.beads.flatten-backup-<stamp>`. Puts the original clone back
 * in both cases (an unverified fresh .beads is moved aside and dropped first).
 * Never throws for a listing it cannot read (logs and reports checked:false);
 * throws BeadsFlattenRecoveryFailedError when a restore it started fails.
 *
 * @param {{ command: Function, member: string, shell: object, log?: Function, timeoutS?: number, now?: () => number }} opts
 * @returns {Promise<{ checked: boolean, restored: boolean, backup?: string }>}
 */
export async function restoreLeftoverFlattenBackup({ command, member, shell, log = () => {}, timeoutS = FLATTEN_RECOVERY_TIMEOUT_S, now = Date.now }) {
    assertShell(shell);
    const run = makeRunner({ command, member, timeoutS });
    const listing = await run(shell.listDirectory('.'));
    if (!listing.ok) {
        log(`[beads-flatten-recovery] could not list the workFolder of member '${member}' to look for a recovery backup (continuing): ${summarize(listing.error || listing.output)}`);
        return { checked: false, restored: false };
    }
    const pick = pickLeftoverBackup(listing.output.split(/\r?\n/));
    if (!pick.backup) return { checked: true, restored: false };
    const discard = `${FLATTEN_DISCARD_PREFIX}${flattenStamp(now())}`;
    if (pick.hasBeads) {
        const aside = await run(shell.renamePath(BEADS_DIR, discard));
        if (!aside.ok) {
            throw new BeadsFlattenRecoveryFailedError(
                `[beads-flatten-recovery] member '${member}': an interrupted recovery left its original beads clone at '${pick.backup}', but the unverified '${BEADS_DIR}' could not be moved aside (${summarize(aside.error || aside.output)}). ` +
                `Fix: in that member's workFolder rename '${BEADS_DIR}' to any other name, rename '${pick.backup}' to '${BEADS_DIR}', then relaunch.`,
                { member, details: { step: 'leftover-aside', backup: pick.backup, restored: false } },
            );
        }
    }
    const back = await run(shell.renamePath(pick.backup, BEADS_DIR));
    if (!back.ok) {
        const movedNote = pick.hasBeads ? ` (the unverified clone was moved to '${discard}')` : '';
        throw new BeadsFlattenRecoveryFailedError(
            `[beads-flatten-recovery] member '${member}': could not restore its beads clone from the recovery backup '${pick.backup}' (${summarize(back.error || back.output)}). ` +
            `Fix: in that member's workFolder rename '${pick.backup}' to '${BEADS_DIR}'` + movedNote + ', then relaunch.',
            { member, details: { step: 'leftover-restore', backup: pick.backup, restored: false } },
        );
    }
    if (pick.hasBeads) {
        const rm = await run(shell.removeDirectory(discard));
        if (!rm.ok) log(`[beads-flatten-recovery] member '${member}': could not delete the discarded clone '${discard}' (delete it by hand): ${summarize(rm.error || rm.output)}`);
    }
    log(`${FLATTEN_RECOVERY_WARNING_PREFIX}member '${member}': ${pick.pending ? 'an interrupted beads recovery' : 'a missing .beads'} was found; restored the original beads clone from '${pick.backup}' before anything else ran.`);
    return { checked: true, restored: true, backup: pick.backup };
}

/**
 * Recover one clone whose pull failed with unrelated history (see the module
 * header for the procedure). Resolves when the clone was re-bootstrapped;
 * throws BeadsFlattenRecoveryRefusedError (local-only work, clone restored)
 * or BeadsFlattenRecoveryFailedError (a step failed, clone restored when
 * `details.restored`).
 *
 * @param {{ command: Function, member: string, shell: object, log?: Function, timeoutS?: number, now?: () => number, doltOutput?: string }} opts
 *   `shell` is the member's SE command primitives (getSeCommands); `doltOutput`
 *   the raw output of the failed pull, carried on the thrown errors.
 * @returns {Promise<{ recovered: true, backup: string, localExport: string, freshExport: string, totalIssues: number|null, issued: string[] }>}
 */
export async function recoverFlattenedClone({ command, member, shell, log = () => {}, timeoutS = FLATTEN_RECOVERY_TIMEOUT_S, now = Date.now, doltOutput = null }) {
    if (typeof command !== 'function') throw new TypeError('recoverFlattenedClone: command must be a function');
    assertShell(shell);
    const issued = [];
    const rawRun = makeRunner({ command, member, timeoutS });
    const run = async (cmd) => {
        issued.push(cmd);
        return rawRun(cmd);
    };
    const failed = (step, why, restored, extra = {}) => new BeadsFlattenRecoveryFailedError(
        `[beads-flatten-recovery] member '${member}': its beads clone shares no history with the shared remote, and the automatic re-bootstrap failed at '${step}': ${why}. ` +
        (restored
            ? `The clone was left as it was. Fix: ${manualFix(member)}`
            : `The original clone is at '${extra.backup}'. Fix: in that member's workFolder rename '${extra.backup}' back to '${BEADS_DIR}' (move any '${BEADS_DIR}' there aside first), then ${manualFix(member)}`),
        { member, doltOutput, details: { step, restored, ...extra } },
    );

    // A pending backup from an earlier crash goes back first.
    await restoreLeftoverFlattenBackup({ command, member, shell, log, timeoutS, now });

    log(`[beads-flatten-recovery] member '${member}': its beads clone shares no history with the shared remote (the remote was flattened or rewritten); exporting it, then re-bootstrapping from the remote.`);
    for (const entry of FLATTEN_GIT_EXCLUDES) {
        const b = build(() => shell.ensureGitExcluded(entry));
        const r = b.cmd ? await run(b.cmd) : { ok: false, error: b.error };
        if (!r.ok) log(`[beads-flatten-recovery] member '${member}': could not keep '${entry}' out of git (continuing): ${summarize(r.error || r.output)}`);
    }

    // 1. Export first, before anything destructive.
    const localExportInBeads = `${BEADS_DIR}/${FLATTEN_LOCAL_EXPORT}`;
    const readExport = async (relPath, exportOutput) => {
        const read = await run(shell.readFile(relPath));
        if (!read.ok) return { error: `could not read '${relPath}' (${summarize(read.error || read.output)})` };
        let records;
        try {
            records = parseBeadsExport(read.output);
        } catch (err) {
            return { error: `'${relPath}' could not be read back intact (${err.message})` };
        }
        const count = parseExportCount(exportOutput);
        if (count !== null && count !== records.length) {
            return { error: `'${relPath}' read back ${records.length} record(s) but bd exported ${count}` };
        }
        return { records };
    };
    const exp = await run(FLATTEN_RECOVERY_COMMANDS.exportTo(localExportInBeads));
    if (!exp.ok) throw failed('export', `'${FLATTEN_RECOVERY_COMMANDS.exportTo(localExportInBeads)}' -> ${summarize(exp.error || exp.output)}`, true);
    const local = await readExport(localExportInBeads, exp.output);
    if (local.error) throw failed('export', local.error, true);

    // 2. Move the clone aside (never delete it).
    const stamp = flattenStamp(now());
    const pending = `${FLATTEN_PENDING_PREFIX}${stamp}`;
    const backup = `${FLATTEN_BACKUP_PREFIX}${stamp}`;
    const discard = `${FLATTEN_DISCARD_PREFIX}${stamp}`;
    const aside = await run(shell.renamePath(BEADS_DIR, pending));
    if (!aside.ok) throw failed('rename', `could not rename '${BEADS_DIR}' to '${pending}' (${summarize(aside.error || aside.output)})`, true);

    // Put the original back: the fresh clone (if any) aside, the original
    // renamed back, the fresh one dropped. Returns true when the original is
    // back in place.
    const rollback = async () => {
        const listing = await run(shell.listDirectory('.'));
        const names = listing.ok ? listing.output.split(/\r?\n/).map((l) => l.trim()) : null;
        let movedFresh = false;
        if (!names || names.includes(BEADS_DIR)) {
            const r = await run(shell.renamePath(BEADS_DIR, discard));
            movedFresh = r.ok;
            if (!r.ok && names) {
                log(`[beads-flatten-recovery] member '${member}': could not move the fresh clone aside (${summarize(r.error || r.output)}).`);
                return false;
            }
        }
        const back = await run(shell.renamePath(pending, BEADS_DIR));
        if (!back.ok) {
            log(`[beads-flatten-recovery] member '${member}': could not rename '${pending}' back to '${BEADS_DIR}' (${summarize(back.error || back.output)}).`);
            return false;
        }
        if (movedFresh) {
            const rm = await run(shell.removeDirectory(discard));
            if (!rm.ok) log(`[beads-flatten-recovery] member '${member}': could not delete the discarded fresh clone '${discard}' (delete it by hand): ${summarize(rm.error || rm.output)}`);
        }
        return true;
    };
    const abort = async (step, why) => {
        const restored = await rollback();
        return failed(step, why, restored, { backup: pending });
    };

    // 3. Seed the new .beads with the old config (it carries the sync remote).
    const seed = build(() => shell.ensureFile(`${BEADS_DIR}/${FLATTEN_CARRIED_CONFIG[0]}`));
    const seeded = seed.cmd ? await run(seed.cmd) : { ok: false, error: seed.error };
    if (!seeded.ok) throw await abort('seed', `could not create a new '${BEADS_DIR}' (${summarize(seeded.error || seeded.output)})`);
    for (const f of FLATTEN_CARRIED_CONFIG) {
        const c = await run(shell.copyFileIfPresent(`${pending}/${f}`, `${BEADS_DIR}/${f}`));
        if (!c.ok) throw await abort('seed', `could not copy '${pending}/${f}' into the new '${BEADS_DIR}' (${summarize(c.error || c.output)})`);
    }

    // 4. Bootstrap from the remote -- only if bd would clone it (any other
    //    bootstrap would create yet another unrelated history).
    const plan = await run(FLATTEN_RECOVERY_COMMANDS.plan);
    const planObj = plan.ok ? parseFirstJson(plan.output) : null;
    if (!planObj || planObj.action !== 'sync') {
        const why = !plan.ok ? summarize(plan.error || plan.output) : `planned action '${(planObj && planObj.action) || '(none)'}', not a clone from the sync remote`;
        throw await abort('plan', `'${FLATTEN_RECOVERY_COMMANDS.plan}' -> ${why}`);
    }
    const boot = await run(FLATTEN_RECOVERY_COMMANDS.bootstrap);
    if (!boot.ok) throw await abort('bootstrap', `'${FLATTEN_RECOVERY_COMMANDS.bootstrap}' -> ${summarize(boot.error || boot.output)}`);

    // 5. Export the fresh clone (into the backup, never into the new .beads).
    const freshExport = `${pending}/${FLATTEN_FRESH_EXPORT}`;
    const fexp = await run(FLATTEN_RECOVERY_COMMANDS.exportTo(freshExport));
    if (!fexp.ok) throw await abort('export-fresh', `'${FLATTEN_RECOVERY_COMMANDS.exportTo(freshExport)}' -> ${summarize(fexp.error || fexp.output)}`);
    const fresh = await readExport(freshExport, fexp.output);
    if (fresh.error) throw await abort('export-fresh', fresh.error);

    // 6. Compare. Local-only work -> refuse, original back in place.
    const localOnly = findLocalOnlyWork(local.records, fresh.records);
    if (localOnly.length) {
        const restored = await rollback();
        const listed = localOnly.map((w) => `${w.id} (${w.reason === 'absent' ? 'not on the remote' : w.reason === 'newer' ? `changed locally at ${w.localUpdatedAt}, remote copy ${w.freshUpdatedAt}` : 'changed locally'})`).join(', ');
        const exportPath = restored ? localExportInBeads : `${pending}/${FLATTEN_LOCAL_EXPORT}`;
        throw new BeadsFlattenRecoveryRefusedError(
            `[beads-flatten-recovery] member '${member}': its beads clone shares no history with the shared remote (the remote was flattened or rewritten), ` +
            `and the clone holds ${localOnly.length} record(s) the remote does not: ${listed}. Recovery REFUSED so no work is lost: ` +
            (restored ? 'the clone was left exactly as it was. ' : `the original clone is at '${pending}' -- rename it back to '${BEADS_DIR}' first. `) +
            `Its export is at '${exportPath}' in that member's workFolder. Fix: ${manualFix(member)} Then re-create the changes to those records from the export on the new clone, push them to the shared beads remote, and relaunch.`,
            { member, doltOutput, details: { localOnly, exportPath, restored, backup: restored ? null : pending } },
        );
    }

    // 7. Re-check, then mark the recovery finished.
    const st = await run(FLATTEN_RECOVERY_COMMANDS.status);
    const stObj = st.ok ? parseFirstJson(st.output) : null;
    const total = stObj && stObj.summary && Number.isFinite(stObj.summary.total_issues) ? stObj.summary.total_issues : null;
    if (!st.ok) throw await abort('status', `'${FLATTEN_RECOVERY_COMMANDS.status}' -> ${summarize(st.error || st.output)}`);
    const done = await run(shell.renamePath(pending, backup));
    const kept = done.ok ? backup : pending;
    if (!done.ok) log(`[beads-flatten-recovery] member '${member}': could not rename '${pending}' to '${backup}' (the next launch will verify the clone again): ${summarize(done.error || done.output)}`);
    log(`${FLATTEN_RECOVERY_WARNING_PREFIX}member '${member}': the shared beads remote was flattened (its history was rewritten), so the beads clone was re-bootstrapped from it ` +
        `(no local-only work found; ${total === null ? 'issue count unavailable' : `${total} issue(s)`}). The previous clone is kept at '${kept}' in that member's workFolder; delete it once the clone is verified.`);
    return { recovered: true, backup: kept, localExport: `${kept}/${FLATTEN_LOCAL_EXPORT}`, freshExport: `${kept}/${FLATTEN_FRESH_EXPORT}`, totalIssues: total, issued };
}

function manualFix(member) {
    return `on member '${member}', in its workFolder, run 'bd export --all -o <file>' and keep that file, rename '${BEADS_DIR}' to a backup name (never delete it), run 'bd bootstrap --yes' and confirm 'bd status' counts.`;
}

/**
 * Resolve the member's SE command primitives from a caller's option, which
 * is either the primitives object itself or an async `(member) => shell`
 * resolver. Returns null when nothing usable was supplied.
 */
export async function resolveRecoveryShell(member, source) {
    if (!source) return null;
    const shell = typeof source === 'function' ? await source(member) : source;
    return shell && typeof shell.renamePath === 'function' ? shell : null;
}
