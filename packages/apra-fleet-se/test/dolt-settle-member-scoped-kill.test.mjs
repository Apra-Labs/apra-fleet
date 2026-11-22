// dolt-settle binary-lock self-heal must only ever stop the dolt sql-server(s)
// THIS member started. The dolt binary path is per OS user, so a kill keyed on
// the binary path would take down every same-user member's server.
//
// Revert check (documented in the bead close note): restoring the old
// killProcessAtPath (pkill -f on the bin path / Get-Process Path -eq) makes the
// "generated kill commands" and "two members" tests fail.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensurePinnedDolt, spawnEphemeralServer, settlePidfile, DOLT_VERSION } from '../fleet-sprint/dolt-settle.mjs';

const PINNED = DOLT_VERSION.replace(/^v/, '');

function decode(cmd) {
    const m = String(cmd).match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)$/i);
    return m ? Buffer.from(m[1], 'base64').toString('utf16le') : String(cmd);
}

/** A runner whose install is blocked by a lock until `unlockOn` says otherwise.
 *  `killOutput(text)` decides what the kill script reports. */
function makeLockedRunner({ platform, killOutput, unlockOnKill = true }) {
    const calls = [];
    let installed = '1.86.3';
    let locked = true;
    const command = async (cmd) => {
        calls.push(cmd);
        const text = decode(cmd);
        if (/version"?$/.test(text.trim())) return { ok: true, output: `dolt version ${installed}\n`, error: null };
        if (/Invoke-WebRequest|curl -fL/.test(text)) {
            if (locked) return { ok: false, output: '', error: 'ETXTBSY text file busy / being used by another process' };
            installed = PINNED;
            return { ok: true, output: '', error: null };
        }
        if (/KILLED:/.test(text)) {
            const out = killOutput(text);
            if (unlockOnKill && /KILLED:\d+/.test(out)) locked = false;
            return { ok: true, output: out, error: null };
        }
        return { ok: true, output: '', error: null };
    };
    return { command, calls };
}

const SHELLS = [
    { name: 'posix', platform: 'linux', shell: '' },
    { name: 'gitbash', platform: 'win32', shell: 'gitbash' },
    { name: 'powershell', platform: 'win32', shell: 'pwsh7' },
];

for (const { name, platform, shell } of SHELLS) {
    test(`[${name}] generated kill command is never keyed on the binary path alone`, async () => {
        const { command, calls } = makeLockedRunner({ platform, killOutput: () => '' });
        await ensurePinnedDolt({ command, member: 'mA', platform, shell });
        const killCalls = calls.filter((c) => /KILLED:/.test(decode(c)));
        assert.equal(killCalls.length, 1, 'exactly one kill command expected');
        const text = decode(killCalls[0]);
        assert.ok(!/pkill/.test(text), `no pkill allowed: ${text}`);
        assert.ok(!/Get-Process/.test(text), `no Get-Process by Path allowed: ${text}`);
        assert.ok(!/Path\s+-eq/.test(text), `no Path -eq filter allowed: ${text}`);
        assert.ok(text.includes(settlePidfile('mA')[platform === 'win32' ? 'powershell' : 'posix']), 'kill must be driven by this member\'s own pidfile');
        assert.ok(/sql-server/.test(text), 'kill must verify the live command line is a dolt sql-server');
    });

    test(`[${name}] lock held by a process this member did not start -> nothing killed, fallback taken with a logged reason`, async () => {
        const { command, calls } = makeLockedRunner({ platform, killOutput: () => '' });
        const logs = [];
        const res = await ensurePinnedDolt({ command, member: 'mA', platform, shell, log: (l) => logs.push(l) });
        assert.equal(res.pinned, false);
        assert.equal(res.version, '1.86.3', 'runnable present dolt is used');
        assert.ok(res.warnings.some((w) => /pin not enforced/.test(w)));
        assert.ok(logs.some((l) => /did not start/.test(l)), `expected a log naming the reason, got: ${logs.join(' | ')}`);
        const installs = calls.filter((c) => /Invoke-WebRequest|curl -fL/.test(decode(c)));
        assert.equal(installs.length, 1, 'no retry when nothing of ours was killed');
    });

    test(`[${name}] lock held by this member's own recorded pid -> that pid is killed and install retried`, async () => {
        const { command, calls } = makeLockedRunner({ platform, killOutput: () => 'KILLED:4321' });
        const logs = [];
        const res = await ensurePinnedDolt({ command, member: 'mA', platform, shell, log: (l) => logs.push(l) });
        assert.equal(res.pinned, true);
        assert.ok(logs.some((l) => /4321/.test(l)));
        const installs = calls.filter((c) => /Invoke-WebRequest|curl -fL/.test(decode(c)));
        assert.equal(installs.length, 2, 'install retried after the kill');
    });
}

// ---------------------------------------------------------------------------
// bm2d.1.2 test 1: simulated host, two members on one OS user.
// ---------------------------------------------------------------------------

for (const { name, platform, shell } of SHELLS) {
    test(`[${name}] two same-user members: A's binary-lock retry targets only A's pids, B untouched`, async () => {
        // Shared "host": pidfile path -> recorded pids, populated from the
        // spawn scripts exactly as dispatched (no re-derivation of the format).
        const pidfiles = new Map();
        const killedPids = [];
        const record = (text, pid) => {
            const m = text.match(/>> "([^"]+)"/) || text.match(/Add-Content -Path "([^"]+)"/);
            assert.ok(m, `spawn script must record the pid in a pidfile: ${text}`);
            if (!pidfiles.has(m[1])) pidfiles.set(m[1], []);
            pidfiles.get(m[1]).push(pid);
        };
        const spawnRunner = (pid) => async (cmd) => {
            const text = decode(cmd);
            record(text, pid);
            return { ok: true, output: `PID:${pid}`, error: null };
        };
        const dolt = platform === 'win32' ? '"$env:USERPROFILE\\.apra-fleet\\bin\\dolt.exe"' : '"$HOME/.apra-fleet/bin/dolt"';
        await spawnEphemeralServer({ command: spawnRunner(1111), member: 'mA', platform, doltPath: dolt, dataDir: '/data/a', host: '127.0.0.1', port: 13301, shell });
        await spawnEphemeralServer({ command: spawnRunner(2222), member: 'mB', platform, doltPath: dolt, dataDir: '/data/b', host: '127.0.0.1', port: 13302, shell });
        assert.equal(pidfiles.size, 2, 'each member records into its own pidfile');

        const { command, calls } = makeLockedRunner({
            platform,
            killOutput: (text) => {
                const m = text.match(/\$f = "([^"]+)"/) || text.match(/F="([^"]+)"/);
                const pids = (pidfiles.get(m[1]) || []);
                killedPids.push(...pids);
                return pids.map((p) => `KILLED:${p}`).join('\n');
            },
        });
        const res = await ensurePinnedDolt({ command, member: 'mA', platform, shell });
        assert.equal(res.pinned, true);
        assert.deepEqual(killedPids, [1111], 'only member A\'s pid is targeted');
        const bFile = [...pidfiles.keys()].find((k) => k.includes('mB'));
        assert.ok(bFile, 'B has its own pidfile');
        for (const c of calls) assert.ok(!decode(c).includes(bFile), 'no command may touch member B\'s pidfile');
    });
}

// ---------------------------------------------------------------------------
// bm2d.1.2 tests 2 + 3: real processes (POSIX hosts only).
// ---------------------------------------------------------------------------

const POSIX = process.platform !== 'win32';
const skipReason = POSIX ? false : 'POSIX-only: runs the generated bash kill script against real child processes';

/** Dummy long-running process whose command line mimics a dolt sql-server. */
function spawnDummy(args) {
    return spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', ...args], { stdio: 'ignore' });
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitDead(pid, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end && alive(pid)) await new Promise((r) => setTimeout(r, 50));
    return !alive(pid);
}

async function realKillScriptFor(member) {
    const { command, calls } = makeLockedRunner({ platform: 'linux', killOutput: () => '' });
    await ensurePinnedDolt({ command, member, platform: 'linux' });
    return calls.map(decode).find((t) => /KILLED:/.test(t));
}

test('real processes: A\'s kill leaves B\'s lookalike dolt sql-server alive', { skip: skipReason }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-kill-'));
    fs.mkdirSync(path.join(home, '.apra-fleet'));
    const a = spawnDummy(['dolt', 'sql-server', '--host', '127.0.0.1', '--port', '13401', '--data-dir', path.join(home, 'a')]);
    const b = spawnDummy(['dolt', 'sql-server', '--host', '127.0.0.1', '--port', '13402', '--data-dir', path.join(home, 'b')]);
    try {
        await new Promise((r) => setTimeout(r, 300));
        fs.writeFileSync(path.join(home, '.apra-fleet', settlePidfile('mA').name), `${a.pid} 13401\n`);
        fs.writeFileSync(path.join(home, '.apra-fleet', settlePidfile('mB').name), `${b.pid} 13402\n`);
        const script = await realKillScriptFor('mA');
        const r = spawnSync('bash', ['-c', script], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
        assert.match(r.stdout, new RegExp(`KILLED:${a.pid}`));
        assert.ok(await waitDead(a.pid), 'A\'s server must be stopped');
        assert.ok(alive(b.pid), 'B\'s server must still be alive');
    } finally {
        for (const p of [a, b]) { try { p.kill('SIGKILL'); } catch { /* already gone */ } }
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('real processes: pid reuse guard -- a recorded pid now running something else is not killed', { skip: skipReason }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-kill-'));
    fs.mkdirSync(path.join(home, '.apra-fleet'));
    // Not a dolt sql-server: the pid was "reused" by an unrelated command line.
    const other = spawnDummy(['unrelated-worker', '--port', '13403']);
    try {
        await new Promise((r) => setTimeout(r, 300));
        fs.writeFileSync(path.join(home, '.apra-fleet', settlePidfile('mA').name), `${other.pid} 13403\n`);
        const script = await realKillScriptFor('mA');
        const r = spawnSync('bash', ['-c', script], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
        assert.ok(!/KILLED:/.test(r.stdout), `nothing may be killed: ${r.stdout}`);
        assert.ok(alive(other.pid), 'the reused pid must survive');
    } finally {
        try { other.kill('SIGKILL'); } catch { /* already gone */ }
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('Windows kill script verifies process name and command line, not just the pid', async () => {
    const { command, calls } = makeLockedRunner({ platform: 'win32', killOutput: () => '', unlockOnKill: false });
    await ensurePinnedDolt({ command, member: 'mA', platform: 'win32', shell: 'pwsh7' });
    const text = calls.map(decode).find((t) => /KILLED:/.test(t));
    assert.match(text, /\$proc\.Name -eq 'dolt\.exe'/);
    assert.match(text, /CommandLine -match \('sql-server\.\*--port '/);
});

// ---------------------------------------------------------------------------
// Port anchoring: a recorded port must not match a longer port with the same
// prefix (3307 vs 33070). The generated kill scripts run for real with the
// process lookup and the kill shimmed (no real process is touched).
// ---------------------------------------------------------------------------

function findBashForTest() {
    if (process.platform !== 'win32') return 'bash';
    try {
        const execPath = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim();
        const bash = path.resolve(execPath, '..', '..', '..', 'bin', 'bash.exe');
        return fs.existsSync(bash) ? bash : null;
    } catch { return null; }
}
const TEST_BASH = findBashForTest();

const PORT_CASES = [
    { args: 'dolt sql-server --host 127.0.0.1 --port 33070 --data-dir /d', killed: false, what: 'a longer port with the same prefix' },
    { args: 'dolt sql-server --host 127.0.0.1 --port 3307 --data-dir /d', killed: true, what: 'the recorded port' },
    { args: 'dolt sql-server --host 127.0.0.1 --port 3307', killed: true, what: 'the recorded port as the last argument' },
];

for (const c of PORT_CASES) {
    test(`[posix] recorded-pid kill: ${c.what} -> ${c.killed ? 'killed' : 'not killed'}`, { skip: TEST_BASH ? false : 'no bash' }, async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-port-'));
        try {
            fs.mkdirSync(path.join(home, '.apra-fleet'));
            fs.writeFileSync(path.join(home, '.apra-fleet', settlePidfile('mA').name), '4242 3307\n');
            const script = await realKillScriptFor('mA');
            const shim = 'ps() { echo "$FAKE_ARGS"; }; kill() { return 0; }; ';
            const r = spawnSync(TEST_BASH, ['-c', shim + script], {
                env: { ...process.env, HOME: home.replace(/\\/g, '/'), FAKE_ARGS: c.args }, encoding: 'utf8',
            });
            assert.equal(/KILLED:4242/.test(r.stdout), c.killed, `stdout=${r.stdout} stderr=${r.stderr}`);
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    test(`[powershell] recorded-pid kill: ${c.what} -> ${c.killed ? 'killed' : 'not killed'}`, { skip: process.platform === 'win32' ? false : 'Windows-only: needs powershell.exe' }, async () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-port-'));
        try {
            fs.mkdirSync(path.join(home, '.apra-fleet'));
            fs.writeFileSync(path.join(home, '.apra-fleet', settlePidfile('mA').name), '4242 3307\n');
            const { command, calls } = makeLockedRunner({ platform: 'win32', killOutput: () => '', unlockOnKill: false });
            await ensurePinnedDolt({ command, member: 'mA', platform: 'win32', shell: 'pwsh7' });
            const script = calls.map(decode).find((t) => /KILLED:/.test(t));
            const shim = "function Get-CimInstance { [pscustomobject]@{ Name = 'dolt.exe'; CommandLine = $env:FAKE_ARGS } }; function Stop-Process { }; ";
            const encoded = Buffer.from(shim + script, 'utf16le').toString('base64');
            const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
                env: { ...process.env, USERPROFILE: home, FAKE_ARGS: c.args }, encoding: 'utf8',
            });
            assert.equal(/KILLED:4242/.test(r.stdout), c.killed, `stdout=${r.stdout} stderr=${r.stderr}`);
        } finally {
            fs.rmSync(home, { recursive: true, force: true });
        }
    });
}
