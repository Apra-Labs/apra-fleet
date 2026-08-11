import { test, describe } from 'node:test';
import assert from 'node:assert';
import { FleetWorkflow, CancelledError } from '../src/workflow/index.mjs';

// (apra-fleet-p2to.1.1) Unit tests for the cooperative pause/resume gate on
// FleetWorkflow: requestPause()/requestResume()/setPauseGuard(), the activity-
// entry gate, the deferred "engage only at a clean-state boundary" semantics,
// the pause:requested/paused/resumed lifecycle events (with phase/group
// labels), and the requestStop()-while-paused teardown path.
//
// These poke the engine directly (wf.agent()/wf.requestPause() ... rather than
// via WorkflowEngine.executeFile()) because the primitive is instance-level
// and its subtle failure paths -- a throwing guard, a stop while blocked at
// the gate, "paused withheld until zero in-flight" -- are most precisely
// exercised at that level.

const KNOWN_MEMBERS = new Set(['fleet-dev']);

/**
 * A mock fleetApi whose executePrompt()/executeCommand() block on a gate the
 * test controls, so a dispatch can be held "in flight" deterministically while
 * assertions run. Call `release()` to let the currently-blocked dispatch (and
 * any future one) complete. Each call records that it started.
 */
function createGatedFleetApi() {
    let releaseFn;
    let gate = new Promise((resolve) => { releaseFn = resolve; });
    const started = [];
    const respond = async (memberKey, text) => {
        started.push(memberKey);
        await gate;
        if (!KNOWN_MEMBERS.has(memberKey)) {
            return { content: [{ text: `Member "${memberKey}" not found.` }] };
        }
        return {
            content: [{ text }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        };
    };
    return {
        started,
        release() { releaseFn(); },
        // reset the gate so a subsequent dispatch blocks again
        rearm() { gate = new Promise((resolve) => { releaseFn = resolve; }); },
        async executePrompt(payload) {
            return respond(payload.member_name || payload.member_id, `echo: ${payload.prompt}`);
        },
        async executeCommand(payload) {
            started.push(payload.member_name || payload.member_id);
            await gate;
            return { content: [{ text: payload.command }], isError: false };
        }
    };
}

/**
 * An immediate (non-blocking) mock fleetApi -- for tests that only care about
 * the pause state machine while nothing is in flight.
 */
function createImmediateFleetApi() {
    return {
        async executePrompt(payload) {
            return {
                content: [{ text: `echo: ${payload.prompt}` }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
            };
        },
        async executeCommand(payload) {
            return { content: [{ text: payload.command }], isError: false };
        }
    };
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

describe('apra-fleet-p2to.1.1: workflow engine pause/resume primitive', () => {
    test('requestPause while idle engages immediately and fires pause:requested then paused', () => {
        const wf = new FleetWorkflow(createImmediateFleetApi());
        const events = [];
        wf.on('pause:requested', (p) => events.push(['pause:requested', p]));
        wf.on('paused', (p) => events.push(['paused', p]));

        wf.requestPause('manual');

        assert.deepStrictEqual(events.map((e) => e[0]), ['pause:requested', 'paused']);
        assert.strictEqual(wf._paused, true);
        // The request flag stays set alongside _paused while paused; both are
        // cleared together by requestResume()/requestStop().
        wf.requestResume();
        assert.strictEqual(wf._paused, false);
        assert.strictEqual(wf._pauseRequested, false);
    });

    test("'paused' is withheld until in-flight activities drain to zero", async () => {
        const api = createGatedFleetApi();
        const wf = new FleetWorkflow(api);
        let pausedFired = false;
        wf.on('paused', () => { pausedFired = true; });

        // Start a dispatch and let it clear the gate and become in-flight.
        const inflight = wf.agent('hello', { member_name: 'fleet-dev' });
        await nextTick();
        assert.strictEqual(wf._inFlight, 1, 'dispatch should be in flight');

        // Request the pause while work is in flight: it must NOT engage yet.
        wf.requestPause();
        await nextTick();
        assert.strictEqual(wf._pauseRequested, true);
        assert.strictEqual(wf._paused, false);
        assert.strictEqual(pausedFired, false, "'paused' must not fire while in flight");

        // Drain the in-flight activity: now the deferred pause engages.
        api.release();
        await inflight;
        assert.strictEqual(wf._inFlight, 0);
        assert.strictEqual(wf._paused, true);
        assert.strictEqual(pausedFired, true);
    });

    test('a call reaching the gate while paused blocks, then proceeds after requestResume', async () => {
        const wf = new FleetWorkflow(createImmediateFleetApi());
        wf.requestPause();
        assert.strictEqual(wf._paused, true);

        let settled = false;
        const blocked = wf.agent('hello', { member_name: 'fleet-dev' }).then((r) => { settled = true; return r; });
        await nextTick();
        // Blocked at the gate: never became in-flight, one waiter parked.
        assert.strictEqual(settled, false);
        assert.strictEqual(wf._inFlight, 0);
        assert.strictEqual(wf._pauseWaiters.length, 1);

        const resumed = [];
        wf.on('resumed', (p) => resumed.push(p));
        wf.requestResume();
        const result = await blocked;
        assert.strictEqual(settled, true);
        // Direct wf.agent() returns the dispatch's text payload as a string.
        assert.strictEqual(result, 'echo: hello');
        assert.strictEqual(wf._paused, false);
        assert.strictEqual(resumed.length, 1);
    });

    test('requestStop() while paused rejects every gate waiter with CancelledError and tears down', async () => {
        const wf = new FleetWorkflow(createImmediateFleetApi());
        wf.requestPause();

        const a = wf.agent('one', { member_name: 'fleet-dev' });
        const b = wf.command('do-thing', { member_name: 'fleet-dev' });
        await nextTick();
        assert.strictEqual(wf._pauseWaiters.length, 2, 'both calls parked at the gate');

        wf.requestStop('stopping');

        await assert.rejects(a, (err) => err instanceof CancelledError);
        await assert.rejects(b, (err) => err instanceof CancelledError);
        // Pause state fully torn down so a late activity does not re-block.
        assert.strictEqual(wf._paused, false);
        assert.strictEqual(wf._pauseRequested, false);
        assert.strictEqual(wf._pauseWaiters.length, 0);
    });

    test('a throwing pause guard fails closed: the pause keeps deferring, then engages once the guard opens', () => {
        const wf = new FleetWorkflow(createImmediateFleetApi());
        let pausedFired = false;
        wf.on('paused', () => { pausedFired = true; });

        wf.setPauseGuard(() => { throw new Error('guard boom'); });
        wf.requestPause();
        // Guard threw -> treated as "not at a boundary" -> pause stays deferred.
        assert.strictEqual(wf._pauseRequested, true);
        assert.strictEqual(wf._paused, false);
        assert.strictEqual(pausedFired, false);

        // Opening the guard at what the script deems clean engages the pause.
        wf.setPauseGuard(() => true);
        assert.strictEqual(wf._paused, true);
        assert.strictEqual(pausedFired, true);
    });

    test('a falsey pause guard defers the pause until it returns truthy', () => {
        const wf = new FleetWorkflow(createImmediateFleetApi());
        let permit = false;
        wf.setPauseGuard(() => permit);

        wf.requestPause();
        assert.strictEqual(wf._pauseRequested, true);
        assert.strictEqual(wf._paused, false);

        permit = true;
        // setPauseGuard(null) re-evaluates the boundary (a null guard treats
        // any zero-in-flight point as clean) and engages the deferred pause.
        wf.setPauseGuard(null);
        assert.strictEqual(wf._paused, true);
    });

    test('pause lifecycle events carry the current phase/group labels', () => {
        const wf = new FleetWorkflow(createImmediateFleetApi());
        wf.phase('build');
        wf.group('groupA');

        const payloads = {};
        wf.on('pause:requested', (p) => { payloads.requested = p; });
        wf.on('paused', (p) => { payloads.paused = p; });
        wf.on('resumed', (p) => { payloads.resumed = p; });

        wf.requestPause();
        wf.requestResume();

        for (const key of ['requested', 'paused', 'resumed']) {
            assert.strictEqual(payloads[key].phase, 'build', `${key} carries phase`);
            assert.strictEqual(payloads[key].group, 'groupA', `${key} carries group`);
        }
    });

    test('requestPause is a no-op while already paused/pause-requested; requestResume is a no-op when not paused', () => {
        const wf = new FleetWorkflow(createImmediateFleetApi());
        let requestedCount = 0;
        let resumedCount = 0;
        wf.on('pause:requested', () => { requestedCount += 1; });
        wf.on('resumed', () => { resumedCount += 1; });

        // No-op resume before any pause.
        wf.requestResume();
        assert.strictEqual(resumedCount, 0);

        wf.requestPause();
        wf.requestPause();
        assert.strictEqual(requestedCount, 1, 'pause:requested fires once');

        wf.requestResume();
        wf.requestResume();
        assert.strictEqual(resumedCount, 1, 'resumed fires once');
    });

    test('setPauseGuard rejects a non-function, non-null argument', () => {
        const wf = new FleetWorkflow(createImmediateFleetApi());
        assert.throws(() => wf.setPauseGuard(42), TypeError);
        assert.throws(() => wf.setPauseGuard('nope'), TypeError);
        // function and null are both accepted.
        assert.doesNotThrow(() => wf.setPauseGuard(() => true));
        assert.doesNotThrow(() => wf.setPauseGuard(null));
    });

    test('setPauseGuard is exposed on the workflow script context; requestPause/Resume stay instance-only', () => {
        const wf = new FleetWorkflow(createImmediateFleetApi());
        const ctx = wf._bindPrimitives();
        assert.strictEqual(typeof ctx.setPauseGuard, 'function');
        // The orchestrator-driven controls are deliberately NOT in the script
        // context (they mirror requestStop()'s instance-only surface).
        assert.strictEqual(ctx.requestPause, undefined);
        assert.strictEqual(ctx.requestResume, undefined);
        assert.strictEqual(typeof wf.requestPause, 'function');
        assert.strictEqual(typeof wf.requestResume, 'function');
    });
});
