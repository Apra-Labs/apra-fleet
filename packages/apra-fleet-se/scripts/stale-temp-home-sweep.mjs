// apra-fleet-v6t7.16: sweeps stale run-level test home directories
// (apra-fleet-se-test-run-* under os.tmpdir(), created by
// test/isolated-home-setup.mjs) left behind when a hung test file is
// force-killed (taskkill /F on Windows, SIGKILL on POSIX -- see
// killTree()/runBounded() in scripts/run-tests.mjs) before its own
// process.on('exit') cleanup handler gets a chance to run.
//
// Extracted from scripts/run-tests.mjs into its own module (rather than
// inlined there) so it can be imported and unit-tested directly --
// run-tests.mjs itself is a script with argv-parsing/process.exit side
// effects at module-load time and cannot be `import`-ed safely from a test.
//
// Review rework: the original inline version age-gated a candidate dir
// against the SWEEPING run's own wall-clock bound (APRA_TEST_TIMEOUT_MS),
// not the OWNING run's. A short-bound invocation (e.g.
// tests/run-all-tests-timeout.test.ts spawns a child with
// APRA_TEST_TIMEOUT_MS=1500) would therefore delete ANY apra-fleet-se-test-
// run-* dir older than 1.5s on the machine, including the live home of a
// normal-bound (15-minute) run in another terminal or another concurrent
// sprint track -- reproduced during review. test/isolated-home-setup.mjs now
// stamps a `.owner-pid` marker containing its own process's pid into the
// temp home it creates. The sweep below checks that marker FIRST: a dir
// whose owning pid is still alive is never deleted, no matter its age. Only
// once the marker is missing/unreadable or the pid is confirmed dead does
// the sweep fall back to the age gate (a dir older than the caller-supplied
// timeoutMs with no live owner is an orphan from a force-killed run).
import fs from 'fs';
import os from 'os';
import path from 'path';

export const STALE_TEMP_HOME_PREFIX = 'apra-fleet-se-test-run-';
export const OWNER_PID_MARKER = '.owner-pid';

/** True if a process with this pid is currently running. */
export function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        // Signal 0 sends nothing but still validates the pid exists; throws
        // ESRCH if it does not. EPERM means it exists but we lack permission
        // to signal it -- still alive from our perspective.
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return Boolean(err && err.code === 'EPERM');
    }
}

/** True if `fullPath` carries a live owner-pid marker (never sweep it). */
export function hasLiveOwner(fullPath, { readFileSync = fs.readFileSync } = {}) {
    let raw;
    try {
        raw = readFileSync(path.join(fullPath, OWNER_PID_MARKER), 'utf-8');
    } catch {
        return false; // no marker (e.g. pre-marker leftover, or already partially cleaned) -- fall back to age gate
    }
    return isPidAlive(Number.parseInt(raw, 10));
}

/**
 * Sweeps stale apra-fleet-se-test-run-* dirs from `tmpDir`.
 *
 * @param {number} timeoutMs - age gate applied only when no live-owner marker is found.
 * @param {object} [deps] - injectable seams for testing.
 */
export function sweepStaleTempHomes(timeoutMs, deps = {}) {
    const {
        tmpDir = os.tmpdir(),
        readdirSync = fs.readdirSync,
        statSync = fs.statSync,
        rmSync = fs.rmSync,
        readFileSync = fs.readFileSync,
        now = Date.now(),
    } = deps;

    let entries;
    try {
        entries = readdirSync(tmpDir, { withFileTypes: true });
    } catch {
        return; // best effort -- an unreadable tmpdir is not this script's problem to fix
    }
    for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith(STALE_TEMP_HOME_PREFIX)) continue;
        const fullPath = path.join(tmpDir, entry.name);
        if (hasLiveOwner(fullPath, { readFileSync })) continue; // owning process still running -- never sweep it
        let stat;
        try {
            stat = statSync(fullPath);
        } catch {
            continue; // already gone, or a race with something else cleaning it up
        }
        const ageMs = now - stat.mtimeMs;
        if (ageMs <= timeoutMs) continue; // no live-owner marker, but still within the bound -- be conservative
        try {
            rmSync(fullPath, { recursive: true, force: true, maxRetries: 5 });
        } catch {
            // best effort -- leave it for the next sweep rather than fail this run over it
        }
    }
}
