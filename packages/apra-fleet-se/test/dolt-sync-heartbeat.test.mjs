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
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { withSyncHeartbeat, stripSyncHeartbeat, bdSyncCommandFor, logicalBdCommand, unwrapSyncHeartbeat, SYNC_HEARTBEAT_PREFIX, GIT_STALL_ABORT_ENV } from '../fleet-sprint/bd-sync-command.mjs';
import {
    classifyDoltFailure as classifyDoltFailureText,
    doltPushAfter,
    doltPullBefore,
    classifySyncError,
    toNeutralDegradedKind,
    invalidateSyncRemoteCache,
    clearLastSyncedTip,
    clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';
import { DoltSyncTimeLimitError } from '../fleet-sprint/errors.mjs';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';

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

// ---------------------------------------------------------------------------
// Kill path: the product's own kill command leaves no sync child behind
// ---------------------------------------------------------------------------

const DIST_OS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'os');

function alive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Every descendant pid of `root` (OS process table walk). */
function descendants(root) {
    const out = [];
    const walk = (pid) => {
        let kids = [];
        if (IS_WIN) {
            const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8' });
            kids = r.stdout.split(/\s+/).filter(Boolean).map(Number);
        } else {
            const r = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
            kids = String(r.stdout || '').split(/\s+/).filter(Boolean).map(Number);
        }
        for (const k of kids) { out.push(k); walk(k); }
    };
    walk(root);
    return out;
}

const killSkip = !fs.existsSync(path.join(DIST_OS, IS_WIN ? 'windows.js' : 'linux.js'))
    ? 'needs the root build (dist/os)'
    : (!IS_WIN && spawnSync('pgrep', ['-V']).status !== 0 ? 'no pgrep' : false);

test('the product kill path (OsCommands.killPid) on a heartbeating sync leaves no sync child running', { skip: killSkip, timeout: 60_000 }, async () => {
    const dir = makeFakeDir();
    try {
        const env = envWith(dir, { FAKE_SLEEP_S: '40', FAKE_EXIT: '0' });
        const target = IS_WIN ? { os: 'windows', shell: 'powershell' } : { os: 'linux', shell: '' };
        const wrapped = withSyncHeartbeat(`${FAKE} dolt push`, target, { intervalS: 1, capS: 60 });
        const child = IS_WIN
            ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', wrapped], { env, windowsHide: true })
            : spawn('bash', ['-c', wrapped], { env });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        // Wait for the first heartbeat: the sync child is running by then.
        for (let i = 0; i < 100 && !out.includes(SYNC_HEARTBEAT_PREFIX); i += 1) await new Promise((r) => setTimeout(r, 100));
        assert.ok(out.includes(SYNC_HEARTBEAT_PREFIX), 'the wrapper is heartbeating');
        const tree = descendants(child.pid);
        assert.ok(tree.length > 0, 'the sync child exists before the kill');
        const mod = await import(pathToFileURL(path.join(DIST_OS, IS_WIN ? 'windows.js' : 'linux.js')).href);
        const cmds = IS_WIN ? new mod.WindowsCommands() : new mod.LinuxCommands();
        const killCmd = cmds.killPid(child.pid);
        if (IS_WIN) spawnSync('cmd.exe', ['/d', '/s', '/c', killCmd], { stdio: 'ignore' });
        else spawnSync('bash', ['-c', killCmd], { stdio: 'ignore' });
        await new Promise((r) => setTimeout(r, 1000));
        const left = [child.pid, ...tree].filter(alive);
        assert.deepEqual(left, [], `no process of the killed sync tree remains (tree ${[child.pid, ...tree].join(',')})`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Stalled transfer: git aborts it itself, a slow-but-moving one survives
// ---------------------------------------------------------------------------

test('every sync wire form carries the stalled-transfer abort env', () => {
    assert.deepEqual(GIT_STALL_ABORT_ENV.map(([n, v]) => `${n}=${v}`), ['GIT_HTTP_LOW_SPEED_LIMIT=1000', 'GIT_HTTP_LOW_SPEED_TIME=300']);
    for (const t of [{ os: 'linux' }, { os: 'darwin' }, { os: 'windows', shell: 'gitbash' }, { os: 'windows', shell: '' }]) {
        for (const wire of [bdSyncCommandFor('bd dolt push', t), withSyncHeartbeat('bd dolt push', t, { intervalS: 30, capS: 2700 })]) {
            assert.match(wire, /GIT_HTTP_LOW_SPEED_LIMIT(=|=')1000/, wire);
            assert.match(wire, /GIT_HTTP_LOW_SPEED_TIME(=|=')300/, wire);
        }
    }
    assert.equal(classifyDoltFailureText('error: RPC failed; curl 28 Operation too slow. Less than 1000 bytes/sec transferred the last 300 seconds'), 'transient');
});

// A real `bd dolt push` against a stalling HTTP remote (captured live): git's
// low-speed abort arrives inside dolt's "could not be accessed" wrapper.
const DOLT_WRAPPED_STALL = "Error: push to origin/main: Error 1105: failed to get remote db; the remote: origin 'git+http://127.0.0.1:18763/remote.git' could not be accessed; fatal: unable to access 'http://127.0.0.1:18763/remote.git/': Operation too slow. Less than 1000 bytes/sec transferred the last 300 seconds\n"
    + 'hint: dolt does not support interactive credential prompts\n'
    + 'hint: configure git credentials (credential helper, token) for HTTPS remotes\n'
    + 'hint: run `ssh-add <key>` to pre-load your key for SSH remotes\n'
    + 'hint: ensure non-interactive auth is configured for GCM\n';

test('a stalled transfer aborted by git inside dolt\'s remote wrapper is transient, not remote-unreachable', async () => {
    assert.equal(classifyDoltFailureText(DOLT_WRAPPED_STALL), 'transient');
    assert.equal(classifyDoltFailureText(DOLT_WRAPPED_STALL.replace('Operation too slow. Less than 1000 bytes/sec transferred the last 300 seconds', 'curl 28 timeout')), 'transient');
    // A genuinely dead remote keeps its verdict.
    assert.equal(classifyDoltFailureText("Error 1105: failed to get remote db; the remote: origin 'git+http://127.0.0.1:1/x.git' could not be accessed"), 'remote-unreachable');
    // Through the bracket: retried by the transient ladder, then lands.
    const { command, calls } = fakeCommand({ tips: [TIP_A, TIP_B], pushes: [{ ok: false, output: '', error: DOLT_WRAPPED_STALL }, { ok: true, output: '' }] });
    const outcome = await doltPushAfter('m1', { command, checkSyncRemoteConfigured: async () => true, memberTarget: LINUX, lockProbeAfterMs: 0, sleep: async () => {} });
    assert.equal(calls.push.length, 2);
    assert.equal(outcome.pushed, true);
});

const HAS_GIT = spawnSync('git', ['--version']).status === 0;

/** git ls-remote against a local HTTP server driven by `serve(res)`, with the
 *  product's stall env (TIME shortened to 2s for the test). */
async function lsRemoteAgainst(serve) {
    const server = http.createServer((req, res) => serve(res));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', http_proxy: '', https_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '', no_proxy: '*' };
    for (const [n, v] of GIT_STALL_ABORT_ENV) env[n] = v;
    env.GIT_HTTP_LOW_SPEED_TIME = '2';
    const started = Date.now();
    const r = await new Promise((resolve) => {
        const c = spawn('git', ['ls-remote', `http://127.0.0.1:${port}/r.git`], { env, windowsHide: true });
        let err = '';
        c.stderr.on('data', (d) => { err += d; });
        const t = setTimeout(() => c.kill(), 20_000);
        c.on('close', (code) => { clearTimeout(t); resolve({ code, err }); });
    });
    await new Promise((res) => { server.closeAllConnections(); server.close(res); });
    return { ...r, elapsedMs: Date.now() - started };
}

test('a stalled git transfer aborts on the low-speed limit; a slow but moving one does not', { skip: HAS_GIT ? false : 'no git', timeout: 60_000 }, async () => {
    const stalled = await lsRemoteAgainst((res) => {
        res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement' });
        res.write('x'); // then nothing: a half-open transfer
    });
    assert.notEqual(stalled.code, 0);
    assert.match(stalled.err, /too slow|curl 28/i, stalled.err);
    assert.ok(stalled.elapsedMs < 15_000, `aborted fast (${stalled.elapsedMs}ms)`);

    const moving = await lsRemoteAgainst((res) => {
        res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement' });
        let n = 0;
        const t = setInterval(() => {
            res.write('y'.repeat(4000));
            n += 1;
            if (n >= 16) { clearInterval(t); res.end(); }
        }, 250);
    });
    assert.ok(moving.elapsedMs >= 3500, `the moving transfer ran past the 2s window (${moving.elapsedMs}ms)`);
    assert.doesNotMatch(moving.err, /too slow|curl 28/i, moving.err);
});

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
    // Only the heartbeat token goes: a bd line it interrupted is kept whole.
    assert.equal(stripSyncHeartbeat(`abc${SYNC_HEARTBEAT_PREFIX} 30s\ndef\n${SYNC_HEARTBEAT_PREFIX} 60s\r\n`), 'abcdef\n');
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

test('through FleetWorkflow.command the push payload carries the long client wait', async () => {
    const payloads = [];
    const ok = { content: [{ type: 'text', text: 'Exit code: 0\n' }], structuredContent: { exitCode: 0, stdout: '', stderr: '' } };
    let pushed = 0;
    const api = {
        async executePrompt() { throw new Error('not used'); },
        async executeCommand(payload) {
            payloads.push(payload);
            if (payload.command.includes(' ls-remote ')) {
                const sha = (pushed > 0 ? 'b' : 'a').repeat(40);
                return { content: [{ type: 'text', text: '' }], structuredContent: { exitCode: 0, stdout: `${sha}\trefs/dolt/data\n`, stderr: '' } };
            }
            if (logicalBdCommand(payload.command) === 'bd dolt push') pushed += 1;
            return ok;
        },
    };
    const wf = new FleetWorkflow(api);
    await doltPushAfter('m1', { command: (c, o) => wf.command(c, o), checkSyncRemoteConfigured: async () => true, memberTarget: LINUX, lockProbeAfterMs: 0, sleep: async () => {} });
    const push = payloads.find((p) => logicalBdCommand(p.command) === 'bd dolt push');
    assert.ok(push, 'a push was sent');
    assert.equal(push.timeout_s, 600);
    assert.ok(push.timeoutMs >= (2700 + 600) * 1000, `client wait ${push.timeoutMs}ms reaches the fleet API`);
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
