import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    createDoltOrphanSweep,
    buildSweepCommand,
    parseSweepOutput,
    memberShellFamily,
    normalizeMsysPathForPlatform,
    DEFAULT_SWEEP_INTERVAL_MS,
    DEFAULT_MAX_AGE_MS,
    SETTLE_PORT_RANGE,
} from '../src/supervisor/dolt-orphan-sweep.mjs';
import { DEFAULT_PORT_RANGE } from '../fleet-sprint/dolt-settle.mjs';

// =============================================================================
// Supervisor orphaned-`dolt sql-server` sweep (docs/dolt-sync-redesign.md
// Part 3.3).
//
// settle's own try/finally tears its ephemeral server down on every path
// INSIDE the orchestrator process. This sweep is the backstop for the single
// case a finally cannot cover: the orchestrator being SIGKILLed mid-settle,
// leaving a detached server holding the member's beads data-dir lock (the
// apra-fleet-5mqg damage class). It must be narrow enough that it can never
// interrupt a settle in progress or kill an operator's own dolt server.
// =============================================================================

const silent = { log: () => {}, error: () => {} };

// The win32 branch now wraps its raw PowerShell script as an opaque
// `powershell -EncodedCommand <base64>` string (apra-fleet-40no) so it is
// safe to dispatch regardless of whether the receiving member's actual
// shell is real PowerShell or gitbash. Decode it back to the raw script
// before asserting on its content, matching the convention already
// established in test/se-os-commands-shell-matrix.test.mjs.
function decodeWinCommand(wrapped) {
    const m = wrapped.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)$/i);
    assert.ok(m, `expected a -EncodedCommand envelope, got: ${wrapped}`);
    return Buffer.from(m[1], 'base64').toString('utf16le');
}

// =============================================================================
// apra-fleet-j918.6.3 -- REAL PowerShell execution of the generated win32 probe.
//
// The win32 seam tests below used to extract the generated `-like` clause with
// a regex and REBUILD it in JavaScript (`split('*').join('.*')`). That is a
// re-implementation of PowerShell's semantics, not PowerShell: it could not
// catch a quoting defect, could not catch the `$Matches` clobbering the
// generated script's own comment warns about, and silently asserted on JS
// regex behaviour rather than on what a Windows member would actually select.
//
// Now the REAL script runs in a REAL PowerShell. `pwsh` (PowerShell 7) is
// cross-platform, so this executes on Linux and macOS too -- the probe's
// filter is ordinary PowerShell expression evaluation with no Windows-only
// dependency except the process SOURCE.
//
// EXACTLY ONE substitution is made: the `Get-CimInstance Win32_Process ...`
// source is swapped for a literal array of fabricated candidate objects.
// That is unavoidable (Win32_Process is Windows-only) and DESIRABLE (we must
// never enumerate, let alone kill, the host's real processes). Everything
// downstream of that pipe is untouched generated text: the whole
// Where-Object filter -- the `-match '--port (\d+)'` capture, the
// `[int]$Matches[1]` range bound that depends on it, the `-CreationDate`
// age bound and the `-like` owner clause -- plus the foreach /
// Write-Output "ORPHAN:..." / Stop-Process body.
//
// SAFETY: `Stop-Process` is shadowed by a no-op function in the preamble, so
// even a defect that selected a real PID could not kill anything.
// =============================================================================

/** Locate a usable PowerShell, preferring cross-platform pwsh. Returns null
 *  when the host has none -- callers must then skip with a VISIBLE reason
 *  (see POWERSHELL_SKIP), never degrade to a silent pass. */
function detectPowerShell() {
    for (const bin of ['pwsh', 'powershell.exe', 'powershell']) {
        let probe;
        try {
            probe = spawnSync(bin, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
        } catch {
            continue;
        }
        if (probe && probe.status === 0 && probe.stdout.trim()) {
            return { bin, version: probe.stdout.trim() };
        }
    }
    return null;
}

const POWERSHELL = detectPowerShell();

// Per CLAUDE.md ("a POSIX-only feature must hard-fail on Windows or gate with
// a surfaced error; an advisory warning that never blocks is a false
// success"), the degradation is a NAMED skip that node:test prints, stating
// what is missing and how to get it -- not a quietly-passing assertion.
const POWERSHELL_SKIP = POWERSHELL
    ? false
    : 'DEGRADED: no real PowerShell on PATH (tried pwsh, powershell.exe, powershell), so the generated'
      + ' win32 sweep probe cannot be EXECUTED and its process selection is unverified on this host.'
      + ' Install PowerShell 7 (`pwsh`) -- it is cross-platform -- to run this test.';

/** Quote a value as a PowerShell single-quoted literal (the same doubling
 *  rule the production psQuote uses). */
const psLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * Execute the REAL generated win32 probe against fabricated candidates and
 * return its raw stdout, for parseSweepOutput to interpret.
 *
 * @param {string} command the wrapped `powershell -EncodedCommand ...` string
 *        sweepOnce() actually built
 * @param {Array<{pid:number, cmd:string, ageSeconds?:number}>} candidates
 *        fabricated Win32_Process stand-ins; ageSeconds defaults to very old
 *        so the age bound is satisfied unless a test is exercising it
 */
function runRealWindowsSweepProbe(command, candidates) {
    assert.ok(POWERSHELL, 'runRealWindowsSweepProbe must not be called on a host with no PowerShell');
    const script = decodeWinCommand(command);
    const CIM_SOURCE = `Get-CimInstance Win32_Process -Filter "Name='dolt.exe'" -ErrorAction SilentlyContinue`;
    // Anchored on the generated text: if the probe's process source is ever
    // reworded this fails loudly here rather than silently testing nothing.
    assert.ok(
        script.includes(CIM_SOURCE),
        `the generated win32 probe no longer contains the expected Win32_Process source; update this harness.\nGot: ${script}`,
    );
    const rows = candidates
        .map((c) => `  [pscustomobject]@{ProcessId=${Number(c.pid)}; CreationDate=(Get-Date).AddSeconds(-${Number(c.ageSeconds ?? 99999)}); CommandLine=${psLiteral(c.cmd)}}`)
        .join('\n');
    const preamble = [
        '# Harness preamble -- NOT part of the generated probe.',
        'function Stop-Process { param([int]$Id, [switch]$Force, [string]$ErrorAction) Write-Output "KILLED:$Id" }',
        '$candidates = @(',
        rows,
        ')',
        '',
    ].join('\n');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-probe-'));
    const file = path.join(dir, 'probe.ps1');
    try {
        fs.writeFileSync(file, `${preamble}${script.replace(CIM_SOURCE, '$candidates')}\n`);
        const res = spawnSync(POWERSHELL.bin, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8' });
        assert.equal(
            res.status,
            0,
            `the real generated probe must run cleanly under ${POWERSHELL.bin} ${POWERSHELL.version}.\nstderr: ${res.stderr}\nstdout: ${res.stdout}`,
        );
        return res.stdout;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('the sweep only ever targets settle`s own ephemeral port range', () => {
    assert.equal(SETTLE_PORT_RANGE, DEFAULT_PORT_RANGE, 'the sweep range must be the SAME object as dolt-settle.mjs`s range, never re-derived');
    assert.equal(SETTLE_PORT_RANGE.start, 13300);
    assert.equal(SETTLE_PORT_RANGE.end, 13400);
    const win = buildSweepCommand('win32');
    assert.match(win, /^powershell -EncodedCommand [A-Za-z0-9+/=]+$/, 'win32 probe must be wrapped as an opaque powershell -EncodedCommand envelope (apra-fleet-40no)');
    const winScript = decodeWinCommand(win);
    assert.match(winScript, /-ge 13300 -and \[int\]\$Matches\[1\] -le 13399/, 'win32 probe must be an EXACT numeric range check, not a digit-prefix regex');
    assert.match(winScript, /sql-server/, 'win32 probe must only match sql-server processes');
    const posix = buildSweepCommand('posix');
    assert.match(posix, /lo=13300/);
    assert.match(posix, /hi=13399/);
    assert.match(posix, /sql-server/, 'posix probe must only match sql-server processes');
});

test('the port bound is EXACT: an operator`s own --port 1337 server is never a false positive, --port 13345 is settle residue', () => {
    // Windows: reproduce the regex-extraction + numeric-compare the generated
    // PowerShell performs, since we cannot execute PowerShell in this test env.
    const winCmdLine = (port) => `"C:\\Program Files\\Dolt\\bin\\dolt.exe" sql-server --host 127.0.0.1 --port ${port} --data-dir C:\\data`;
    const evalWinMatch = (port) => {
        const m = winCmdLine(port).match(/--port (\d+)/);
        return Boolean(m) && Number(m[1]) >= 13300 && Number(m[1]) <= 13399;
    };
    assert.equal(evalWinMatch(1337), false, 'an operator`s own --port 1337 server must NOT be flagged');
    assert.equal(evalWinMatch(13345), true, '--port 13345 IS settle residue and must be flagged');
    assert.equal(evalWinMatch(13400), false, 'a 5-digit port merely starting with the same leading digits must NOT be flagged');
    assert.equal(evalWinMatch(134001), false);
    assert.equal(evalWinMatch(13300), true);
    assert.equal(evalWinMatch(13399), true);

    // POSIX: actually run the generated awk against a fabricated `ps` line
    // for each case, exactly as the real sweep would see it.
    const psLine = (pid, etimes, port) => `${pid} ${etimes} dolt sql-server --host 127.0.0.1 --port ${port} --data-dir /home/x/data\n`;
    const runAwk = (port) => {
        const cmd = buildSweepCommand('posix', 0); // maxAgeMs=0 -> any etimes qualifies
        // Extract just the awk stage (before the pipe to tee/sed/xargs) and run
        // it directly against a fabricated ps line, to avoid depending on a
        // real `ps`/`xargs` on the test runner's machine.
        const awkStage = cmd.split(' | tee /dev/stderr')[0];
        const fullPipeline = `printf '%s' "${psLine(999, 9999, port).replace(/"/g, '\\"').trim()}" | ${awkStage.replace(/^ps -eo pid=,etimes=,args= \| /, '')}`;
        const out = execFileSync('bash', ['-c', fullPipeline], { encoding: 'utf8' });
        return out.includes('ORPHAN:999:');
    };
    if (process.platform !== 'win32') {
        assert.equal(runAwk(1337), false, 'an operator`s own --port 1337 server must NOT be flagged (awk)');
        assert.equal(runAwk(13345), true, '--port 13345 IS settle residue and must be flagged (awk)');
        assert.equal(runAwk(13400), false, 'a 5-digit port merely starting with the same leading digits must NOT be flagged (awk)');
    }
});

test('the age threshold is generous enough that a settle in progress is never interrupted', () => {
    assert.ok(DEFAULT_MAX_AGE_MS >= 10 * 60 * 1000, 'a live settle takes seconds; the cutoff must be far above that');
    assert.match(decodeWinCommand(buildSweepCommand('win32')), /AddSeconds\(-600\)/);
    assert.match(buildSweepCommand('posix'), /\$2 > 600/);
    assert.ok(DEFAULT_SWEEP_INTERVAL_MS > 0);
});

test('memberShellFamily maps registry os values onto the right shell', () => {
    assert.equal(memberShellFamily('Windows 11'), 'win32');
    assert.equal(memberShellFamily('win32'), 'win32');
    assert.equal(memberShellFamily('Ubuntu 24.04'), 'posix');
    assert.equal(memberShellFamily('darwin'), 'posix');
    assert.equal(memberShellFamily(undefined), 'posix');
});

test('parseSweepOutput extracts every killed pid with its command line as evidence', () => {
    const parsed = parseSweepOutput([
        'some unrelated line',
        'ORPHAN:4242:C:\\Users\\u\\.apra-fleet\\bin\\dolt.exe sql-server --host 127.0.0.1 --port 13301 --data-dir X',
        'ORPHAN:99:dolt sql-server --port 13399',
    ].join('\n'));
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].pid, 4242);
    assert.match(parsed[0].commandLine, /--port 13301/);
    assert.equal(parsed[1].pid, 99);
});

test('sweepOnce probes every member with its OWN shell family and reports what it killed', async () => {
    const issued = [];
    const sweep = createDoltOrphanSweep({
        logger: silent,
        listMembers: async () => ({
            members: [
                { name: 'fleet-win-dev1', os: 'Windows 11' },
                { name: 'fleet-lin-dev1', os: 'Ubuntu 24.04' },
            ],
        }),
        execCommand: async ({ member, command }) => {
            issued.push({ member, command });
            return member === 'fleet-win-dev1'
                ? { ok: true, output: 'ORPHAN:4242:dolt.exe sql-server --port 13301 --data-dir X' }
                : { ok: true, output: '' };
        },
    });

    const result = await sweep.sweepOnce();
    assert.equal(result.swept, 2);
    assert.equal(result.errors, 0);
    assert.deepEqual(result.killed, [{ member: 'fleet-win-dev1', pid: 4242, commandLine: 'dolt.exe sql-server --port 13301 --data-dir X' }]);
    assert.match(issued[0].command, /^powershell -EncodedCommand [A-Za-z0-9+/=]+$/, 'the Windows member gets an opaque -EncodedCommand envelope (apra-fleet-40no)');
    assert.match(decodeWinCommand(issued[0].command), /Get-CimInstance Win32_Process/, 'the Windows member gets the PowerShell probe');
    assert.match(issued[1].command, /ps -eo pid=,etimes=,args=/, 'the Linux member gets the POSIX probe');
});

test('a kill is logged LOUDLY -- finding anything at all means an orchestrator died mid-settle', async () => {
    const errors = [];
    const sweep = createDoltOrphanSweep({
        logger: { log: () => {}, error: (...a) => errors.push(a.join(' ')) },
        listMembers: async () => ({ members: [{ name: 'm1', os: 'linux' }] }),
        execCommand: async () => ({ ok: true, output: 'ORPHAN:7:dolt sql-server --port 13300' }),
    });
    await sweep.sweepOnce();
    assert.ok(errors.some((e) => /KILLED an orphaned ephemeral dolt sql-server on member 'm1'/.test(e)));
    assert.ok(errors.some((e) => /should be impossible/.test(e)), 'the log must say this indicates a real anomaly, not routine housekeeping');
});

test('sweepOnce never throws: a member listing failure, a probe failure and a probe throw all degrade', async () => {
    const listFailed = createDoltOrphanSweep({
        logger: silent,
        listMembers: async () => { throw new Error('fleet server unreachable'); },
        execCommand: async () => ({ ok: true, output: '' }),
    });
    assert.deepEqual(await listFailed.sweepOnce(), { swept: 0, killed: [], errors: 1 });

    const probeFailed = createDoltOrphanSweep({
        logger: silent,
        listMembers: async () => ({ members: [{ name: 'm1' }, { name: 'm2' }] }),
        execCommand: async ({ member }) => {
            if (member === 'm1') return { ok: false, error: 'ssh timeout' };
            throw new Error('transport exploded');
        },
    });
    const res = await probeFailed.sweepOnce();
    assert.equal(res.errors, 2);
    assert.deepEqual(res.killed, []);
});

test('start()/stop() drive an unref-ed interval and skip a tick while a pass is still in flight', async () => {
    const timers = [];
    let cleared = 0;
    let passes = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    const sweep = createDoltOrphanSweep({
        logger: silent,
        intervalMs: 1000,
        listMembers: async () => { passes += 1; await gate; return { members: [] }; },
        execCommand: async () => ({ ok: true, output: '' }),
        setInterval: (fn, ms) => { const t = { fn, ms, unref() { t.unrefed = true; } }; timers.push(t); return t; },
        clearInterval: () => { cleared += 1; },
    });

    sweep.start();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 1000);
    assert.equal(timers[0].unrefed, true, 'the sweep timer must never keep the supervisor process alive');

    sweep.start();
    assert.equal(timers.length, 1, 'start() is idempotent');

    timers[0].fn();
    await new Promise((r) => setImmediate(r));
    assert.equal(passes, 1);
    timers[0].fn(); // still in flight -> skipped, not stacked
    await new Promise((r) => setImmediate(r));
    assert.equal(passes, 1, 'a tick while the previous pass is still walking members is skipped, never stacked');

    release();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    timers[0].fn();
    await new Promise((r) => setImmediate(r));
    assert.equal(passes, 2, 'once the in-flight pass finishes, later ticks run again');

    sweep.stop();
    assert.equal(cleared, 1);
    sweep.stop();
    assert.equal(cleared, 1, 'stop() is idempotent');
});

test('the supervisor starts and stops the sweep as a first-class seam', async () => {
    const { createSupervisor } = await import('../src/supervisor/server.mjs');
    const events = [];
    const seam = { name: 'doltOrphanSweep', start: () => { events.push('start'); }, stop: () => { events.push('stop'); } };
    const supervisor = createSupervisor({ port: 0, doltOrphanSweep: seam, logger: silent });
    await supervisor.start();
    await supervisor.stop('test');
    assert.deepEqual(events, ['start', 'stop'], 'the sweep seam must be started with the supervisor and stopped with it');
});

// =============================================================================
// apra-fleet-5co8.33: owner scope -- the sweep must never kill an ephemeral
// dolt sql-server belonging to a DIFFERENT supervisor instance on the same
// machine. Opt-in via ownerDataDirPrefix (bin/serve.mjs wires it from
// FLEET_SE_SWEEP_OWNER_DATA_DIR); unset, behaviour is machine-wide as before.
// =============================================================================

test('the owner constraint appears in BOTH shell families when a prefix is given, and in neither when it is not', () => {
    const winScoped = decodeWinCommand(buildSweepCommand('win32', DEFAULT_MAX_AGE_MS, 'C:\\sandbox\\run1'));
    assert.match(winScoped, /-like '\*--data-dir\*C:\\sandbox\\run1\*'/, 'win32 probe must carry the owner data-dir constraint');
    assert.doesNotMatch(winScoped, /CommandLine -match '[^']*sandbox/, 'the owner constraint must NOT be a regex operator -- it would clobber $Matches, which the port bound reads');
    assert.match(winScoped, /-ge 13300 -and \[int\]\$Matches\[1\] -le 13399/, 'the exact numeric port bound is unchanged by the owner constraint');

    const posixScoped = buildSweepCommand('posix', DEFAULT_MAX_AGE_MS, '/tmp/sandbox/run1');
    assert.match(posixScoped, /-v owner='\/tmp\/sandbox\/run1'/, 'posix probe must pass the owner prefix via awk -v, never spliced into the program');
    assert.match(posixScoped, /index\(\$0, owner\) > 0/, 'posix probe must use a LITERAL substring test, not a regex');
    assert.match(posixScoped, /lo=13300/);
    assert.match(posixScoped, /hi=13399/);

    // Unscoped (production default) is byte-identical to the pre-fix command.
    assert.doesNotMatch(decodeWinCommand(buildSweepCommand('win32')), /--data-dir/);
    assert.doesNotMatch(buildSweepCommand('posix'), /owner/);
});

test('a foreign-data-dir server is excluded while a same-owner one is still killed', () => {
    const OWNER_WIN = 'C:\\Users\\u\\sandbox-run1';
    const OWNER_POSIX = '/tmp/sandbox-run1';

    // Windows: reproduce the -like semantics the generated PowerShell applies
    // (case-insensitive, literal, wildcards only where we put them), since
    // PowerShell cannot be executed in this test env.
    const winScript = decodeWinCommand(buildSweepCommand('win32', DEFAULT_MAX_AGE_MS, OWNER_WIN));
    const likePattern = winScript.match(/-like '(\*--data-dir\*.*?\*)'/)[1];
    const likeRe = new RegExp(`^${likePattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'is');
    const winCmdLine = (dataDir) => `"C:\\dolt.exe" sql-server --host 127.0.0.1 --port 13345 --data-dir "${dataDir}"`;
    assert.equal(likeRe.test(winCmdLine('C:\\Users\\u\\sandbox-run1\\.beads\\embeddeddolt')), true, 'this instance`s own server must still be killed');
    assert.equal(likeRe.test(winCmdLine('C:\\Users\\u\\OTHER-supervisor\\.beads\\embeddeddolt')), false, 'another supervisor instance`s server must NOT be killed');
    assert.equal(likeRe.test(winCmdLine('.beads\\embeddeddolt')), false, 'the relative-data-dir fallback carries no owner marker -- excluded (fail-safe)');

    // POSIX: actually run the generated awk against fabricated `ps` lines.
    if (process.platform !== 'win32') {
        const runAwk = (dataDir) => {
            const cmd = buildSweepCommand('posix', 0, OWNER_POSIX);
            const awkStage = cmd.split(' | tee /dev/stderr')[0].replace(/^ps -eo pid=,etimes=,args= \| /, '');
            const psLine = `999 9999 dolt sql-server --host 127.0.0.1 --port 13345 --data-dir ${dataDir}`;
            const out = execFileSync('bash', ['-c', `printf '%s' "${psLine}" | ${awkStage}`], { encoding: 'utf8' });
            return out.includes('ORPHAN:999:');
        };
        assert.equal(runAwk('/tmp/sandbox-run1/.beads/embeddeddolt'), true, 'this instance`s own server must still be killed (awk)');
        assert.equal(runAwk('/tmp/OTHER-supervisor/.beads/embeddeddolt'), false, 'another supervisor instance`s server must NOT be killed (awk)');
        assert.equal(runAwk('.beads/embeddeddolt'), false, 'the relative-data-dir fallback is excluded (awk, fail-safe)');
    }
});

test('normalizeMsysPathForPlatform converts an MSYS path to native Windows form on win32, and is a no-op elsewhere', () => {
    // apra-fleet-5co8.36: path.resolve('/c/Users/x/temp') on win32 used to
    // yield the nonexistent 'C:\c\Users\x\temp' -- reproduce that exact
    // mangling risk and prove the normalizer neutralizes it BEFORE resolve.
    assert.equal(normalizeMsysPathForPlatform('/c/Users/x/temp/.apra-fleet-tests', 'win32'), 'C:\\Users\\x\\temp\\.apra-fleet-tests');
    assert.equal(normalizeMsysPathForPlatform('/d/some/other/root', 'win32'), 'D:\\some\\other\\root');

    // Already-native Windows forms pass through unchanged (nothing to fix).
    assert.equal(normalizeMsysPathForPlatform('C:\\Users\\x\\temp', 'win32'), 'C:\\Users\\x\\temp');
    assert.equal(normalizeMsysPathForPlatform('C:/Users/x/temp', 'win32'), 'C:/Users/x/temp');

    // Non-win32 platforms never touch the value -- POSIX paths are correct
    // as-is on posix, and path.resolve() there has no drive-mangling bug.
    assert.equal(normalizeMsysPathForPlatform('/c/Users/x/temp', 'linux'), '/c/Users/x/temp');
    assert.equal(normalizeMsysPathForPlatform('/tmp/sandbox', 'darwin'), '/tmp/sandbox');

    // Empty/nullish input never throws.
    assert.equal(normalizeMsysPathForPlatform('', 'win32'), '');
    assert.equal(normalizeMsysPathForPlatform(null, 'win32'), '');
});

test('sweepOnce propagates the owner prefix into every member`s probe', async () => {
    const issued = [];
    const sweep = createDoltOrphanSweep({
        logger: silent,
        ownerDataDirPrefix: '  /tmp/sandbox-run1  ',
        listMembers: async () => ({ members: [{ name: 'w', os: 'Windows 11' }, { name: 'l', os: 'linux' }] }),
        execCommand: async ({ member, command }) => { issued.push({ member, command }); return { ok: true, output: '' }; },
    });
    assert.equal(sweep.ownerDataDirPrefix, '/tmp/sandbox-run1', 'the prefix is trimmed once at construction');
    await sweep.sweepOnce();
    assert.match(decodeWinCommand(issued[0].command), /-like '\*--data-dir\*\/tmp\/sandbox-run1\*'/);
    assert.match(issued[1].command, /-v owner='\/tmp\/sandbox-run1'/);

    const unscoped = createDoltOrphanSweep({
        logger: silent,
        listMembers: async () => ({ members: [{ name: 'l', os: 'linux' }] }),
        execCommand: async () => ({ ok: true, output: '' }),
    });
    assert.equal(unscoped.ownerDataDirPrefix, null, 'unset (production default) stays machine-wide');
});

// =============================================================================
// apra-fleet-5co8.35: pin the cross-instance kill hazard at the sweepOnce()
// seam, not just at buildSweepCommand()'s string level. The owner filter is
// enforced entirely INSIDE the generated shell command (JS never post-filters
// execCommand's result -- see sweepOnce()'s loop above), so a seam-level test
// must actually execute the REAL command createDoltOrphanSweep built (via the
// stub execCommand) against fabricated candidates from BOTH scopes, then
// assert on sweepOnce()'s own `killed` result. A test that only inspects the
// command string (like the tests above) cannot catch a regression where the
// owner clause is generated correctly but silently dropped/ignored before
// reaching sweepOnce()'s result.
//
// REGRESSION GUARD (confirmed by hand): with the owner argument stripped from
// the `buildSweepCommand(family, maxAgeMs, owner)` call inside sweepOnce()
// (i.e. reverting apra-fleet-5co8.33 back to the machine-wide probe), both
// tests below fail -- the posix one reports 2 killed instead of 1, and the
// win32 one throws on the missing -like clause assertion.
// =============================================================================

test('sweepOnce (posix), driven by the REAL generated+executed probe, kills only the in-scope process', { skip: process.platform === 'win32' ? 'requires a real bash/awk to execute the generated posix probe' : false }, async () => {
    const OWNER = '/tmp/sandbox-run1';
    const inScopeCmdLine = `dolt sql-server --host 127.0.0.1 --port 13345 --data-dir ${OWNER}/.beads/embeddeddolt`;
    const outOfScopeCmdLine = 'dolt sql-server --host 127.0.0.1 --port 13346 --data-dir /tmp/OTHER-supervisor/.beads/embeddeddolt';
    const escape = (value) => value.replace(/"/g, '\\"');

    const sweep = createDoltOrphanSweep({
        logger: silent,
        ownerDataDirPrefix: OWNER,
        listMembers: async () => ({ members: [{ name: 'm1', os: 'linux' }] }),
        execCommand: async ({ command }) => {
            // Run the ACTUAL probe sweepOnce() just built (the same `command`
            // it would hand to a real member's shell) against two fabricated
            // `ps` lines -- one in-scope, one from a different supervisor
            // instance's data dir -- so this proves the real filtering logic,
            // not a re-derivation of it.
            const awkStage = command.split(' | tee /dev/stderr')[0].replace(/^ps -eo pid=,etimes=,args= \| /, '');
            const psLine1 = `111 99999 ${inScopeCmdLine}`;
            const psLine2 = `222 99999 ${outOfScopeCmdLine}`;
            const pipeline = `printf '%s\\n%s\\n' "${escape(psLine1)}" "${escape(psLine2)}" | ${awkStage}`;
            const out = execFileSync('bash', ['-c', pipeline], { encoding: 'utf8' });
            return { ok: true, output: out };
        },
    });

    const result = await sweep.sweepOnce();
    assert.equal(result.killed.length, 1, 'only the in-scope process must be reported killed, not the other supervisor instance`s process');
    assert.equal(result.killed[0].pid, 111);
    assert.match(result.killed[0].commandLine, /sandbox-run1/);
});

test(
    'sweepOnce (win32), driven by the REAL generated probe EXECUTED in real PowerShell, kills only the in-scope process',
    { skip: POWERSHELL_SKIP },
    async () => {
        const OWNER_WIN = 'C:\\Users\\u\\sandbox-run1';
        const inScopeCmdLine = 'C:\\dolt.exe sql-server --host 127.0.0.1 --port 13345 --data-dir C:\\Users\\u\\sandbox-run1\\.beads\\embeddeddolt';
        const outOfScopeCmdLine = 'C:\\dolt.exe sql-server --host 127.0.0.1 --port 13346 --data-dir C:\\Users\\u\\OTHER-supervisor\\.beads\\embeddeddolt';
        // Two more candidates the JS re-implementation could never have
        // exercised, because it only ever applied the -like clause: an
        // out-of-range port and a too-young process. Both are rejected by
        // OTHER clauses of the same real Where-Object filter, which also
        // proves the `-match '--port (\d+)'` capture and the `[int]$Matches[1]`
        // bound that reads it still interoperate after the -like clause was
        // appended (the exact hazard buildSweepCommand's comment names).
        const outOfRangePortCmdLine = 'C:\\dolt.exe sql-server --host 127.0.0.1 --port 1337 --data-dir C:\\Users\\u\\sandbox-run1\\.beads\\embeddeddolt';
        const tooYoungCmdLine = 'C:\\dolt.exe sql-server --host 127.0.0.1 --port 13350 --data-dir C:\\Users\\u\\sandbox-run1\\.beads\\embeddeddolt';

        let probeRan = false;
        const sweep = createDoltOrphanSweep({
            logger: silent,
            ownerDataDirPrefix: OWNER_WIN,
            listMembers: async () => ({ members: [{ name: 'w1', os: 'Windows 11' }] }),
            execCommand: async ({ command }) => {
                probeRan = true;
                const output = runRealWindowsSweepProbe(command, [
                    { pid: 111, cmd: inScopeCmdLine },
                    { pid: 222, cmd: outOfScopeCmdLine },
                    { pid: 333, cmd: outOfRangePortCmdLine },
                    { pid: 444, cmd: tooYoungCmdLine, ageSeconds: 0 },
                ]);
                return { ok: true, output };
            },
        });

        const result = await sweep.sweepOnce();
        assert.ok(probeRan, 'the sweep must actually have issued a command for the win32 member');
        assert.equal(
            result.killed.length,
            1,
            `only the in-scope, in-range, old-enough process may be killed; real PowerShell (${POWERSHELL.bin} ${POWERSHELL.version}) selected: ${JSON.stringify(result.killed)}`,
        );
        assert.equal(result.killed[0].pid, 111);
        assert.match(result.killed[0].commandLine, /sandbox-run1/);
    },
);

test(
    'the REAL generated win32 probe survives an owner path containing a quote and a space (a quoting defect would select the wrong set)',
    { skip: POWERSHELL_SKIP },
    async () => {
        // The old typeof/regex-rebuild assertions could not see a quoting
        // defect at all. Run a path that is hostile to BOTH the PowerShell
        // single-quoted literal (embedded apostrophe) and to naive splitting
        // (embedded spaces) through the real parser, end to end.
        const OWNER_WIN = "C:\\Users\\O'Brien\\My Sandbox\\run1";
        const inScope = `C:\\dolt.exe sql-server --host 127.0.0.1 --port 13345 --data-dir ${OWNER_WIN}\\.beads\\embeddeddolt`;
        const otherOwner = "C:\\dolt.exe sql-server --host 127.0.0.1 --port 13346 --data-dir C:\\Users\\O'Brien\\My Sandbox\\run2\\.beads\\embeddeddolt";

        const sweep = createDoltOrphanSweep({
            logger: silent,
            ownerDataDirPrefix: OWNER_WIN,
            listMembers: async () => ({ members: [{ name: 'w1', os: 'Windows 11' }] }),
            execCommand: async ({ command }) => ({
                ok: true,
                output: runRealWindowsSweepProbe(command, [
                    { pid: 111, cmd: inScope },
                    { pid: 222, cmd: otherOwner },
                ]),
            }),
        });

        const result = await sweep.sweepOnce();
        assert.equal(result.killed.length, 1, `a quote/space in the owner path must not widen or void the selection, got: ${JSON.stringify(result.killed)}`);
        assert.equal(result.killed[0].pid, 111, 'the sibling run2 sandbox under the same quoted parent must NOT be selected');
    },
);

// =============================================================================
// apra-fleet-5co8.42: dolt-orphan-sweep's file-header KNOWN LIMIT says that
// when dolt-settle.mjs's resolveDoltStatus falls back to its unknown-mode
// parse, the spawned `dolt sql-server` command line carries a RELATIVE
// --data-dir, so an owner prefix (an absolute path) can never match it and
// an owner-scoped sweep silently selects nothing for that member. The
// direction is FAIL-SAFE: a miss here means the sweep kills nothing for that
// candidate, never that it kills a foreign process by accident (the owner
// clause can only narrow the -like/awk match, never widen it to something
// unrelated). These tests pin that documented limit at the sweepOnce() seam
// -- executing the REAL generated probe (the same one the tests above use),
// not a re-derivation of the matching logic -- so a future change cannot
// silently turn "misses nothing" into "kills a foreign process".
// =============================================================================

test('sweepOnce (posix): a RELATIVE --data-dir candidate is excluded (fail-safe miss), while the SAME owner`s absolute --data-dir candidate is still selected', { skip: process.platform === 'win32' ? 'requires a real bash/awk to execute the generated posix probe' : false }, async () => {
    const OWNER = '/tmp/sandbox-run1';
    // Known-limit case: resolveDoltStatus's unknown-mode fallback emits a
    // bare relative default with no owner marker at all.
    const relativeCmdLine = 'dolt sql-server --host 127.0.0.1 --port 13345 --data-dir .beads/embeddeddolt';
    // Sibling case, same owner, absolute --data-dir: proves the miss above
    // is the documented relative-path limit, not a dead/broken code path.
    const absoluteCmdLine = `dolt sql-server --host 127.0.0.1 --port 13346 --data-dir ${OWNER}/.beads/embeddeddolt`;

    const sweep = createDoltOrphanSweep({
        logger: silent,
        ownerDataDirPrefix: OWNER,
        listMembers: async () => ({ members: [{ name: 'm1', os: 'linux' }] }),
        execCommand: async ({ command }) => {
            const awkStage = command.split(' | tee /dev/stderr')[0].replace(/^ps -eo pid=,etimes=,args= \| /, '');
            const psLine1 = `111 99999 ${relativeCmdLine}`;
            const psLine2 = `222 99999 ${absoluteCmdLine}`;
            const pipeline = `printf '%s\n%s\n' "${psLine1}" "${psLine2}" | ${awkStage}`;
            const out = execFileSync('bash', ['-c', pipeline], { encoding: 'utf8' });
            return { ok: true, output: out };
        },
    });

    const result = await sweep.sweepOnce();
    // FAIL-SAFE assertion: the relative-data-dir candidate (pid 111) must be
    // MISSING from `killed` -- a miss, meaning nothing is touched for it --
    // never present under a mismatched identity (which would mean some
    // OTHER process got killed instead).
    assert.equal(result.killed.length, 1, 'only the absolute-data-dir, same-owner candidate is selected; the relative-data-dir candidate is a fail-safe miss, not a kill of something else');
    assert.equal(result.killed[0].pid, 222, 'the relative-data-dir candidate (pid 111) must never appear here');
    assert.match(result.killed[0].commandLine, /sandbox-run1/);
});

test(
    'sweepOnce (win32), in real PowerShell: a RELATIVE --data-dir candidate is excluded (fail-safe miss), while the SAME owner`s absolute --data-dir candidate is still selected',
    { skip: POWERSHELL_SKIP },
    async () => {
        const OWNER_WIN = String.raw`C:\Users\u\sandbox-run1`;
        const relativeCmdLine = String.raw`"C:\dolt.exe" sql-server --host 127.0.0.1 --port 13345 --data-dir .beads\embeddeddolt`;
        const absoluteCmdLine = String.raw`"C:\dolt.exe" sql-server --host 127.0.0.1 --port 13346 --data-dir ${OWNER_WIN}\.beads\embeddeddolt`;

        const sweep = createDoltOrphanSweep({
            logger: silent,
            ownerDataDirPrefix: OWNER_WIN,
            listMembers: async () => ({ members: [{ name: 'w1', os: 'Windows 11' }] }),
            execCommand: async ({ command }) => ({
                ok: true,
                output: runRealWindowsSweepProbe(command, [
                    { pid: 111, cmd: relativeCmdLine },
                    { pid: 222, cmd: absoluteCmdLine },
                ]),
            }),
        });

        const result = await sweep.sweepOnce();
        assert.equal(result.killed.length, 1, 'only the absolute-data-dir, same-owner candidate is selected; the relative-data-dir candidate is a fail-safe miss, not a kill of something else');
        assert.equal(result.killed[0].pid, 222, 'the relative-data-dir candidate (pid 111) must never appear here');
        assert.match(result.killed[0].commandLine, /sandbox-run1/);
    },
);
