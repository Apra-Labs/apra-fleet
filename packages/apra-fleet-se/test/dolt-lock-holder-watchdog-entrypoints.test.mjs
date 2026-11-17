// The lock-holder watchdog through the real D-push and D-pull entry points
// (injected command(), clock, timer and sleep), plus one real-filesystem case
// on POSIX: a child process holding a beads gate lock in a temp clone layout is
// named by the generated Linux/macOS probe.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

import { buildLockHolderProbe, parseLockHolderProbe, BEADS_LOCK_FILES } from '../fleet-sprint/beads-lock-probe.mjs';
import {
    doltPullBefore,
    doltPushAfter,
    invalidateSyncRemoteCache,
    clearLastSyncedTip,
    clearTipProbeFailures,
    setMemberTargetResolver,
    DOLT_LOCK_PROBE_AFTER_MS,
} from '../fleet-sprint/dolt-sync.mjs';
import { DoltLockHeldError } from '../fleet-sprint/errors.mjs';

const SYNC_REMOTE = 'git+https://example.com/org/repo.git';
const CONNECTION_RESET = 'Error: fetch from origin/main: connection reset by peer';

function fakeTimer() {
    const timers = [];
    return {
        timers,
        set(fn, ms) { const t = { fn, ms, cleared: false, fired: false }; timers.push(t); return t; },
        clear(t) { t.cleared = true; },
        /** Fire every armed, not-yet-fired, not-cleared watchdog. */
        fireArmed() {
            for (const t of timers) {
                if (!t.cleared && !t.fired) { t.fired = true; t.fn(); }
            }
        },
    };
}

async function flush() {
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
}

/**
 * A scripted member: each `bd dolt <op>` attempt is answered by the next
 * entry of `script` -- 'hang' (held open until releaseAll()), or a result.
 * The landed check sees the remote tip move once a push succeeded.
 */
function scriptedMember({ target, op, script, probeOutput }) {
    const calls = [];
    const pendingReleases = [];
    let attempts = 0;
    let pushed = 0;
    const probe = buildLockHolderProbe(target);
    const command = async (cmd) => {
        calls.push(cmd);
        if (cmd.includes('bd config get sync.remote')) return { ok: true, output: JSON.stringify({ value: SYNC_REMOTE }), error: null };
        if (cmd === probe) return { ok: true, output: probeOutput, error: null };
        if (cmd.includes('ls-remote')) return { ok: true, output: `${(pushed > 0 ? 'b' : 'a').repeat(40)}\trefs/dolt/data\n`, error: null };
        if (cmd.endsWith(`bd dolt ${op}`)) {
            const step = script[Math.min(attempts, script.length - 1)];
            attempts += 1;
            if (step === 'hang') {
                return new Promise((resolve) => pendingReleases.push(() => resolve({ ok: true, output: '', error: null })));
            }
            if (step.ok && op === 'push') pushed += 1;
            return step;
        }
        return { ok: true, output: '', error: null };
    };
    return {
        command,
        probeCalls: () => calls.filter((c) => c === probe).length,
        syncCalls: () => calls.filter((c) => c.endsWith(`bd dolt ${op}`)),
        releaseAll: () => { while (pendingReleases.length) pendingReleases.shift()(); },
    };
}

beforeEach(() => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
    setMemberTargetResolver(null);
});

describe('watchdog through the entry points', () => {
    test('D-pull: one probe per silent attempt across a retried step, each logged', async () => {
        const target = { os: 'linux', shell: '' };
        let clock = 0;
        const timer = fakeTimer();
        const logs = [];
        // Attempt 1 hangs then fails transiently; attempt 2 hangs then succeeds.
        let hangRelease = [];
        const calls = [];
        const probe = buildLockHolderProbe(target);
        let attempts = 0;
        const command = async (cmd) => {
            calls.push(cmd);
            if (cmd.includes('bd config get sync.remote')) return { ok: true, output: JSON.stringify({ value: SYNC_REMOTE }), error: null };
            if (cmd === probe) return { ok: true, output: `HOLDER\t${4000 + attempts}\t00:59\t.beads/embeddeddolt.gate.lock\tbd dolt pull\n`, error: null };
            if (cmd.endsWith('bd dolt pull')) {
                attempts += 1;
                const result = attempts === 1 ? { ok: false, output: '', error: CONNECTION_RESET } : { ok: true, output: '', error: null };
                return new Promise((resolve) => hangRelease.push(() => resolve(result)));
            }
            return { ok: true, output: '', error: null };
        };
        const pull = doltPullBefore('m1', { command, remoteTipFingerprint: false, memberTarget: target, now: () => clock, sleep: async () => {}, lockProbeTimer: timer, log: (l) => logs.push(l) });
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            await flush();
            clock += 61_000;
            timer.fireArmed();
            await flush();
            assert.strictEqual(calls.filter((c) => c === probe).length, attempt, `exactly one probe after attempt ${attempt} went silent`);
            hangRelease.shift()();
        }
        assert.strictEqual((await pull).ok, true);
        assert.strictEqual(timer.timers.length, 2, 'one watchdog per attempt');
        const probeLogs = logs.filter((l) => /Beads lock holders: pid \d+/.test(l));
        assert.strictEqual(probeLogs.length, 2, logs.join('\n'));
        assert.match(probeLogs[0], /pid 4001 \(age 59s\) on \.beads\/embeddeddolt\.gate\.lock: bd dolt pull/);
    });

    test('D-push held by a foreign process: typed error with holder pid and command line before 600s; the push mutex is kept until the abandoned push ends', async () => {
        const target = { os: 'windows', shell: 'gitbash' };
        let clock = 0;
        const timer = fakeTimer();
        const m = scriptedMember({ target, op: 'push', script: ['hang'], probeOutput: 'HOLDER\t9001\t3600\t.beads/dolt.gate.lock\tbd.exe dolt push --stale\n' });
        const events = [];
        const mutex = {
            acquire: async () => { events.push('acquire'); return { token: 't1' }; },
            release: async () => { events.push('release'); },
        };
        const push = doltPushAfter('win', { command: m.command, memberTarget: target, mutex, now: () => clock, lockProbeTimer: timer }).then(() => null, (e) => e);
        await flush();
        clock = 61_000;
        timer.fireArmed();
        const err = await push;
        assert.ok(err instanceof DoltLockHeldError, `got ${err && err.name}: ${err && err.message}`);
        assert.strictEqual(err.code, 'DOLT_BEADS_LOCK_HELD');
        assert.match(err.message, /^\[Dolt\] D-push for member 'win' failed: a beads lock/);
        assert.match(err.message, /pid 9001/);
        assert.match(err.message, /bd\.exe dolt push --stale/);
        assert.ok(clock < 600_000);
        assert.deepStrictEqual(m.syncCalls(), ['GOMAXPROCS=1 bd dolt push'], 'not retried');

        await flush();
        assert.deepStrictEqual(events, ['acquire'], 'mutex NOT released while the abandoned push still runs');
        m.releaseAll();
        await flush();
        assert.deepStrictEqual(events, ['acquire', 'release'], 'released once the abandoned push ended');
    });

    test('fast D-push and D-pull: no probe, watchdog disarmed', async () => {
        const target = { os: 'darwin', shell: '' };
        for (const op of ['pull', 'push']) {
            const timer = fakeTimer();
            const m = scriptedMember({ target, op, script: [{ ok: true, output: '', error: null }], probeOutput: '' });
            const result = op === 'pull'
                ? await doltPullBefore('m1', { command: m.command, remoteTipFingerprint: false, memberTarget: target, lockProbeTimer: timer })
                : await doltPushAfter('m1', { command: m.command, memberTarget: target, lockProbeTimer: timer });
            assert.strictEqual(result.ok, true, op);
            assert.strictEqual(m.probeCalls(), 0, `${op}: no probe`);
            assert.ok(timer.timers.length >= 1 && timer.timers.every((t) => t.cleared), `${op}: every watchdog disarmed`);
            assert.strictEqual(timer.timers[0].ms, DOLT_LOCK_PROBE_AFTER_MS);
        }
    });
});

// ---------------------------------------------------------------------------
// Real filesystem, POSIX only
// ---------------------------------------------------------------------------

const POSIX_SKIP = process.platform === 'win32'
    ? 'the generated probe is the Linux/macOS one; this host is Windows, where the probe lists candidates instead of holders'
    : false;

test('POSIX: the generated probe names the child process holding a beads gate lock', { skip: POSIX_SKIP }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beads-lock-probe-'));
    const lockRel = BEADS_LOCK_FILES[0];
    const lockAbs = path.join(root, lockRel);
    fs.mkdirSync(path.dirname(lockAbs), { recursive: true });
    fs.writeFileSync(lockAbs, '');
    // The child opens the lock file and keeps the descriptor until killed.
    const child = spawn(process.execPath, ['-e', `require('fs').openSync(${JSON.stringify(lockAbs)}, 'r+'); process.stdout.write('held\\n'); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
    try {
        await new Promise((resolve, reject) => {
            child.stdout.once('data', resolve);
            child.once('error', reject);
            child.once('exit', (code) => reject(new Error(`holder exited early (${code})`)));
        });
        const target = { os: process.platform === 'darwin' ? 'darwin' : 'linux', shell: '' };
        const output = execFileSync('/bin/sh', ['-c', buildLockHolderProbe(target)], { cwd: root, encoding: 'utf8' });
        const parsed = parseLockHolderProbe(output);
        assert.strictEqual(parsed.noLookup, null, `holders must be listable here: ${output}`);
        const holder = parsed.holders.find((h) => h.pid === child.pid);
        assert.ok(holder, `probe output must name pid ${child.pid}: ${output}`);
        assert.strictEqual(holder.lock, lockRel);
        assert.match(holder.commandLine, /node|-e/);
        assert.ok(holder.ageS !== null && holder.ageS >= 0);
    } finally {
        child.kill('SIGKILL');
        await new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve)));
        fs.rmSync(root, { recursive: true, force: true });
    }
    assert.strictEqual(fs.existsSync(root), false, 'temp clone removed');
    let alive = true;
    try { process.kill(child.pid, 0); } catch { alive = false; }
    assert.strictEqual(alive, false, 'holder process is gone');
});
