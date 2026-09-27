// apra-fleet-v6t7.16 (review rework): unit coverage for
// scripts/stale-temp-home-sweep.mjs, added because the review round found
// the sweep had NO test coverage at all -- neither for the age gate nor for
// the liveness gate, nor a regression test proving a live dir survives a
// short-bound sweep. This exercises the pure functions directly (with
// injectable fs/pid seams) rather than shelling out to the real tmpdir, so
// it is fast and touches nothing on disk beyond an isolated fixture dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    STALE_TEMP_HOME_PREFIX,
    OWNER_PID_MARKER,
    isPidAlive,
    hasLiveOwner,
    sweepStaleTempHomes,
} from '../scripts/stale-temp-home-sweep.mjs';

test('isPidAlive: true for this process\'s own pid', () => {
    assert.equal(isPidAlive(process.pid), true);
});

test('isPidAlive: false for a pid that does not exist', () => {
    // A pid this large is exceedingly unlikely to be in use on any platform;
    // combined with a non-EPERM ESRCH result this proves the "dead" branch.
    assert.equal(isPidAlive(999999999), false);
});

test('isPidAlive: false for non-positive/non-integer input', () => {
    assert.equal(isPidAlive(0), false);
    assert.equal(isPidAlive(-1), false);
    assert.equal(isPidAlive(1.5), false);
    assert.equal(isPidAlive(NaN), false);
});

test('hasLiveOwner: true when the marker file holds a live pid', () => {
    const readFileSync = () => String(process.pid);
    assert.equal(hasLiveOwner('/irrelevant/path', { readFileSync }), true);
});

test('hasLiveOwner: false when the marker file holds a dead pid', () => {
    const readFileSync = () => '999999999';
    assert.equal(hasLiveOwner('/irrelevant/path', { readFileSync }), false);
});

test('hasLiveOwner: false (falls back to age gate) when the marker file is missing', () => {
    const readFileSync = () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    assert.equal(hasLiveOwner('/irrelevant/path', { readFileSync }), false);
});

/** Minimal in-memory fake of the fs surface sweepStaleTempHomes() needs. */
function makeFakeFs(dirs) {
    // dirs: Map<name, { mtimeMs: number, ownerPid?: number }>
    const removed = [];
    const readdirSync = () =>
        [...dirs.keys()].map((name) => ({
            name,
            isDirectory: () => true,
        }));
    const statSync = (fullPath) => {
        const name = path.basename(fullPath);
        const entry = dirs.get(name);
        if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { mtimeMs: entry.mtimeMs };
    };
    const readFileSync = (fullPath) => {
        const name = path.basename(path.dirname(fullPath));
        const entry = dirs.get(name);
        if (!entry || entry.ownerPid === undefined) {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return String(entry.ownerPid);
    };
    const rmSync = (fullPath) => {
        removed.push(path.basename(fullPath));
    };
    return { readdirSync, statSync, readFileSync, rmSync, removed };
}

test('sweepStaleTempHomes: deletes a dir past the age gate with no live-owner marker', () => {
    const dirs = new Map([[`${STALE_TEMP_HOME_PREFIX}orphan`, { mtimeMs: 0 }]]);
    const fake = makeFakeFs(dirs);
    sweepStaleTempHomes(1000, { tmpDir: '/tmp', now: 5000, ...fake });
    assert.deepEqual(fake.removed, [`${STALE_TEMP_HOME_PREFIX}orphan`]);
});

test('sweepStaleTempHomes: never deletes a dir with a live-owner marker, even if very old', () => {
    const dirs = new Map([
        [`${STALE_TEMP_HOME_PREFIX}live`, { mtimeMs: 0, ownerPid: process.pid }],
    ]);
    const fake = makeFakeFs(dirs);
    // now is far beyond the age gate -- age alone would delete this dir.
    sweepStaleTempHomes(1000, { tmpDir: '/tmp', now: 10_000_000, ...fake });
    assert.deepEqual(fake.removed, []);
});

test('sweepStaleTempHomes: reproduces and fixes the review-reported bug -- a short sweeping timeoutMs must not delete a concurrent live-owner dir', () => {
    // This is the exact scenario from the review round: a short-bound
    // sweeping run (e.g. APRA_TEST_TIMEOUT_MS=1500 from
    // tests/run-all-tests-timeout.test.ts) must not delete another,
    // still-running invocation's temp home just because that other run's
    // dir is older than THIS sweep's own bound.
    const dirs = new Map([
        [`${STALE_TEMP_HOME_PREFIX}concurrent`, { mtimeMs: 0, ownerPid: process.pid }],
    ]);
    const fake = makeFakeFs(dirs);
    // 10s elapsed, well past a 1.5s sweeping timeout -- age-only logic would
    // have deleted this (the bug the review found).
    sweepStaleTempHomes(1500, { tmpDir: '/tmp', now: 10_000, ...fake });
    assert.deepEqual(fake.removed, [], 'a live-owner dir must survive a short-bound sweep');
});

test('sweepStaleTempHomes: keeps a dir with a dead-owner marker that has not yet aged past the gate', () => {
    const dirs = new Map([
        [`${STALE_TEMP_HOME_PREFIX}recently-killed`, { mtimeMs: 9000, ownerPid: 999999999 }],
    ]);
    const fake = makeFakeFs(dirs);
    sweepStaleTempHomes(5000, { tmpDir: '/tmp', now: 10_000, ...fake });
    assert.deepEqual(fake.removed, [], 'a dead-owner dir within the age gate is still kept conservatively');
});

test('sweepStaleTempHomes: deletes a dead-owner dir once past the age gate', () => {
    const dirs = new Map([
        [`${STALE_TEMP_HOME_PREFIX}dead-and-old`, { mtimeMs: 0, ownerPid: 999999999 }],
    ]);
    const fake = makeFakeFs(dirs);
    sweepStaleTempHomes(1000, { tmpDir: '/tmp', now: 5000, ...fake });
    assert.deepEqual(fake.removed, [`${STALE_TEMP_HOME_PREFIX}dead-and-old`]);
});

test('sweepStaleTempHomes: ignores directories that do not match the temp-home prefix', () => {
    const dirs = new Map([['some-other-dir', { mtimeMs: 0 }]]);
    const fake = makeFakeFs(dirs);
    sweepStaleTempHomes(0, { tmpDir: '/tmp', now: 10_000, ...fake });
    assert.deepEqual(fake.removed, []);
});

test('sweepStaleTempHomes: integration -- a real temp dir with a live .owner-pid marker survives a real sweep call', () => {
    // Exercises the real fs (not the fakes above) end to end, against an
    // isolated fixture tmpdir rather than the real os.tmpdir(), so this
    // never touches a sibling concurrent run's real temp home.
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-fixture-'));
    try {
        const liveDir = path.join(fixtureRoot, `${STALE_TEMP_HOME_PREFIX}live-real`);
        fs.mkdirSync(liveDir);
        fs.writeFileSync(path.join(liveDir, OWNER_PID_MARKER), String(process.pid), 'utf-8');
        // Backdate mtime well past any plausible timeoutMs.
        const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
        fs.utimesSync(liveDir, old, old);

        sweepStaleTempHomes(1000, { tmpDir: fixtureRoot });

        assert.ok(fs.existsSync(liveDir), 'live-owner dir must still exist after the sweep');
    } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5 });
    }
});
