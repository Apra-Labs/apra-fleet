import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { acquireSprintLock, sprintLockKey, SprintLockHeldError } from '../auto-sprint/sprint-lock.mjs';

// apra-fleet-eft.75.2: unit coverage for the machine-local pidfile mutex
// itself (acquire/release/stale-reclaim/live-refuse), isolated from the
// engine-level wiring in runner.js's main() (covered separately). Every
// test gets its own throwaway lockDir under the OS tmpdir so tests never
// contend with each other or with a real sprint's lock files.

function freshLockDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-sprint-lock-test-'));
}

describe('sprintLockKey', () => {
    test('is stable regardless of members[] input order', () => {
        const a = sprintLockKey('auto-sprint/x', ['alice', 'bob']);
        const b = sprintLockKey('auto-sprint/x', ['bob', 'alice']);
        assert.equal(a, b);
    });

    test('deduplicates repeated member entries', () => {
        const a = sprintLockKey('auto-sprint/x', ['alice', 'alice', 'bob']);
        const b = sprintLockKey('auto-sprint/x', ['alice', 'bob']);
        assert.equal(a, b);
    });

    test('differs for a different branch or a different member set', () => {
        const base = sprintLockKey('auto-sprint/x', ['alice']);
        assert.notEqual(base, sprintLockKey('auto-sprint/y', ['alice']));
        assert.notEqual(base, sprintLockKey('auto-sprint/x', ['bob']));
    });

    test('sanitizes filesystem-unsafe characters out of the key', () => {
        const key = sprintLockKey('auto-sprint/weird branch:name', ['a/b']);
        assert.doesNotMatch(key, /[/\\: ]/);
    });
});

describe('acquireSprintLock', () => {
    test('acquires a fresh lock and writes this process pid into the pidfile', () => {
        const lockDir = freshLockDir();
        const lock = acquireSprintLock({ branch: 'auto-sprint/fresh', members: ['local'], lockDir });
        assert.ok(fs.existsSync(lock.path));
        assert.equal(fs.readFileSync(lock.path, 'utf8').trim(), String(process.pid));
        lock.release();
        assert.ok(!fs.existsSync(lock.path));
    });

    test('a second acquire for the SAME (branch, members) while the first is still held throws SprintLockHeldError', () => {
        const lockDir = freshLockDir();
        const lock = acquireSprintLock({ branch: 'auto-sprint/dup', members: ['local'], lockDir });
        try {
            assert.throws(
                () => acquireSprintLock({ branch: 'auto-sprint/dup', members: ['local'], lockDir }),
                (err) => err instanceof SprintLockHeldError
                    && err.code === 'SPRINT_LOCK_HELD'
                    && err.existingPid === process.pid,
            );
        } finally {
            lock.release();
        }
    });

    test('member order/duplication does not evade the lock -- same effective sprint identity still conflicts', () => {
        const lockDir = freshLockDir();
        const lock = acquireSprintLock({ branch: 'auto-sprint/dup2', members: ['alice', 'bob'], lockDir });
        try {
            assert.throws(
                () => acquireSprintLock({ branch: 'auto-sprint/dup2', members: ['bob', 'alice'], lockDir }),
                (err) => err instanceof SprintLockHeldError,
            );
        } finally {
            lock.release();
        }
    });

    test('a DIFFERENT branch or member set acquires independently -- no false cross-sprint block', () => {
        const lockDir = freshLockDir();
        const lockA = acquireSprintLock({ branch: 'auto-sprint/indep-a', members: ['local'], lockDir });
        const lockB = acquireSprintLock({ branch: 'auto-sprint/indep-b', members: ['local'], lockDir });
        assert.notEqual(lockA.path, lockB.path);
        lockA.release();
        lockB.release();
    });

    test('release() is idempotent -- calling it twice never throws', () => {
        const lockDir = freshLockDir();
        const lock = acquireSprintLock({ branch: 'auto-sprint/idempotent-release', members: ['local'], lockDir });
        lock.release();
        assert.doesNotThrow(() => lock.release());
    });

    test('a stale pidfile (dead pid) is reclaimed, not a false block', () => {
        const lockDir = freshLockDir();
        // A pid that is certainly dead: spawn a trivial child, let it exit,
        // then reuse its pid in a hand-written pidfile (its OS pid is freed
        // once the process has exited and reaped).
        const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
        const deadPid = child.pid;
        assert.ok(Number.isInteger(deadPid) && deadPid > 0, 'expected spawnSync to report a pid');

        fs.mkdirSync(lockDir, { recursive: true });
        const key = sprintLockKey('auto-sprint/stale', ['local']);
        const lockPath = path.join(lockDir, `${key}.lock`);
        fs.writeFileSync(lockPath, String(deadPid));

        // Must NOT throw -- the dead pid is reclaimed and this call proceeds
        // to acquire the lock cleanly under the CURRENT process's pid.
        const lock = acquireSprintLock({ branch: 'auto-sprint/stale', members: ['local'], lockDir });
        assert.equal(fs.readFileSync(lock.path, 'utf8').trim(), String(process.pid));
        lock.release();
    });

    test('an unreadable/corrupt pidfile is treated as stale and reclaimed, not a false block', () => {
        const lockDir = freshLockDir();
        fs.mkdirSync(lockDir, { recursive: true });
        const key = sprintLockKey('auto-sprint/corrupt', ['local']);
        const lockPath = path.join(lockDir, `${key}.lock`);
        fs.writeFileSync(lockPath, 'not-a-pid');

        const lock = acquireSprintLock({ branch: 'auto-sprint/corrupt', members: ['local'], lockDir });
        assert.equal(fs.readFileSync(lock.path, 'utf8').trim(), String(process.pid));
        lock.release();
    });

    test('after release(), the SAME (branch, members) can be re-acquired immediately', () => {
        const lockDir = freshLockDir();
        const first = acquireSprintLock({ branch: 'auto-sprint/reacquire', members: ['local'], lockDir });
        first.release();
        const second = acquireSprintLock({ branch: 'auto-sprint/reacquire', members: ['local'], lockDir });
        assert.doesNotThrow(() => second.release());
    });

    test('SprintLockHeldError carries branch/members/existingPid on .details for a caller to log/inspect', () => {
        const lockDir = freshLockDir();
        const lock = acquireSprintLock({ branch: 'auto-sprint/details', members: ['local', 'other'], lockDir });
        try {
            let caught = null;
            try {
                acquireSprintLock({ branch: 'auto-sprint/details', members: ['local', 'other'], lockDir });
            } catch (err) {
                caught = err;
            }
            assert.ok(caught instanceof SprintLockHeldError);
            assert.equal(caught.branch, 'auto-sprint/details');
            assert.deepEqual(caught.members, ['local', 'other']);
            assert.equal(caught.existingPid, process.pid);
            assert.equal(caught.details.branch, 'auto-sprint/details');
        } finally {
            lock.release();
        }
    });
});
