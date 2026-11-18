import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acquireSprintLock, sprintLockKey, SprintLockHeldError, readProcessCommandLine } from '../fleet-sprint/sprint-lock.mjs';

// apra-fleet-eft.75.2: unit coverage for the machine-local pidfile mutex
// itself (acquire/release/stale-reclaim/live-refuse), isolated from the
// engine-level wiring in runner.js's main() (covered separately). Every
// test gets its own throwaway lockDir under the OS tmpdir so tests never
// contend with each other or with a real sprint's lock files.

// A live holder (this test process) must look like a fleet-sprint engine to the
// identity check; the real reader would report the test runner's command line.
const engineCmd = (branch) => () => `node fleet-sprint/bin/cli.mjs --branch ${branch}`;

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
                () => acquireSprintLock({ branch: 'auto-sprint/dup', members: ['local'], lockDir, readCommandLine: engineCmd('auto-sprint/dup') }),
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
                () => acquireSprintLock({ branch: 'auto-sprint/dup2', members: ['bob', 'alice'], lockDir, readCommandLine: engineCmd('auto-sprint/dup2') }),
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
                acquireSprintLock({ branch: 'auto-sprint/details', members: ['local', 'other'], lockDir, readCommandLine: engineCmd('auto-sprint/details') });
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

describe('acquireSprintLock identity check on a live pid (recycled pid)', () => {
    const dirs = [];
    const mk = () => { const d = freshLockDir(); dirs.push(d); return d; };
    after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
    const lockFile = (lockDir, branch) => path.join(lockDir, `${sprintLockKey(branch, ['local'])}.lock`);

    test('a live pid whose command line is unrelated is reclaimed and a log line names the old pid and reason', () => {
        const lockDir = mk();
        fs.writeFileSync(lockFile(lockDir, 'auto-sprint/recycled'), String(process.pid));
        const logs = [];
        const lock = acquireSprintLock({
            branch: 'auto-sprint/recycled', members: ['local'], lockDir,
            readCommandLine: () => 'C:\\Windows\\System32\\conhost.exe 0xffffffff',
            log: (l) => logs.push(l),
        });
        assert.equal(fs.readFileSync(lock.path, 'utf8').split('\n')[0].trim(), String(process.pid));
        assert.equal(logs.length, 1);
        assert.ok(logs[0].includes(`pid ${process.pid}`) && /not a fleet-sprint engine/.test(logs[0]), logs[0]);
        lock.release();
    });

    test('a live engine for the same branch is refused with SprintLockHeldError', () => {
        const lockDir = mk();
        fs.writeFileSync(lockFile(lockDir, 'auto-sprint/live'), String(process.pid));
        assert.throws(
            () => acquireSprintLock({ branch: 'auto-sprint/live', members: ['local'], lockDir,
                readCommandLine: () => 'node /x/fleet-sprint/bin/cli.mjs --branch auto-sprint/live --members local' }),
            (err) => err instanceof SprintLockHeldError && err.existingPid === process.pid,
        );
    });

    test('an engine command line for a DIFFERENT branch is a recycled pid: reclaimed', () => {
        const lockDir = mk();
        fs.writeFileSync(lockFile(lockDir, 'auto-sprint/mine'), String(process.pid));
        const lock = acquireSprintLock({ branch: 'auto-sprint/mine', members: ['local'], lockDir,
            readCommandLine: () => 'node /x/fleet-sprint/bin/cli.mjs --branch auto-sprint/other', log: () => {} });
        lock.release();
    });

    for (const [label, reader] of [['returns null', () => null], ['throws', () => { throw new Error('boom'); }]]) {
        test(`an unreadable command line (reader ${label}) fails closed, naming the lock path and that identity could not be verified`, () => {
            const lockDir = mk();
            const lp = lockFile(lockDir, 'auto-sprint/unreadable');
            fs.writeFileSync(lp, String(process.pid));
            assert.throws(
                () => acquireSprintLock({ branch: 'auto-sprint/unreadable', members: ['local'], lockDir, readCommandLine: reader }),
                (err) => err instanceof SprintLockHeldError && err.message.includes(lp) && /identity could not be verified/.test(err.message),
            );
            assert.ok(fs.existsSync(lp), 'the lock must be left in place');
        });
    }

    test('the written lock first line parses with parseInt to the pid; a legacy bare-pid lock is still honoured', () => {
        const lockDir = mk();
        const lock = acquireSprintLock({ branch: 'auto-sprint/format', members: ['local'], lockDir });
        assert.equal(parseInt(fs.readFileSync(lock.path, 'utf8'), 10), process.pid);
        lock.release();
        const lp = lockFile(lockDir, 'auto-sprint/legacy');
        fs.writeFileSync(lp, `${process.pid}\n`);
        assert.throws(
            () => acquireSprintLock({ branch: 'auto-sprint/legacy', members: ['local'], lockDir,
                readCommandLine: () => 'node /x/fleet-sprint/bin/cli.mjs --branch auto-sprint/legacy' }),
            (err) => err instanceof SprintLockHeldError && err.existingPid === process.pid,
        );
    });
});

describe('acquireSprintLock engine identity: only a real fleet-sprint engine holds the lock', () => {
    const dirs = [];
    const mk = () => { const d = freshLockDir(); dirs.push(d); return d; };
    after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
    const BR = 'feat/relaunch';
    const lockFile = (lockDir, branch = BR) => path.join(lockDir, `${sprintLockKey(branch, ['local'])}.lock`);
    const attempt = (cmd, branch = BR) => {
        const lockDir = mk();
        const lp = lockFile(lockDir, branch);
        fs.writeFileSync(lp, String(process.pid));
        const logs = [];
        try {
            const lock = acquireSprintLock({ branch, members: ['local'], lockDir, readCommandLine: () => cmd, log: (l) => logs.push(l) });
            lock.release();
            return { reclaimed: true, logs, lp };
        } catch (err) {
            return { reclaimed: false, err, logs, lp };
        }
    };

    // A recycled pid now owned by one of these is NOT the crashed engine.
    const NOT_ENGINE = [
        ['fleet server (windows)', 'C:\\Users\\me\\.apra-fleet\\bin\\apra-fleet.exe serve'],
        ['fleet server (posix)', '/home/me/.apra-fleet/bin/apra-fleet serve'],
        ['supervisor serve.mjs (windows)', '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\.apra-fleet\\workflows\\fleet-sprint\\bin\\serve.mjs --port 8787'],
        ['supervisor serve.mjs (posix)', 'node /home/me/.apra-fleet/workflows/fleet-sprint/bin/serve.mjs'],
        ['supervisor serve.mjs (dev checkout)', 'node /home/me/git/apra-fleet/packages/apra-fleet-se/bin/serve.mjs'],
        ['VS Code on an apra-fleet folder', '"C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe" C:\\git\\apra-fleet'],
        ['git in an apra-fleet checkout', 'git -C /home/me/git/apra-fleet-se fetch origin'],
        ['an unrelated cli.mjs (windows)', 'node C:\\work\\app\\node_modules\\vite\\bin\\cli.mjs build'],
        ['an unrelated cli.mjs (posix)', 'node /work/app/node_modules/.bin/vite/cli.mjs --branch feat/relaunch'],
    ];
    for (const [label, cmd] of NOT_ENGINE) {
        test(`${label}: a recycled pid, the lock is reclaimed`, () => {
            const out = attempt(cmd);
            assert.equal(out.reclaimed, true, out.err && out.err.message);
            assert.equal(out.logs.length, 1);
            assert.match(out.logs[0], /not a fleet-sprint engine/);
        });
    }

    const ENGINE_SAME = [
        ['installed cli.mjs, --branch X', 'node C:\\Users\\me\\.apra-fleet\\workflows\\fleet-sprint\\bin\\cli.mjs --issue a-1 --branch feat/relaunch --members local'],
        ['dev cli.mjs, --branch=X', 'node /home/me/git/apra-fleet/packages/apra-fleet-se/bin/cli.mjs --branch=feat/relaunch'],
        ['cli.mjs, -b X', 'node /x/fleet-sprint/bin/cli.mjs -b feat/relaunch -B main'],
        ['cli.mjs, -bX', 'node /x/fleet-sprint/bin/cli.mjs -bfeat/relaunch'],
        ['cli.mjs, quoted --branch', 'node /x/fleet-sprint/bin/cli.mjs --branch "feat/relaunch"'],
        ['apra-fleet workflow fleet-sprint', 'C:\\Users\\me\\.apra-fleet\\bin\\apra-fleet.exe workflow fleet-sprint --branch feat/relaunch'],
        ['runner.js', 'node /x/fleet-sprint/runner.js --branch feat/relaunch'],
        ['relative bin/cli.mjs from the package folder', 'node bin/cli.mjs --branch feat/relaunch'],
        ['npm global bin shim target', 'node /usr/lib/node_modules/@apralabs/apra-fleet-se/bin/cli.mjs --branch feat/relaunch'],
        ['branch differing only in case', 'node /x/fleet-sprint/bin/cli.mjs --branch Feat/Relaunch'],
        ['branch with an origin/ prefix', 'node /x/fleet-sprint/bin/cli.mjs --branch origin/feat/relaunch'],
    ];
    for (const [label, cmd] of ENGINE_SAME) {
        test(`real engine for this branch (${label}): refused as already running`, () => {
            const out = attempt(cmd);
            assert.equal(out.reclaimed, false);
            assert.ok(out.err instanceof SprintLockHeldError);
            assert.match(out.err.message, /already running under pid/);
            assert.ok(fs.existsSync(out.lp), 'the lock must be left in place');
        });
    }

    test('real engine for another branch: a recycled pid, reclaimed', () => {
        const out = attempt('node /x/fleet-sprint/bin/cli.mjs --branch feat/other -B feat/relaunch');
        assert.equal(out.reclaimed, true, out.err && out.err.message);
    });

    test('-B (the base flag) is not read as the branch', () => {
        const out = attempt('node /x/fleet-sprint/bin/cli.mjs -B feat/relaunch --branch feat/other');
        assert.equal(out.reclaimed, true, out.err && out.err.message);
    });

    for (const [label, cmd] of [
        ['cli.mjs', 'node C:\\Users\\me\\.apra-fleet\\workflows\\fleet-sprint\\bin\\cli.mjs --args-file C:\\tmp\\a.json'],
        ['workflow fleet-sprint', 'apra-fleet workflow fleet-sprint --issue a-1'],
    ]) {
        test(`real engine without --branch (${label}): identity could not be verified, naming the lock path`, () => {
            const out = attempt(cmd);
            assert.equal(out.reclaimed, false);
            assert.ok(out.err instanceof SprintLockHeldError);
            assert.match(out.err.message, /identity could not be verified/);
            assert.ok(out.err.message.includes(out.lp), out.err.message);
            assert.doesNotMatch(out.err.message, /already running/);
            assert.ok(fs.existsSync(out.lp));
        });
    }
});

describe('readProcessCommandLine (real per-OS reader)', () => {
    test('reads this process command line', { timeout: 60_000 }, () => {
        assert.match(readProcessCommandLine(process.pid) || '', /node/i);
    });
});

describe('test sandbox sprint-lock dir', () => {
    test('ensureTestSandbox sets APRA_FLEET_SPRINT_LOCK_DIR inside the sandbox root', () => {
        // Run in a child so the sandbox's HOME rewrite never touches this process.
        const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-lock-sandbox-home-'));
        const script = `
            import { ensureTestSandbox } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, '../../../scripts/test-sandbox.mjs')).href)};
            const sb = ensureTestSandbox(process.env);
            console.log(JSON.stringify({ root: sb.root, dir: process.env.APRA_FLEET_SPRINT_LOCK_DIR }));
            sb.cleanup();`;
        const childEnv = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
        for (const k of ['APRA_TEST_SANDBOX_ROOT', 'APRA_TEST_REAL_HOME', 'NODE_OPTIONS', 'APRA_FLEET_SPRINT_LOCK_DIR']) delete childEnv[k];
        try {
            const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: childEnv });
            assert.equal(r.status, 0, r.stderr);
            const { root, dir } = JSON.parse(r.stdout.trim());
            assert.ok(dir, 'APRA_FLEET_SPRINT_LOCK_DIR must be set');
            assert.ok(path.resolve(dir).startsWith(path.resolve(root) + path.sep), `${dir} not under ${root}`);
        } finally {
            fs.rmSync(fakeHome, { recursive: true, force: true });
        }
    });
});
