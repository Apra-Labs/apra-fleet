// A `bd dolt pull`/`bd dolt push` that stays silent past the watchdog gets
// exactly one beads lock-holder probe on the same member; its result is
// logged; a lock held by a process older than the sync fails fast with a typed
// error naming the holder instead of waiting for the 600s inactivity kill. The
// probe command is built per member OS/shell. Fake timer + clock throughout.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
    buildLockHolderProbe,
    parseLockHolderProbe,
    parseProbeAgeSeconds,
    BEADS_LOCK_FILES,
} from '../fleet-sprint/beads-lock-probe.mjs';
import {
    doltPullBefore,
    invalidateSyncRemoteCache,
    clearLastSyncedTip,
    clearTipProbeFailures,
    setMemberTargetResolver,
    DOLT_LOCK_PROBE_AFTER_MS,
} from '../fleet-sprint/dolt-sync.mjs';
import { DoltLockHeldError, DoltSyncError, DOLT_BEADS_LOCK_HELD_CODE } from '../fleet-sprint/errors.mjs';

// ---------------------------------------------------------------------------
// Probe command strings per member OS/shell
// ---------------------------------------------------------------------------

const LOCKS = '.beads/embeddeddolt.gate.lock .beads/dolt.gate.lock .beads/embeddeddolt/*/.dolt/noms/LOCK';

const LINUX_PROBE = 'if [ -d /proc/self/fd ]; then'
    + ` for f in ${LOCKS}; do [ -e "$f" ] || continue; a=$(readlink -f "$f");`
    + '  for d in /proc/[0-9]*/fd/*; do [ "$(readlink "$d" 2>/dev/null)" = "$a" ] || continue; p=$(echo "$d" | cut -d/ -f3);'
    + '   printf \'HOLDER\\t%s\\t%s\\t%s\\t%s\\n\' "$p" "$(ps -o etime= -p "$p" | tr -d \' \')" "$f" "$(tr \'\\0\' \' \' < /proc/$p/cmdline 2>/dev/null)";'
    + '  done; done | sort -u;'
    + 'elif command -v lsof >/dev/null 2>&1; then'
    + ` for f in ${LOCKS}; do [ -e "$f" ] || continue;`
    + '  for p in $(lsof -t -- "$f" 2>/dev/null | sort -u); do printf \'HOLDER\\t%s\\t%s\\t%s\\t%s\\n\' "$p" "$(ps -o etime= -p "$p" | tr -d \' \')" "$f" "$(ps -o args= -p "$p")"; done;'
    + ' done;'
    + 'else printf \'NOLOOKUP\\tneither /proc nor lsof is available on this member\\n\'; fi';

const MACOS_PROBE = 'if command -v lsof >/dev/null 2>&1; then'
    + ` for f in ${LOCKS}; do [ -e "$f" ] || continue;`
    + '  for p in $(lsof -t -- "$f" 2>/dev/null | sort -u); do printf \'HOLDER\\t%s\\t%s\\t%s\\t%s\\n\' "$p" "$(ps -o etime= -p "$p" | tr -d \' \')" "$f" "$(ps -o command= -p "$p")"; done;'
    + ' done;'
    + 'else printf \'NOLOOKUP\\tlsof is not available on this member\\n\'; fi';

const WINDOWS_PROBE_SCRIPT = "$ProgressPreference = 'SilentlyContinue';"
    + " Write-Output (@('NOLOOKUP', 'Windows has no built-in lookup of the process holding a file lock; listing running bd/dolt processes as candidates') -join [char]9);"
    + " Get-CimInstance Win32_Process -Filter \"Name='bd.exe' OR Name='dolt.exe'\" | ForEach-Object { Write-Output (@('CANDIDATE', $_.ProcessId, [int]((Get-Date) - $_.CreationDate).TotalSeconds, '-', $_.CommandLine) -join [char]9) }";

describe('buildLockHolderProbe: exact probe per member OS/shell', () => {
    test('linux walks /proc fds (lsof fallback, explicit NOLOOKUP otherwise)', () => {
        assert.strictEqual(buildLockHolderProbe({ os: 'linux', shell: '' }), LINUX_PROBE);
    });
    test('macOS uses lsof (explicit NOLOOKUP without it)', () => {
        assert.strictEqual(buildLockHolderProbe({ os: 'darwin', shell: '' }), MACOS_PROBE);
    });
    test('Windows PowerShell members run the PowerShell script as-is', () => {
        for (const shell of ['', 'powershell5', 'pwsh7']) {
            assert.strictEqual(buildLockHolderProbe({ os: 'windows', shell }), WINDOWS_PROBE_SCRIPT, `shell '${shell}'`);
        }
    });
    test('Windows Git Bash members run the same PowerShell script through -EncodedCommand', () => {
        const cmd = buildLockHolderProbe({ os: 'windows', shell: 'gitbash' });
        const m = /^powershell -NoProfile -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(cmd);
        assert.ok(m, cmd);
        assert.strictEqual(Buffer.from(m[1], 'base64').toString('utf16le'), WINDOWS_PROBE_SCRIPT);
    });
    test('an unresolved member gets the linux probe; no probe reads an environment variable', () => {
        assert.strictEqual(buildLockHolderProbe(null), LINUX_PROBE);
        for (const probe of [LINUX_PROBE, MACOS_PROBE, WINDOWS_PROBE_SCRIPT]) {
            assert.doesNotMatch(probe, /\$HOME|\$env:|\$\{|~\/|%[A-Za-z_]+%/);
        }
        // The lock names live in one constant.
        assert.deepStrictEqual([...BEADS_LOCK_FILES], LOCKS.split(' '));
    });
});

describe('parseLockHolderProbe', () => {
    test('holders, candidates, NOLOOKUP, etime ages, dedupe, glued stderr noise', () => {
        const out = [
            'HOLDER\t4242\t15:02\t.beads/embeddeddolt.gate.lock\tbd dolt push --x',
            'HOLDER\t4242\t15:02\t.beads/embeddeddolt.gate.lock\tbd dolt push --x',
            'HOLDER\t7\t1-02:00:05\t.beads/dolt.gate.lock\t/usr/bin/bd serve',
            '#< CLIXML<Objs/>NOLOOKUP\tno lookup here',
            'CANDIDATE\t99\t30\t-\tC:\\bd.exe dolt pull',
            'garbage line',
        ].join('\n');
        const r = parseLockHolderProbe(out);
        assert.deepStrictEqual(r.holders, [
            { pid: 4242, ageS: 902, lock: '.beads/embeddeddolt.gate.lock', commandLine: 'bd dolt push --x' },
            { pid: 7, ageS: 93605, lock: '.beads/dolt.gate.lock', commandLine: '/usr/bin/bd serve' },
        ]);
        assert.deepStrictEqual(r.candidates, [{ pid: 99, ageS: 30, lock: '-', commandLine: 'C:\\bd.exe dolt pull' }]);
        assert.strictEqual(r.noLookup, 'no lookup here');
        assert.strictEqual(parseProbeAgeSeconds('05:07'), 307);
        assert.strictEqual(parseProbeAgeSeconds('nonsense'), null);
        assert.deepStrictEqual(parseLockHolderProbe(''), { holders: [], candidates: [], noLookup: null });
    });
});

// ---------------------------------------------------------------------------
// The watchdog, through the real D-pull entry point
// ---------------------------------------------------------------------------

const SYNC_REMOTE = 'git+https://example.com/org/repo.git';

function fakeTimer() {
    const timers = [];
    return {
        timers,
        set(fn, ms) { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
        clear(t) { t.cleared = true; },
    };
}

/** Let pending promise chains run. */
async function flush() {
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
}

/**
 * A member whose `bd dolt pull` is held open by the test until release() and
 * whose lock-holder probe answers `probeOutput`.
 */
function silentMember({ target, probeOutput }) {
    const calls = [];
    let release = null;
    const probe = buildLockHolderProbe(target);
    const command = async (cmd, opts) => {
        calls.push(cmd);
        if (cmd.includes('bd config get sync.remote')) return { ok: true, output: JSON.stringify({ value: SYNC_REMOTE }), error: null };
        if (cmd === probe) return { ok: true, output: probeOutput, error: null };
        if (/bd dolt pull$/.test(cmd)) return new Promise((resolve) => { release = () => resolve({ ok: true, output: '', error: null }); });
        return { ok: true, output: '', error: null };
    };
    return {
        command,
        calls,
        probeCalls: () => calls.filter((c) => c === probe).length,
        syncCalls: () => calls.filter((c) => /bd dolt pull$/.test(c)),
        release: () => release(),
    };
}

beforeEach(() => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
    setMemberTargetResolver(null);
});

describe('lock-holder watchdog on a silent D-pull', () => {
    test('silent past 60s: exactly one probe for the attempt, logged with pid/age/command line, still waiting (own holder)', async () => {
        const target = { os: 'linux', shell: '' };
        let clock = 0;
        const timer = fakeTimer();
        const logs = [];
        // The holder is younger than the attempt: this sync's own bd.
        const m = silentMember({ target, probeOutput: 'HOLDER\t5150\t00:58\t.beads/embeddeddolt.gate.lock\tbd dolt pull\n' });
        const pull = doltPullBefore('m1', { command: m.command, remoteTipFingerprint: false, memberTarget: target, now: () => clock, lockProbeTimer: timer, log: (l) => logs.push(l) });
        await flush();
        assert.strictEqual(timer.timers.length, 1, 'one watchdog armed for the attempt');
        assert.strictEqual(timer.timers[0].ms, DOLT_LOCK_PROBE_AFTER_MS);
        assert.strictEqual(DOLT_LOCK_PROBE_AFTER_MS, 60000);

        clock = 61_000;
        timer.timers[0].fn();
        await flush();
        assert.strictEqual(m.probeCalls(), 1, 'exactly one probe');
        const line = logs.find((l) => /lock holders: pid 5150/i.test(l));
        assert.ok(line, `probe result logged; logs: ${logs.join('\n')}`);
        assert.match(line, /age 58s/);
        assert.match(line, /bd dolt pull/);
        assert.match(line, /still waiting/);

        m.release();
        const result = await pull;
        assert.strictEqual(result.ok, true);
        assert.strictEqual(m.probeCalls(), 1, 'still exactly one probe');
    });

    test('a foreign holder fails the sync fast with a typed error naming it (not after 600s)', async () => {
        const target = { os: 'darwin', shell: '' };
        let clock = 0;
        const timer = fakeTimer();
        const m = silentMember({ target, probeOutput: 'HOLDER\t777\t25:00\t.beads/embeddeddolt.gate.lock\tclaude --resume abc\n' });
        const pull = doltPullBefore('mac', { command: m.command, remoteTipFingerprint: false, memberTarget: target, now: () => clock, lockProbeTimer: timer }).then(() => null, (e) => e);
        await flush();
        clock = 61_000;
        timer.timers[0].fn();
        const err = await pull;
        assert.ok(err instanceof DoltLockHeldError, `expected DoltLockHeldError, got ${err && err.name}: ${err && err.message}`);
        assert.ok(err instanceof DoltSyncError);
        assert.strictEqual(err.code, DOLT_BEADS_LOCK_HELD_CODE);
        assert.strictEqual(err.code, 'DOLT_BEADS_LOCK_HELD');
        assert.match(err.message, /pid 777/);
        assert.match(err.message, /age 1500s/);
        assert.match(err.message, /claude --resume abc/);
        assert.deepStrictEqual(err.details.holders, [{ pid: 777, ageS: 1500, lock: '.beads/embeddeddolt.gate.lock', commandLine: 'claude --resume abc' }]);
        assert.ok(clock < 600_000, 'failed within the bound, long before the inactivity timeout');
        assert.strictEqual(m.syncCalls().length, 1, 'a lock-held failure is not retried');
        m.release(); // let the abandoned command end
    });

    test('a member where holders cannot be listed says so explicitly and keeps waiting', async () => {
        const target = { os: 'windows', shell: '' };
        let clock = 0;
        const timer = fakeTimer();
        const logs = [];
        const m = silentMember({ target, probeOutput: 'NOLOOKUP\tWindows has no built-in lookup\nCANDIDATE\t31\t3000\t-\tC:\\bd.exe dolt push\n' });
        const pull = doltPullBefore('win', { command: m.command, remoteTipFingerprint: false, memberTarget: target, now: () => clock, lockProbeTimer: timer, log: (l) => logs.push(l) });
        await flush();
        clock = 61_000;
        timer.timers[0].fn();
        await flush();
        const line = logs.find((l) => /cannot be listed on this member/.test(l));
        assert.ok(line, logs.join('\n'));
        assert.match(line, /candidates\): pid 31 \(age 3000s\): C:\\bd\.exe dolt push/);
        assert.match(line, /still waiting/);
        m.release();
        assert.strictEqual((await pull).ok, true);
    });

    test('a fast sync issues no probe and its command strings are unchanged', async () => {
        const target = { os: 'linux', shell: '' };
        const timer = fakeTimer();
        const calls = [];
        const command = async (cmd) => {
            calls.push(cmd);
            if (cmd.includes('bd config get sync.remote')) return { ok: true, output: JSON.stringify({ value: SYNC_REMOTE }), error: null };
            return { ok: true, output: '', error: null };
        };
        const result = await doltPullBefore('m1', { command, remoteTipFingerprint: false, memberTarget: target, lockProbeTimer: timer });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(timer.timers.length, 1);
        assert.strictEqual(timer.timers[0].cleared, true, 'the watchdog is disarmed when the sync finishes');
        assert.ok(!calls.includes(buildLockHolderProbe(target)), 'no probe');
        assert.deepStrictEqual(calls.filter((c) => /bd dolt/.test(c)), ['bd dolt pull']);
    });
});
