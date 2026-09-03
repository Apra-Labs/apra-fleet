import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
    createDoltOrphanSweep,
    buildSweepCommand,
    parseSweepOutput,
    memberShellFamily,
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

test('sweepOnce (win32), applying the ACTUAL generated -like clause, kills only the in-scope process', async () => {
    const OWNER_WIN = 'C:\\Users\\u\\sandbox-run1';
    const inScopeCmdLine = 'C:\\dolt.exe sql-server --host 127.0.0.1 --port 13345 --data-dir C:\\Users\\u\\sandbox-run1\\.beads\\embeddeddolt';
    const outOfScopeCmdLine = 'C:\\dolt.exe sql-server --host 127.0.0.1 --port 13346 --data-dir C:\\Users\\u\\OTHER-supervisor\\.beads\\embeddeddolt';

    const sweep = createDoltOrphanSweep({
        logger: silent,
        ownerDataDirPrefix: OWNER_WIN,
        listMembers: async () => ({ members: [{ name: 'w1', os: 'Windows 11' }] }),
        execCommand: async ({ command }) => {
            // Extract the REAL -like clause sweepOnce() just generated (PowerShell
            // itself cannot run in this test env) and apply its ACTUAL semantics
            // -- not a re-derivation -- to two fabricated candidate command lines.
            const winScript = decodeWinCommand(command);
            const likeMatch = winScript.match(/-like '(\*--data-dir\*.*?\*)'/);
            assert.ok(likeMatch, 'the real generated command must carry the owner -like clause');
            const likeRe = new RegExp(`^${likeMatch[1].split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'is');
            const candidates = [
                { pid: 111, cmd: inScopeCmdLine },
                { pid: 222, cmd: outOfScopeCmdLine },
            ];
            const output = candidates
                .filter((c) => likeRe.test(c.cmd))
                .map((c) => `ORPHAN:${c.pid}:${c.cmd}`)
                .join('\n');
            return { ok: true, output };
        },
    });

    const result = await sweep.sweepOnce();
    assert.equal(result.killed.length, 1, 'only the in-scope process must be reported killed, not the other supervisor instance`s process');
    assert.equal(result.killed[0].pid, 111);
    assert.match(result.killed[0].commandLine, /sandbox-run1/);
});
