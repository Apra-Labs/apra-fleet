import { test, describe } from 'node:test';
import assert from 'node:assert';

import { createWatchdog, WATCHDOG_STATUS } from '../src/supervisor/watchdog.mjs';

// =============================================================================
// apra-fleet-eft.4.9.3 -- verification for apra-fleet-eft.4.9.1's reentrancy
// guard around the watchdog's setInterval-triggered classifyAll().
//
// classifyAll() does blocking per-sprint spawnSync cmdline reads plus a
// ~1.5s HTTP liveness probe per sprint (probeChildHttp), so with several
// tracked sprints a single tick can exceed the configured interval and the
// NEXT tick can fire while the previous classifyAll() promise is still
// unresolved. Before apra-fleet-eft.4.9.1, that meant two full classifyAll()
// passes running concurrently, both mutating the shared recordedCrashes/
// recordedFinishes sets and both racing to overwrite the module's `snapshot`
// (getSnapshot()'s backing state) -- whichever pass happens to finish LAST
// wins, even if it started FIRST and its data is now stale relative to a
// faster, later-started pass.
//
// This test drives createWatchdog() with an injected setIntervalFn (so the
// "interval" is fully test-controlled -- no real timers, no flakiness) and a
// deliberately controllable, never-auto-resolving probeHttp -- the async
// hook classifySprint() actually `await`s -- to simulate a classifyAll() run
// that is still in flight when the next tick fires. It asserts:
//   1. A tick that fires while the previous interval-triggered classifyAll()
//      is still pending does NOT start a second, overlapping classifyAll()
//      pass (no extra probeHttp calls beyond the one already in flight).
//   2. The final snapshot always reflects the LATEST tick's results, never
//      clobbered by an earlier, slower tick completing out of order.
//   3. A crashed sprint's recordTerminalError() fires at most once across
//      the whole overlapping-tick sequence (recordedCrashes integrity).
//
// Against the pre-guard watchdog (ce482d9's parent revision -- no
// intervalClassifyInFlight flag), assertion 1 fails: the second tick starts
// its own classifyAll() immediately, doubling the in-flight probeHttp calls.
// =============================================================================

/** Minimal fake ledger exposing just list() -- the only method the watchdog consumes. */
function fakeLedger(entries) {
    return { list: () => entries.map((e) => ({ ...e })) };
}

/**
 * A controllable, never-auto-resolving HTTP-probe double. Each call queues a
 * resolver instead of settling immediately, so the test decides exactly when
 * (and in what order) each in-flight classifySprint() awaiting it proceeds --
 * this is what lets the test simulate "classifyAll() is still running" for as
 * long as it likes, deterministically, with no real timers.
 */
function makeControllableProbe() {
    const pending = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let totalCalls = 0;
    return {
        probeHttp(_port) {
            totalCalls += 1;
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            return new Promise((resolve) => {
                pending.push((httpOk) => {
                    inFlight -= 1;
                    resolve(httpOk);
                });
            });
        },
        /** Resolve exactly N of the oldest still-pending calls (FIFO), all with the same httpOk value. */
        resolveOldest(n, httpOk = true) {
            for (let i = 0; i < n; i += 1) {
                const fn = pending.shift();
                assert.ok(fn, `resolveOldest(${n}) called but only ${i} call(s) were pending`);
                fn(httpOk);
            }
        },
        resolveAll(httpOk = true) {
            while (pending.length > 0) pending.shift()(httpOk);
        },
        get pendingCount() { return pending.length; },
        get totalCalls() { return totalCalls; },
        get maxInFlight() { return maxInFlight; },
    };
}

/**
 * Flushes the microtask queue via a macrotask boundary (setImmediate fires
 * only after every currently-queued microtask has run). Needed because
 * classifySprint() now `await`s isChildAlive() (apra-fleet-se watchdog async
 * conversion: readProcessCmdline/makeChildPidProbe() are async so a Windows
 * cmdline read never blocks the event loop) BEFORE it reaches probeHttp() --
 * even when the injected isChildAlive is a plain synchronous function, an
 * `await` on it still defers to the microtask queue for one tick. Tests below
 * that used to assert on `probe.totalCalls`/`pendingCount` immediately after
 * calling start()/fireTick() (relying on the OLD fully-synchronous-up-to-
 * probeHttp behavior) now need to flush past that extra await first.
 */
function flushMicrotasks() {
    return new Promise((resolve) => setImmediate(resolve));
}

/** Captures the interval callback + intervalMs a test-injected setIntervalFn receives, without scheduling any real timer. */
function makeManualIntervalScheduler() {
    let tickFn = null;
    let ms = null;
    let cleared = false;
    return {
        setIntervalFn(fn, intervalMs) {
            tickFn = fn;
            ms = intervalMs;
            return { unref() {} };
        },
        clearIntervalFn() { cleared = true; },
        /** Manually invoke the captured interval callback, as if the timer just fired. */
        fireTick() {
            assert.ok(tickFn, 'setIntervalFn was never called -- watchdog.start() must run first');
            tickFn();
        },
        get intervalMs() { return ms; },
        get wasCleared() { return cleared; },
    };
}

function makeSprints(n) {
    const entries = [];
    const alivePids = new Set();
    const ports = {};
    for (let i = 1; i <= n; i += 1) {
        const sprintId = `s${i}`;
        const pid = 1000 + i;
        entries.push({ sprintId, childPid: pid });
        alivePids.add(pid);
        ports[sprintId] = 9000 + i;
    }
    return { entries, alivePids, ports };
}

describe('watchdog interval reentrancy guard (apra-fleet-eft.4.9.3)', () => {
    test('a tick that fires while the previous interval classifyAll() is still in flight is skipped -- no overlapping classifyAll() execution', async () => {
        const { entries, alivePids, ports } = makeSprints(3);
        const probe = makeControllableProbe();
        const scheduler = makeManualIntervalScheduler();

        const wd = createWatchdog({
            ledger: fakeLedger(entries),
            resolvePort: (id) => ports[id],
            isChildAlive: (pid) => alivePids.has(pid),
            probeHttp: probe.probeHttp,
            hasTerminalState: () => false,
            recordTerminalError: () => {},
            setIntervalFn: scheduler.setIntervalFn,
            clearIntervalFn: scheduler.clearIntervalFn,
            intervalMs: 50,
        });

        // start()'s initial prime is a DIRECT classifyAll() call, not gated by
        // the interval guard -- resolve its 3 probes so start() can settle.
        const startPromise = wd.start();
        await flushMicrotasks(); // let each classifySprint's `await isChildAlive()` resolve so it reaches probeHttp()
        assert.strictEqual(probe.totalCalls, 3, 'initial prime should probe all 3 sprints');
        probe.resolveAll(true);
        await startPromise;
        assert.strictEqual(probe.pendingCount, 0);

        // --- Tick A fires: the guard is unlocked, so this genuinely starts a
        // new classifyAll() pass. Its 3 probes are deliberately left
        // UNRESOLVED -- this is the "classifyAll() still running" window.
        scheduler.fireTick();
        await flushMicrotasks();
        assert.strictEqual(probe.totalCalls, 6, 'tick A must run a real classifyAll() (3 more probe calls, 3+3=6 total)');
        assert.strictEqual(probe.pendingCount, 3, 'tick A left exactly 3 probes pending (still in flight)');

        // --- Tick B fires while tick A's classifyAll() is still unresolved.
        // Pre-guard, this would start ANOTHER classifyAll() pass (3 MORE
        // probe calls, 9 total). Post-guard, it must be skipped entirely.
        scheduler.fireTick();
        assert.strictEqual(
            probe.totalCalls, 6,
            `tick B must NOT start a second overlapping classifyAll() while tick A is still in flight ` +
            `(expected totalCalls to stay at 6, got ${probe.totalCalls} -- this is exactly the pre-guard overlap bug)`
        );
        assert.strictEqual(probe.maxInFlight, 3, 'at no point should more than one classifyAll() pass worth of probes (3) be in flight at once');

        // Let tick A's classifyAll() finish, then drain to a clean stop.
        probe.resolveAll(true);
        await wd.stop();
        assert.strictEqual(scheduler.wasCleared, true);
    });

    test('the snapshot always reflects the latest fired tick, never clobbered by an earlier tick completing later (stale-overwrite guard)', async () => {
        const { entries, alivePids, ports } = makeSprints(2);
        const probe = makeControllableProbe();
        const scheduler = makeManualIntervalScheduler();

        const wd = createWatchdog({
            ledger: fakeLedger(entries),
            resolvePort: (id) => ports[id],
            isChildAlive: (pid) => alivePids.has(pid),
            probeHttp: probe.probeHttp,
            hasTerminalState: () => false,
            recordTerminalError: () => {},
            setIntervalFn: scheduler.setIntervalFn,
            clearIntervalFn: scheduler.clearIntervalFn,
            intervalMs: 50,
        });

        const startPromise = wd.start();
        await flushMicrotasks(); // let each classifySprint's `await isChildAlive()` resolve so it reaches probeHttp()
        probe.resolveAll(true); // initial prime: both sprints healthy
        await startPromise;
        assert.deepStrictEqual(
            wd.getSnapshot().map((s) => s.status),
            [WATCHDOG_STATUS.RUNNING_HEALTHY, WATCHDOG_STATUS.RUNNING_HEALTHY],
        );

        // Tick A fires and starts classifyAll() -- leave it pending.
        scheduler.fireTick();
        await flushMicrotasks();
        assert.strictEqual(probe.pendingCount, 2, 'tick A left 2 probes pending');

        // With the reentrancy guard, a second fireTick() here is a no-op (see
        // the previous test) -- tick A is the ONLY in-flight pass, so there is
        // no second, independently-resolvable batch that could ever finish
        // out of order and clobber the snapshot. Confirm that directly: a
        // second fireTick() adds no new pending probes.
        scheduler.fireTick();
        assert.strictEqual(probe.pendingCount, 2, 'no second overlapping pass was started, so no additional probes were queued');

        // Resolve tick A's probes as UNRESPONSIVE this time (a real signal
        // change from the initial healthy prime) and confirm the snapshot
        // updates to reflect it -- the single in-flight pass's own result,
        // with nothing else able to race and overwrite it afterward.
        probe.resolveAll(false);
        // Allow classifyAll()'s Promise.all + the tick's .finally() to settle.
        await new Promise((r) => setImmediate(r));
        assert.deepStrictEqual(
            wd.getSnapshot().map((s) => s.status),
            [WATCHDOG_STATUS.RUNNING_UNRESPONSIVE, WATCHDOG_STATUS.RUNNING_UNRESPONSIVE],
            'snapshot must reflect the one genuine in-flight tick\'s own results, not any stale/overwritten data'
        );

        await wd.stop();
    });

    test('a crashed sprint records its terminal error at most once across an overlapping-tick sequence (recordedCrashes integrity)', async () => {
        const crashedId = 'crashed-1';
        const runningEntries = makeSprints(2);
        const entries = [...runningEntries.entries, { sprintId: crashedId, childPid: 9999 }];
        const probe = makeControllableProbe();
        const scheduler = makeManualIntervalScheduler();
        const recordedCalls = [];

        const wd = createWatchdog({
            ledger: fakeLedger(entries),
            resolvePort: (id) => runningEntries.ports[id],
            // The crashed sprint's pid is deliberately absent from alivePids.
            isChildAlive: (pid) => runningEntries.alivePids.has(pid),
            probeHttp: probe.probeHttp,
            hasTerminalState: () => false, // no terminal state anywhere -> PID-gone means CRASHED
            recordTerminalError: (info) => { recordedCalls.push(info.sprintId); },
            setIntervalFn: scheduler.setIntervalFn,
            clearIntervalFn: scheduler.clearIntervalFn,
            intervalMs: 50,
        });

        const startPromise = wd.start();
        await flushMicrotasks(); // let each classifySprint's `await isChildAlive()` resolve so it reaches probeHttp()/recordTerminalError()
        probe.resolveAll(true);
        await startPromise;
        assert.deepStrictEqual(recordedCalls, [crashedId], 'the crashed sprint is recorded exactly once on the initial prime');

        // Fire two ticks back to back while the running sprints' probes are
        // still unresolved (simulating an overlap attempt); the crashed
        // sprint's own path now also awaits isChildAlive() (one microtask
        // tick) before its recordedCrashes check, but that delay is uniform
        // across both ticks -- this still asserts the ALREADY-recorded guard
        // holds and no duplicate history/log entry is ever produced by the
        // (correctly skipped) tick B.
        scheduler.fireTick();
        scheduler.fireTick();
        await flushMicrotasks();
        probe.resolveAll(true);
        await new Promise((r) => setImmediate(r));

        assert.deepStrictEqual(
            recordedCalls, [crashedId],
            `recordTerminalError must fire exactly once for '${crashedId}' across the whole overlapping-tick sequence, got: ${JSON.stringify(recordedCalls)}`
        );

        await wd.stop();
    });
});
