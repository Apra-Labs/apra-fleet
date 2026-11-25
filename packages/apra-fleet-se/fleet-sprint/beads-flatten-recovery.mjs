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
//   3. Compare (classifyLocalWork, see "Detecting local-only work" below):
//      every kind of unpushed local work refuses the recovery -- a bead or
//      field change, a dependency, label or comment add, a delete.
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
// Detecting local-only work -- the chosen approach is a FULL RECORD DIFF of
// the clone's export against the fresh export (plus a history probe for
// deletes), not "count the dolt commits ahead of the remote-tracking ref":
//   - On the pinned bd the failing pull's fetch has ALREADY moved the
//     remote-tracking ref (origin/main) to the rewritten history before
//     recovery runs, and an earlier failed pull (an operator's, or a refused
//     launch) moves it the same way, so the last-known remote is gone; bd has
//     no reflog read in embedded mode.
//   - `bd diff <ref> HEAD` compares only the issues table: a label-only
//     change reports "No changes".
//   - `bd export --all` carries each issue's labels, dependencies and
//     comments inline, and a rebuilt remote's export of an untouched record
//     is identical to the clone's (only the derived *_count fields can differ).
// So, per record (findLocalOnlyWork / classifyLocalWork, pure):
//   - absent: a local issue or memory the fresh export lacks (see pruned).
//   - changed: a local updated_at newer than the fresh copy's (a memory: a
//     different value).
//   - dependency / label / comment: one the local record has and the fresh
//     copy does not -- on the pinned bd `bd dep add`, `bd label add` and
//     `bd comments add` do not bump updated_at, so they are compared
//     directly (a comment by id and text). A removal cannot be told apart
//     from another clone's add and is not counted.
//   - deleted: an issue the fresh export holds and the clone does not is
//     either new on the remote or deleted locally. Each such id is checked
//     against the old clone's own history (`bd --db <moved-aside clone>
//     --readonly --json history <id> --limit 1`, one member command per id):
//     any history means the clone knew the bead, so its absence is a local
//     delete; no history means it is new on the remote. A probe that fails
//     or answers unreadably aborts the recovery (clone put back); an id that
//     is not safe to put in a command string counts as deleted, unverified.
//   - pruned (NOT local work): the documented maintenance runs `bd prune`
//     before the rewrite, so a clone that never received the prune holds
//     closed beads the remote no longer has. A local issue the fresh export
//     lacks is treated as pruned only when it is closed, not pinned, and its
//     LAST CHANGE (the newest of updated_at, closed_at and its comments' and
//     dependencies' created_at) is strictly older than the clone's sync
//     boundary: the newest change time among records the clone and the
//     fresh export hold identically (syncBoundary). Those records are synced
//     state, so the clone pulled or pushed no earlier than that instant, and
//     a closed bead changed after its last pull (unpushed) is newer than the
//     boundary and still counts as local work. No identical record (or an
//     unreadable timestamp) means no boundary, and every absent record is
//     local work (the safe direction). Residual: a change older than the
//     boundary that was never pushed (a pull without a push), or clock skew
//     between machines, can make a pruned-looking bead's change be dropped;
//     the pre-recovery export is kept in the backup directory in every case.
//
// ASCII only.
// =============================================================================

import { BeadsFlattenRecoveryFailedError, BeadsFlattenRecoveryRefusedError } from './errors.mjs';

export const BEADS_DIR = '.beads';
export const FLATTEN_PENDING_PREFIX = '.beads.flatten-pending-';
export const FLATTEN_BACKUP_PREFIX = '.beads.flatten-backup-';
export const FLATTEN_DISCARD_PREFIX = '.beads.flatten-discard-';
// The lock file bd's embedded mode creates next to a `--db <dir>` directory.
export const BD_DB_LOCK_SUFFIX = '.gate.lock';
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
    // Read-only history of one bead in the moved-aside original clone.
    historyIn: (dbDir, id) => `bd --db ${dbDir} --readonly --json history ${id} --limit 1`,
});

// Ids and directory names put into a member-bound command string unquoted.
const SAFE_ARG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_DIR = /^\.?[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The kinds of local-only work a refusal names. */
export const LOCAL_WORK_KINDS = Object.freeze({
    absent: 'absent',
    changed: 'changed',
    dependency: 'dependency',
    label: 'label',
    comment: 'comment',
    deleted: 'deleted',
});

const LABEL = 'beads-flatten-recovery';

// What flattenStamp produces (digits, T and Z only).
const STAMP_RE = /^[0-9TZ]+$/;

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

const asArray = (v) => (Array.isArray(v) ? v : []);
const labelKey = (l) => String(l);
const depKey = (d) => (d && typeof d === 'object' ? `${d.depends_on_id ?? ''} (${d.type ?? ''})` : String(d));
const commentKey = (c) => (c && typeof c === 'object' ? JSON.stringify([c.id ?? null, c.author ?? null, c.created_at ?? null, c.text ?? null]) : String(c));

/** A record with its derived *_count fields dropped and its sub-lists sorted: equal on both sides means synced. */
function canonicalRecord(record) {
    const out = {};
    for (const k of Object.keys(record).sort()) {
        if (k.endsWith('_count')) continue;
        const v = record[k];
        if (k === 'labels') out[k] = asArray(v).map(labelKey).sort();
        else if (k === 'dependencies') out[k] = asArray(v).map((d) => JSON.stringify(d)).sort();
        else if (k === 'comments') out[k] = asArray(v).map(commentKey).sort();
        else out[k] = v;
    }
    return JSON.stringify(out);
}

/**
 * The instant of a record's last change: the newest of updated_at,
 * closed_at and its comments' and dependencies' created_at. NaN when its
 * updated_at is unreadable (an unknown change time is never "old").
 */
export function lastChangeMs(record) {
    if (!record || typeof record !== 'object') return NaN;
    const updated = Date.parse(String(record.updated_at || ''));
    if (Number.isNaN(updated)) return NaN;
    let max = updated;
    const consider = (ts) => {
        if (ts === undefined || ts === null || ts === '') return true;
        const t = Date.parse(String(ts));
        if (Number.isNaN(t)) return false;
        if (t > max) max = t;
        return true;
    };
    if (!consider(record.closed_at)) return NaN;
    for (const c of asArray(record.comments)) if (!consider(c && c.created_at)) return NaN;
    for (const d of asArray(record.dependencies)) if (!consider(d && d.created_at)) return NaN;
    return max;
}

function indexByKey(records) {
    const map = new Map();
    for (const r of records || []) {
        const k = exportRecordKey(r);
        if (k) map.set(k, r);
    }
    return map;
}

/**
 * The clone's sync boundary: the newest last-change instant among the issue
 * records the clone and the fresh export hold identically (derived counts
 * ignored). -Infinity when there is none. Pure.
 * @param {object[]} localRecords
 * @param {object[]} freshRecords
 * @returns {number}
 */
export function syncBoundary(localRecords, freshRecords) {
    const fresh = indexByKey(freshRecords);
    let boundary = -Infinity;
    for (const r of localRecords || []) {
        if (!r || r._type === 'memory') continue;
        const k = exportRecordKey(r);
        const f = k ? fresh.get(k) : null;
        if (!f || canonicalRecord(r) !== canonicalRecord(f)) continue;
        const t = lastChangeMs(r);
        if (!Number.isNaN(t) && t > boundary) boundary = t;
    }
    return boundary;
}

/**
 * Issue ids the fresh export holds and the clone does not: each is either
 * new on the remote or deleted locally (the caller tells them apart with the
 * clone's own history). Pure.
 * @returns {string[]}
 */
export function findFreshOnlyIds(localRecords, freshRecords) {
    const local = indexByKey(localRecords);
    const out = [];
    for (const r of freshRecords || []) {
        if (!r || r._type === 'memory') continue;
        const k = exportRecordKey(r);
        if (k && !local.has(k)) out.push(k);
    }
    return out;
}

/** Whether `id` can be placed in a history probe command unquoted. */
export function isProbeSafeId(id) {
    return typeof id === 'string' && SAFE_ARG.test(id);
}

/**
 * Read a `bd --json history <id>` answer: true when it lists any entry (the
 * clone knew the bead), false for `null` / `[]` (it never did), null when
 * the output is unreadable.
 * @param {string} output
 * @returns {boolean|null}
 */
export function parseHistoryProbe(output) {
    const t = String(output || '').trim();
    if (!t) return null;
    if (/^null$/m.test(t)) return false;
    const start = t.indexOf('[');
    if (start < 0) return null;
    try {
        const v = JSON.parse(t.slice(start));
        return Array.isArray(v) ? v.length > 0 : null;
    } catch {
        return null;
    }
}

/**
 * Classify the clone's records against the fresh export (the rewritten
 * remote); see the module header for every rule. Pure.
 * @param {object[]} localRecords
 * @param {object[]} freshRecords
 * @param {{ locallyDeleted?: Array<string|{id: string, unverified?: boolean}> }} [opts]
 *   fresh-only issue ids the clone's own history knew (local deletes).
 * @returns {{ work: Array<{ id: string, kind: string, reason: string, localUpdatedAt?: string, freshUpdatedAt?: string, items?: string[], unverified?: boolean }>, pruned: string[], boundary: number }}
 */
export function classifyLocalWork(localRecords, freshRecords, { locallyDeleted = [] } = {}) {
    const fresh = indexByKey(freshRecords);
    const boundary = syncBoundary(localRecords, freshRecords);
    const work = [];
    const pruned = [];
    for (const r of localRecords || []) {
        const k = exportRecordKey(r);
        if (!k) continue;
        const f = fresh.get(k);
        if (!f) {
            if (r._type !== 'memory' && r.status === 'closed' && r.pinned !== true) {
                const t = lastChangeMs(r);
                if (!Number.isNaN(t) && t < boundary) {
                    pruned.push(k);
                    continue;
                }
            }
            work.push({ id: k, kind: LOCAL_WORK_KINDS.absent, reason: 'absent', localUpdatedAt: r.updated_at });
            continue;
        }
        if (r._type === 'memory') {
            if (String(r.value ?? '') !== String(f.value ?? '')) work.push({ id: k, kind: LOCAL_WORK_KINDS.changed, reason: 'changed' });
            continue;
        }
        if (isNewer(r.updated_at, f.updated_at)) {
            work.push({ id: k, kind: LOCAL_WORK_KINDS.changed, reason: 'newer', localUpdatedAt: r.updated_at, freshUpdatedAt: f.updated_at });
        }
        for (const [kind, field, keyOf, show] of [
            [LOCAL_WORK_KINDS.dependency, 'dependencies', depKey, depKey],
            [LOCAL_WORK_KINDS.label, 'labels', labelKey, labelKey],
            [LOCAL_WORK_KINDS.comment, 'comments', commentKey, (c) => (c && typeof c === 'object' && c.id ? String(c.id) : 'comment')],
        ]) {
            const remote = new Set(asArray(f[field]).map(keyOf));
            const added = asArray(r[field]).filter((x) => !remote.has(keyOf(x))).map(show);
            if (added.length) work.push({ id: k, kind, reason: kind, items: added });
        }
    }
    for (const d of locallyDeleted || []) {
        const id = typeof d === 'string' ? d : d && d.id;
        if (!id) continue;
        const entry = { id, kind: LOCAL_WORK_KINDS.deleted, reason: 'deleted' };
        if (d && typeof d === 'object' && d.unverified) entry.unverified = true;
        work.push(entry);
    }
    return { work, pruned, boundary };
}

/**
 * The local-only work of a clone (classifyLocalWork's `work`): every record
 * change, dependency/label/comment add and delete the rewritten remote does
 * not hold; closed beads the remote pruned are not counted. Pure.
 * @param {object[]} localRecords
 * @param {object[]} freshRecords
 * @param {{ locallyDeleted?: Array<string|{id: string, unverified?: boolean}> }} [opts]
 */
export function findLocalOnlyWork(localRecords, freshRecords, opts = {}) {
    return classifyLocalWork(localRecords, freshRecords, opts).work;
}

/** One refusal line per finding, naming its kind. */
export function describeLocalWork(w) {
    switch (w.kind) {
    case LOCAL_WORK_KINDS.absent:
        return `${w.id} (not on the remote: created locally, or changed locally after the last sync)`;
    case LOCAL_WORK_KINDS.changed:
        return w.reason === 'newer'
            ? `${w.id} (changed locally at ${w.localUpdatedAt}, remote copy ${w.freshUpdatedAt})`
            : `${w.id} (changed locally)`;
    case LOCAL_WORK_KINDS.dependency:
        return `${w.id} (dependency added locally: ${(w.items || []).join(', ')})`;
    case LOCAL_WORK_KINDS.label:
        return `${w.id} (label added locally: ${(w.items || []).join(', ')})`;
    case LOCAL_WORK_KINDS.comment:
        return `${w.id} (comment added locally: ${(w.items || []).join(', ')})`;
    case LOCAL_WORK_KINDS.deleted:
        return `${w.id} (deleted locally, still on the remote${w.unverified ? '; id could not be checked against the clone history' : ''})`;
    default:
        return `${w.id} (${w.reason || 'local work'})`;
    }
}

/** "1 dependency add, 2 label adds" -- the kinds a refusal found. */
export function summarizeLocalWorkKinds(work) {
    const noun = {
        absent: ['bead not on the remote', 'beads not on the remote'],
        changed: ['local change', 'local changes'],
        dependency: ['dependency add', 'dependency adds'],
        label: ['label add', 'label adds'],
        comment: ['comment add', 'comment adds'],
        deleted: ['local delete', 'local deletes'],
    };
    const counts = new Map();
    for (const w of work || []) counts.set(w.kind, (counts.get(w.kind) || 0) + 1);
    return [...counts].map(([k, n]) => `${n} ${(noun[k] || [k, k])[n === 1 ? 0 : 1]}`).join(', ');
}

/** Pick what a leftover check must put back, from a work-folder listing. */
export function pickLeftoverBackup(names) {
    const list = (names || []).map((n) => String(n).trim()).filter(Boolean);
    const hasBeads = list.includes(BEADS_DIR);
    // Only `<prefix><stamp>` itself: never a sibling such as a bd lock file
    // (`<prefix><stamp>.gate.lock`) that merely shares the prefix.
    const exact = (prefix) => (n) => n.startsWith(prefix) && STAMP_RE.test(n.slice(prefix.length));
    const pending = list.filter(exact(FLATTEN_PENDING_PREFIX)).sort();
    if (pending.length) return { backup: pending[pending.length - 1], pending: true, hasBeads };
    if (hasBeads) return { backup: null, pending: false, hasBeads };
    const finished = list.filter(exact(FLATTEN_BACKUP_PREFIX)).sort();
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
    if (!boot.ok) throw await abort('bootstrap', `'${FLATTEN_RECOVERY_COMMANDS.bootstrap}' -> ${summarize(boot.error || boot.output)}${longPathHint(boot.error || boot.output)}`);

    // 5. Export the fresh clone (into the backup, never into the new .beads).
    const freshExport = `${pending}/${FLATTEN_FRESH_EXPORT}`;
    const fexp = await run(FLATTEN_RECOVERY_COMMANDS.exportTo(freshExport));
    if (!fexp.ok) throw await abort('export-fresh', `'${FLATTEN_RECOVERY_COMMANDS.exportTo(freshExport)}' -> ${summarize(fexp.error || fexp.output)}`);
    const fresh = await readExport(freshExport, fexp.output);
    if (fresh.error) throw await abort('export-fresh', fresh.error);

    // 6. Deletes: a bead the remote holds and the clone does not is either
    //    new on the remote or deleted locally; the moved-aside clone's own
    //    history tells them apart (read-only).
    const freshOnly = findFreshOnlyIds(local.records, fresh.records);
    const locallyDeleted = [];
    if (freshOnly.length) {
        log(`[beads-flatten-recovery] member '${member}': checking ${freshOnly.length} bead(s) the remote holds and the clone does not against the clone's own history (a local delete is unpushed work).`);
    }
    // `bd --db <dir>` leaves a `<dir>.gate.lock` file next to the directory;
    // it is dropped before anything else renames the clone.
    let probed = false;
    const dropProbeLock = async () => {
        if (!probed) return;
        const lock = `${pending}${BD_DB_LOCK_SUFFIX}`;
        const rm = await run(shell.removeDirectory(lock));
        if (!rm.ok) log(`[beads-flatten-recovery] member '${member}': could not delete '${lock}' (delete it by hand): ${summarize(rm.error || rm.output)}`);
    };
    for (const id of freshOnly) {
        if (!isProbeSafeId(id) || !SAFE_DIR.test(pending)) {
            locallyDeleted.push({ id, unverified: true });
            continue;
        }
        const probeCmd = FLATTEN_RECOVERY_COMMANDS.historyIn(pending, id);
        probed = true;
        const probe = await run(probeCmd);
        const known = probe.ok ? parseHistoryProbe(probe.output) : null;
        if (known === null) {
            await dropProbeLock();
            throw await abort('probe-deletes', `'${probeCmd}' -> ${probe.ok ? `unreadable answer (${summarize(probe.output)})` : summarize(probe.error || probe.output)}`);
        }
        if (known) locallyDeleted.push(id);
    }
    await dropProbeLock();

    // 7. Compare. Local-only work -> refuse, original back in place.
    const { work: localOnly, pruned } = classifyLocalWork(local.records, fresh.records, { locallyDeleted });
    if (localOnly.length) {
        const restored = await rollback();
        const listed = localOnly.map(describeLocalWork).join(', ');
        const exportPath = restored ? localExportInBeads : `${pending}/${FLATTEN_LOCAL_EXPORT}`;
        throw new BeadsFlattenRecoveryRefusedError(
            `[beads-flatten-recovery] member '${member}': its beads clone shares no history with the shared remote (the remote was flattened or rewritten), ` +
            `and the clone holds unpushed local work the remote does not (${summarizeLocalWorkKinds(localOnly)}): ${listed}. Recovery REFUSED so no work is lost: ` +
            (restored ? 'the clone was left exactly as it was. ' : `the original clone is at '${pending}' -- rename it back to '${BEADS_DIR}' first. `) +
            `Its export is at '${exportPath}' in that member's workFolder. Fix: ${manualFix(member)} Then re-create the changes to those records from the export on the new clone, push them to the shared beads remote, and relaunch.`,
            { member, doltOutput, details: { localOnly, exportPath, restored, backup: restored ? null : pending } },
        );
    }

    // 8. Re-check, then mark the recovery finished.
    const st = await run(FLATTEN_RECOVERY_COMMANDS.status);
    const stObj = st.ok ? parseFirstJson(st.output) : null;
    const total = stObj && stObj.summary && Number.isFinite(stObj.summary.total_issues) ? stObj.summary.total_issues : null;
    if (!st.ok) throw await abort('status', `'${FLATTEN_RECOVERY_COMMANDS.status}' -> ${summarize(st.error || st.output)}`);
    const done = await run(shell.renamePath(pending, backup));
    const kept = done.ok ? backup : pending;
    if (!done.ok) log(`[beads-flatten-recovery] member '${member}': could not rename '${pending}' to '${backup}' (the next launch will verify the clone again): ${summarize(done.error || done.output)}`);
    log(`${FLATTEN_RECOVERY_WARNING_PREFIX}member '${member}': the shared beads remote was flattened (its history was rewritten), so the beads clone was re-bootstrapped from it ` +
        `(no local-only work found; ${total === null ? 'issue count unavailable' : `${total} issue(s)`}` +
        `${pruned.length ? `; ${pruned.length} closed bead(s) the remote pruned were not counted as local work` : ''}). The previous clone is kept at '${kept}' in that member's workFolder; delete it once the clone is verified.`);
    return { recovered: true, backup: kept, localExport: `${kept}/${FLATTEN_LOCAL_EXPORT}`, freshExport: `${kept}/${FLATTEN_FRESH_EXPORT}`, totalIssues: total, issued };
}

/**
 * A hint for a bd/dolt failure that hit the Windows 260-character path limit
 * (dolt clones its remote into a deep git cache inside .beads, and git there
 * needs core.longpaths). '' when the output does not look like one.
 * @param {string} text
 * @returns {string}
 */
export function longPathHint(text) {
    const s = String(text || '');
    if (!/Filename too long|path too long|cannot lock ref[\s\S]*Unable to create|update_ref failed for ref 'refs\/dolt\//i.test(s)) return '';
    return "; this looks like the Windows 260-character path limit (bd's dolt remote cache sits deep inside .beads): " +
        "on that member run 'git config --global core.longpaths true' (or use a shorter workFolder), then retry";
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
