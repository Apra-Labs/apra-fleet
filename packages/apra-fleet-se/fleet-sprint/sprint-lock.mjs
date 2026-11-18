// apra-fleet-eft.75.2 -- a machine-local pidfile mutex keyed on
// (branch, members), guarding against a duplicate concurrent `fleet-sprint`
// engine launch for the SAME sprint.
//
// Root incident (apra-fleet-eft.75): a duplicate concurrent runner.js engine
// dispatched against the same shared git branch/beads DB while the first was
// still alive (both alive 50+ minutes, a duplicate smoke-test sprint
// launched by the orphaned first session was itself duplicated by the
// second). The ONLY thing that had stopped a duplicate concurrent runner
// before this was an ACCIDENTAL viewer-port-8080 collision -- itself
// trivially avoided by passing a different --viewer-port, so it was never a
// real guard. This module is the explicit, always-on mutex that replaces
// that accident with a deliberate, named lock.
//
// One pidfile per (branch, sorted-members) combination lives under
// `lockDir` (default: a fixed subdirectory of the OS tmpdir; override via
// APRA_FLEET_SPRINT_LOCK_DIR for test isolation / a non-default host
// layout). Its content is just the acquiring process's pid as plain text.
// A conflicting acquire attempt:
//   - if the recorded pid is alive AND its command line is a fleet-sprint
//     engine for this branch: refuses with the distinct, named
//     SprintLockHeldError (never falls through to a generic error a caller
//     could accidentally swallow/retry). A live pid whose command line is
//     something else is a RECYCLED pid: the lock is reclaimed with a log
//     line. An unreadable command line fails closed (refuses, naming the
//     lock path). The first line of the lock file is always a bare pid
//     (src/cli/fleet-se-guard.ts parses it with parseInt).
//   - if the recorded pid is dead (crashed process that never released
//     cleanly), or the pidfile is unreadable/corrupt: reclaims the stale
//     pidfile and proceeds, exactly once per acquire() call, without a
//     false block.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { SprintLockHeldError } from './errors.mjs';

export { SprintLockHeldError };

function defaultLockDir() {
    return process.env.APRA_FLEET_SPRINT_LOCK_DIR
        || path.join(os.tmpdir(), 'apra-fleet-sprint-locks');
}

/**
 * Filename-safe key for a (branch, members) pair -- deterministic
 * regardless of `members` input ORDER or duplicate entries, so the SAME
 * sprint (same branch, same member set) always maps to the SAME lock file
 * no matter which order/repetition --members were listed in on either
 * launch.
 * @param {string} branch
 * @param {string[]} members
 * @returns {string}
 */
export function sprintLockKey(branch, members) {
    const memberPart = Array.from(new Set((members || []).map(String))).sort().join('+');
    const raw = `${branch}::${memberPart}`;
    return raw.replace(/[^a-zA-Z0-9._+-]/g, '_');
}

/**
 * True when `pid` is a currently-running process on this machine. Mirrors
 * the fleet server's own isPidAlive (src/utils/pid-helpers.ts) but is
 * reimplemented locally -- this package never imports server TS source
 * directly. EPERM (process exists, owned by a different user) is treated as
 * alive: we could signal it but that does not mean it is dead.
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err && err.code === 'EPERM';
    }
}

/**
 * The command line of a live pid on THIS machine, read synchronously, or null
 * when it cannot be read. Resolved per process.platform locally (this is the
 * local engine process, never a member command).
 * @param {number} pid
 * @returns {string | null}
 */
export function readProcessCommandLine(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    const opts = { encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 10_000 };
    try {
        const out = process.platform === 'win32'
            ? execFileSync(
                path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
                ['-NoProfile', '-NonInteractive', '-Command',
                    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
                opts)
            : execFileSync('ps', ['-p', String(pid), '-o', 'command='], opts);
        const trimmed = String(out).trim();
        return trimmed === '' ? null : trimmed;
    } catch {
        return null;
    }
}

/**
 * True when `cmd` is a fleet-sprint engine command line (the supervisor's
 * `node .../cli.mjs`, runner.js, or `apra-fleet workflow fleet-sprint`) that
 * is not demonstrably for a DIFFERENT branch. A command line that names no
 * `--branch` (e.g. the branch comes from an args file) cannot be told apart
 * from this branch's engine, so it counts as the same sprint (fail closed).
 * @param {string} cmd
 * @param {string} branch
 */
export function isEngineForBranch(cmd, branch) {
    if (!/apra-fleet|fleet-sprint|fleet-se|runner\.js|cli\.mjs|serve\.mjs/i.test(cmd)) return false;
    const m = /--branch(?:=|\s+)("[^"]*"|'[^']*'|\S+)/.exec(cmd);
    if (!m) return true;
    return m[1].replace(/^["']|["']$/g, '') === branch;
}

/**
 * Acquire the sprint lock for (branch, members). Synchronous (pidfile
 * open/write/read are all cheap local-disk ops and every existing call site
 * in this package -- sprint launch, once, before any dispatch -- has no need
 * to await anything else concurrently).
 *
 * @param {{ branch: string, members: string[], lockDir?: string, pid?: number, readCommandLine?: (pid: number) => string | null, log?: (line: string) => void }} opts
 * @returns {{ path: string, release: () => void }}
 * @throws {SprintLockHeldError} when a live process already holds the lock
 *   for this exact (branch, members) key, or a concurrent process wins the
 *   reclaim race.
 */
export function acquireSprintLock({ branch, members, lockDir = defaultLockDir(), pid = process.pid, readCommandLine = readProcessCommandLine, log = (l) => console.error(l) }) {
    fs.mkdirSync(lockDir, { recursive: true });
    const key = sprintLockKey(branch, members);
    const lockPath = path.join(lockDir, `${key}.lock`);

    function tryAcquire(allowReclaim) {
        try {
            const fd = fs.openSync(lockPath, 'wx');
            fs.writeSync(fd, String(pid));
            fs.closeSync(fd);
            return {
                path: lockPath,
                release: () => { try { fs.unlinkSync(lockPath); } catch { /* already gone -- fine */ } },
            };
        } catch (err) {
            if (!err || err.code !== 'EEXIST') throw err;

            let existingPid = null;
            try {
                existingPid = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
            } catch {
                // File vanished (or became unreadable) between our openSync
                // failing and this read -- treat as reclaimable below.
            }

            if (Number.isInteger(existingPid) && isPidAlive(existingPid)) {
                // A live pid is not proof of a live engine: a crashed engine's
                // pid can be recycled by an unrelated process (common on
                // Windows). Check identity; refuse when it is the engine for
                // this branch, or when identity cannot be verified.
                let cmd = null;
                try { cmd = readCommandLine(existingPid); } catch { cmd = null; }
                if (typeof cmd !== 'string' || cmd.trim() === '') {
                    throw new SprintLockHeldError(
                        `[Sprint Lock] Sprint branch "${branch}" (members: ${(members || []).join(', ')}) lock ${lockPath} ` +
                        `names live pid ${existingPid}, but its identity could not be verified (command line unreadable). ` +
                        `Refusing to reclaim it -- if pid ${existingPid} is not a fleet-sprint engine, remove ${lockPath} and relaunch.`,
                        { branch, members, existingPid },
                    );
                }
                if (isEngineForBranch(cmd, branch)) {
                    throw new SprintLockHeldError(
                        `[Sprint Lock] Sprint branch "${branch}" (members: ${(members || []).join(', ')}) is already ` +
                        `running under pid ${existingPid}. Refusing to start a second concurrent engine against the ` +
                        `same sprint -- wait for it to finish, or stop it first.`,
                        { branch, members, existingPid },
                    );
                }
                log(`[Sprint Lock] reclaiming stale lock ${lockPath}: pid ${existingPid} is alive but is not a fleet-sprint engine for branch "${branch}" (recycled pid).`);
            }

            if (!allowReclaim) {
                // We already reclaimed once in this call and STILL hit
                // EEXIST -- a concurrent acquire won the race between our
                // unlink and this retry.
                throw new SprintLockHeldError(
                    `[Sprint Lock] Sprint branch "${branch}" (members: ${(members || []).join(', ')}) lock could ` +
                    `not be acquired -- a concurrent process claimed it during stale-pidfile reclaim.`,
                    { branch, members },
                );
            }

            // Stale pidfile (dead pid, or unreadable/corrupt content) --
            // reclaim it and retry exactly once, never a false block.
            try { fs.unlinkSync(lockPath); } catch { /* already gone -- fine */ }
            return tryAcquire(false);
        }
    }

    return tryAcquire(true);
}
