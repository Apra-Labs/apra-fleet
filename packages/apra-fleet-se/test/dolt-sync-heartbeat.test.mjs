// A long, silent bd sync must not be killed by the output-silence timeout
// while it runs, a timed-out push that landed must not be retried, and a sync
// that runs past its total time limit must end in a typed error.
//
// Part 1 runs the generated heartbeat wrapper for real (bash everywhere bash
// is found; PowerShell on Windows) against a fake, silent sync binary under a
// silence watchdog that mimics execute_command's timeout_s. Part 2 drives
// doltPushAfter / doltPullBefore with a fake command().
//
// ASCII only.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { withSyncHeartbeat, stripSyncHeartbeat, bdSyncCommandFor, logicalBdCommand, unwrapSyncHeartbeat, SYNC_HEARTBEAT_PREFIX } from '../fleet-sprint/bd-sync-command.mjs';
import {
    doltPushAfter,
    doltPullBefore,
    classifySyncError,
    toNeutralDegradedKind,
    invalidateSyncRemoteCache,
    clearLastSyncedTip,
    clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';
import { DoltSyncTimeLimitError } from '../fleet-sprint/errors.mjs';

beforeEach(() => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
});

// ---------------------------------------------------------------------------
// Part 1: the wrapper, run for real
// ---------------------------------------------------------------------------

/** A fake sync binary name, so no real bd can ever be started by this test. */
const FAKE = 'fakesyncbin';

function findBash() {
    if (process.platform !== 'win32') return 'bash';
    try {
        const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
        const bash = path.resolve(execPath, '..', '..', '..', 'bin', 'bash.exe');
        return fs.existsSync(bash) ? bash : null;
    } catch { return null; }
}
const BASH = findBash();
const IS_WIN = process.platform === 'win32';

function makeFakeDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-heartbeat-'));
    fs.writeFileSync(path.join(dir, FAKE), '#!/bin/sh\nsleep "$FAKE_SLEEP_S"\necho "fake-out $*"\necho fake-err >&2\nexit "$FAKE_EXIT"\n', { mode: 0o755 });
    // ping -n N waits about N-1 seconds; no output reaches the console.
    fs.writeFileSync(path.join(dir, `${FAKE}.cmd`), '@echo off\r\nset /a W=%FAKE_SLEEP_S%+1\r\nping -n %W% 127.0.0.1 >nul\r\necho fake-out %*\r\necho fake-err 1>&2\r\nexit /b %FAKE_EXIT%\r\n');
    return dir;
}

function envWith(dir, extra) {
    const env = { ...process.env, ...extra };
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    env[key] = `${dir}${path.delimiter}${env[key] || ''}`;
    return env;
}

function killTree(child) {
    if (IS_WIN) spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
    else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
}

/** Run `file args` and kill it after `silenceMs` without output (the
 *  execute_command timeout_s semantics). */
function runUnderSilenceWatchdog(file, args, env, silenceMs) {
    return new Promise((resolve) => {
        const child = spawn(file, args, { env, detached: !IS_WIN, windowsHide: true });
        let stdout = '';
        let stderr = '';
        let killed = false;
        let timer = null;
        const arm = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { killed = true; killTree(child); }, silenceMs);
        };
        arm();
        child.stdout.on('data', (d) => { stdout += d; arm(); });
        child.stderr.on('data', (d) => { stderr += d; arm(); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ killed, code, stdout, stderr }); });
    });
}

const SILENCE_MS = 2500;

const shells = [
    { name: 'posix (bash)', target: { os: 'linux', shell: '' }, skip: BASH ? false : 'no bash on this host', run: (cmd, env) => runUnderSilenceWatchdog(BASH, ['-c', cmd], env, SILENCE_MS) },
    { name: 'windows (PowerShell)', target: { os: 'windows', shell: 'powershell' }, skip: IS_WIN ? false : 'PowerShell form runs on Windows only', run: (cmd, env) => runUnderSilenceWatchdog('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], env, SILENCE_MS) },
];

for (const sh of shells) {
    test(`[${sh.name}] a silent sync longer than the silence limit is killed bare but survives under the heartbeat`, { skip: sh.skip, timeout: 60_000 }, async () => {
        const dir = makeFakeDir();
        try {
            const env = envWith(dir, { FAKE_SLEEP_S: '5', FAKE_EXIT: '3' });
            // Without the wrapper (the pre-fix wire form) the silent run is killed.
            const bare = await sh.run(sh.target.os === 'windows' ? `${FAKE} dolt push; exit $LASTEXITCODE` : `${FAKE} dolt push`, env);
            assert.equal(bare.killed, true, `the bare silent command must hit the silence watchdog: ${JSON.stringify(bare)}`);

            const wrapped = withSyncHeartbeat(`${FAKE} dolt push`, sh.target, { intervalS: 1, capS: 60 });
            const r = await sh.run(wrapped, env);
            assert.equal(r.killed, false, `the heartbeat must keep a running sync alive: ${JSON.stringify(r)}`);
            assert.equal(r.code, 3, `the sync's exit code passes through: ${JSON.stringify(r)}`);
            assert.match(r.stdout, /fake-out dolt push/);
            assert.match(r.stderr, /fake-err/);
            assert.ok(r.stdout.includes(SYNC_HEARTBEAT_PREFIX), `heartbeat lines were printed: ${r.stdout}`);
            const stripped = stripSyncHeartbeat(r.stdout);
            assert.ok(!stripped.includes(SYNC_HEARTBEAT_PREFIX));
            assert.match(stripped, /fake-out dolt push/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test(`[${sh.name}] past the total limit the heartbeat stops and the silence limit ends the sync`, { skip: sh.skip, timeout: 60_000 }, async () => {
        const dir = makeFakeDir();
        try {
            const env = envWith(dir, { FAKE_SLEEP_S: '9', FAKE_EXIT: '0' });
            const wrapped = withSyncHeartbeat(`${FAKE} dolt push`, sh.target, { intervalS: 1, capS: 2 });
            const r = await sh.run(wrapped, env);
            assert.equal(r.killed, true, `a sync past its total limit must not be kept alive: ${JSON.stringify(r)}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
}

test('withSyncHeartbeat: per-OS forms, no wrapper for an unresolved OS', () => {
    const posix = withSyncHeartbeat('bd dolt push', { os: 'linux', shell: '' }, { intervalS: 30, capS: 2700 });
    assert.ok(posix.includes(bdSyncCommandFor('bd dolt push', { os: 'linux', shell: '' })), posix);
    assert.match(posix, /-lt 2700 /);
    const gitbash = withSyncHeartbeat('bd dolt push', { os: 'windows', shell: 'gitbash' }, { intervalS: 30, capS: 2700 });
    assert.ok(gitbash.includes(bdSyncCommandFor('bd dolt push', { os: 'windows', shell: 'gitbash' })), gitbash);
    const pwsh = withSyncHeartbeat('bd dolt push', { os: 'windows', shell: 'powershell' }, { intervalS: 30, capS: 2700 });
    assert.match(pwsh, /\$env:GOMAXPROCS='1';/);
    assert.match(pwsh, /Start-Process -FilePath \$bdSyncExe -ArgumentList @\('dolt','push'\)/);
    for (const wire of [posix, gitbash, pwsh]) assert.equal(logicalBdCommand(wire), 'bd dolt push', `a wrapped push is still a push: ${wire}`);
    for (const t of [{ os: 'linux', shell: '' }, { os: 'darwin', shell: '' }, { os: 'windows', shell: 'gitbash' }, { os: 'windows', shell: '' }, { os: 'windows', shell: 'pwsh7' }]) {
        for (const c of ['bd dolt pull', 'bd dolt push']) {
            assert.equal(unwrapSyncHeartbeat(withSyncHeartbeat(c, t, { intervalS: 30, capS: 2700 })), bdSyncCommandFor(c, t), `unwrap gives the unwrapped wire form for ${JSON.stringify(t)}`);
        }
    }
    assert.equal(withSyncHeartbeat('bd dolt push', { os: '', shell: '' }, { intervalS: 30, capS: 2700 }), null);
    assert.equal(withSyncHeartbeat('bd dolt push; rm x', { os: 'linux' }, { intervalS: 30, capS: 2700 }), null);
});

// ---------------------------------------------------------------------------
// Part 2: the D-push / D-pull brackets
// ---------------------------------------------------------------------------

const TIMEOUT_ERROR = '[Command Failed] Failed to execute command on "m1": Command timed out after 600000ms of inactivity';
const TIP_A = 'a'.repeat(40);
const TIP_B = 'b'.repeat(40);

/**
 * Fake command(): sync.remote is a git+ remote; `ls-remote` answers from
 * `tips` (last one repeats); push/pull answer from `pushes`/`pulls` (last
 * one repeats). `onSync` runs before each sync answer (clock control).
 */
function fakeCommand({ tips, pushes = [{ ok: true, output: '' }], pulls = [{ ok: true, output: '' }], onSync = () => {} }) {
    const calls = { push: [], pull: [], lsRemote: 0 };
    const next = (q) => (q.length > 1 ? q.shift() : q[0]);
    const command = async (cmd, opts = {}) => {
        if (cmd.startsWith('bd config get sync.remote')) return { ok: true, output: JSON.stringify({ value: 'git+https://example.invalid/beads.git' }) };
        if (cmd.includes(' ls-remote ')) {
            calls.lsRemote += 1;
            const sha = next(tips);
            return { ok: true, output: sha ? `${sha}\trefs/dolt/data\n` : '' };
        }
        if (opts.logicalCommand === 'bd dolt push') { calls.push.push({ cmd, opts }); onSync(); return next(pushes); }
        if (opts.logicalCommand === 'bd dolt pull') { calls.pull.push({ cmd, opts }); onSync(); return next(pulls); }
        return { ok: true, output: '' };
    };
    return { command, calls };
}

const LINUX = { os: 'linux', shell: '' };

test('the D-push is issued under the heartbeat with a client wait past total limit + silence limit', async () => {
    const { command, calls } = fakeCommand({ tips: [TIP_A, TIP_B] });
    await doltPushAfter('m1', { command, checkSyncRemoteConfigured: async () => true, memberTarget: LINUX, lockProbeAfterMs: 0, sleep: async () => {} });
    assert.equal(calls.push.length, 1);
    const { cmd, opts } = calls.push[0];
    assert.ok(cmd.includes(SYNC_HEARTBEAT_PREFIX), `the push is wrapped: ${cmd}`);
    assert.equal(opts.timeout_s, 600, 'the silence limit is unchanged');
    assert.ok(opts.timeoutMs >= (2700 + 600) * 1000, `client wait ${opts.timeoutMs}ms outlasts total + silence`);
});

test('a timed-out D-push that landed is not retried', async () => {
    const { command, calls } = fakeCommand({ tips: [TIP_A, TIP_B], pushes: [{ ok: false, output: '', error: TIMEOUT_ERROR }, { ok: true, output: '' }] });
    const logs = [];
    const outcome = await doltPushAfter('m1', {
        command, checkSyncRemoteConfigured: async () => true, memberTarget: LINUX, lockProbeAfterMs: 0,
        sleep: async () => {}, log: (l) => logs.push(l),
    });
    assert.equal(calls.push.length, 1, `a landed push must not be re-sent:\n${logs.join('\n')}`);
    assert.equal(outcome.pushed, true);
    assert.ok(logs.some((l) => /timed out .* landed/.test(l)), logs.join('\n'));
});

test('a D-push past its total time limit ends in the typed error, not a retry loop', async () => {
    let clock = 1_000_000;
    const maxTotalS = 100;
    const { command, calls } = fakeCommand({
        tips: [TIP_A], // never moves: the push did not land
        pushes: [{ ok: false, output: '', error: TIMEOUT_ERROR }],
        onSync: () => { clock += (maxTotalS + 600) * 1000; },
    });
    const err = await doltPushAfter('m1', {
        command, checkSyncRemoteConfigured: async () => true, memberTarget: LINUX, lockProbeAfterMs: 0,
        sleep: async () => {}, now: () => clock, maxTotalS,
    }).then(() => null, (e) => e);
    assert.ok(err instanceof DoltSyncTimeLimitError, `expected DoltSyncTimeLimitError, got ${err && err.name}: ${err && err.message}`);
    assert.equal(calls.push.length, 1, 'never retried from zero');
    assert.match(err.message, /total time limit/);
    assert.match(err.message, /too large or too slow/);
    assert.match(err.message, /garbage-collect, prune closed issues, flatten history/);
    assert.equal(err.details.kind, 'time-limit');
    assert.equal(classifySyncError(err), 'time-limit');
    assert.equal(toNeutralDegradedKind('time-limit'), 'unknown');
});

test('a D-pull past its total time limit ends in the typed error too', async () => {
    let clock = 1_000_000;
    const { command, calls } = fakeCommand({
        tips: [TIP_A],
        pulls: [{ ok: false, output: '', error: TIMEOUT_ERROR }],
        onSync: () => { clock += 4000 * 1000; },
    });
    const err = await doltPullBefore('m1', {
        command, memberTarget: LINUX, lockProbeAfterMs: 0, remoteTipFingerprint: false,
        sleep: async () => {}, now: () => clock,
    }).then(() => null, (e) => e);
    assert.ok(err instanceof DoltSyncTimeLimitError, `expected DoltSyncTimeLimitError, got ${err && err.name}: ${err && err.message}`);
    assert.equal(calls.pull.length, 1);
});

test('a timeout under the total limit that did not land is still retried (unchanged ladder)', async () => {
    const { command, calls } = fakeCommand({ tips: [TIP_A, TIP_A, TIP_A, TIP_B], pushes: [{ ok: false, output: '', error: TIMEOUT_ERROR }, { ok: true, output: '' }] });
    const outcome = await doltPushAfter('m1', { command, checkSyncRemoteConfigured: async () => true, memberTarget: LINUX, lockProbeAfterMs: 0, sleep: async () => {} });
    assert.equal(calls.push.length, 2);
    assert.equal(outcome.pushed, true);
});
