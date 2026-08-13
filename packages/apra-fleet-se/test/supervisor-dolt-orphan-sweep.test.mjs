import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('the sweep only ever targets settle`s own ephemeral port range', () => {
    assert.equal(SETTLE_PORT_RANGE.start, DEFAULT_PORT_RANGE.start, 'the sweep range must track dolt-settle.mjs`s range');
    assert.equal(SETTLE_PORT_RANGE.end, DEFAULT_PORT_RANGE.end);
    for (const family of ['win32', 'posix']) {
        const cmd = buildSweepCommand(family);
        assert.match(cmd, /--port 13\[3-9\]\[0-9\]/, `${family} probe must be scoped to the 133xx-139xx settle range`);
        assert.match(cmd, /sql-server/, `${family} probe must only match sql-server processes`);
    }
});

test('the age threshold is generous enough that a settle in progress is never interrupted', () => {
    assert.ok(DEFAULT_MAX_AGE_MS >= 10 * 60 * 1000, 'a live settle takes seconds; the cutoff must be far above that');
    assert.match(buildSweepCommand('win32'), /AddSeconds\(-600\)/);
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
    assert.match(issued[0].command, /Get-CimInstance Win32_Process/, 'the Windows member gets the PowerShell probe');
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
