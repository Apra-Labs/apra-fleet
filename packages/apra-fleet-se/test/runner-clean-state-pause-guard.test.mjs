import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import { runCmd, setupMinimal, buildMockFleetApi, teardown, defaultMockCallTool, uniqueMockBranch } from './helpers/mock-sprint-harness.mjs';
import { createMemberReservationClient } from '../fleet-sprint/runner.js';

// apra-fleet-p2to.4.1 -- runner.js's clean-state pause guard: an
// `openSyncBracketCount` counter registered with the engine's
// setPauseGuard() so a deferred pause (apra-fleet-p2to.1's cooperative
// requestPause()) only ever takes effect once every open git/dolt sync
// bracket has closed, never mid-pull/mid-push.
//
// Review gap (prior round): the counter + withOpenSyncBracket()'s try/finally
// balancing across error paths, and the `=== 0` guard predicate itself, had
// no regression test -- confirmed by grep that the wrapping is complete, but
// never exercised. Two layers of coverage here:
//
//   1. A verbatim EXTRACTION of the real openSyncBracketCount/
//      withOpenSyncBracket()/setPauseGuard-registration source out of
//      runner.js (same technique the viewer package's DOM tests use for
//      client-side code that only exists inside a template string --
//      runSprintCycle()'s internals are a non-exported closure, so this is
//      the only way to unit-test the ACTUAL current source rather than a
//      reimplementation that could silently drift out of sync with it).
//      Fast, deterministic, covers the increment/decrement-on-throw and
//      nested-bracket cases precisely.
//   2. One end-to-end mock-sprint integration test proving the guard is
//      actually WIRED to a live withGitSync bracket: a pause requested
//      mid-doer-dispatch must not engage until the bracket's post-dispatch
//      git/dolt sync has also finished, then must engage and let
//      requestResume() unblock the rest of the sprint.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNNER_PATH = path.join(__dirname, '../fleet-sprint/runner.js');

/**
 * Extracts the exact `let openSyncBracketCount = 0; ... async function
 * withOpenSyncBracket(fn) { ... }` block out of runner.js's runSprintCycle()
 * (verbatim, via known start/end markers unique to this block) and evaluates
 * it standalone via `new Function`, with a fake `setPauseGuard` supplied as
 * a parameter (mirroring how runSprintCycle() destructures it off `context`).
 * Returns `{ withOpenSyncBracket, getOpenSyncBracketCount }`; the caller
 * supplies its own `setPauseGuard` spy to capture the registered predicate.
 */
function loadRealOpenSyncBracketInternals(setPauseGuardSpy) {
    const src = fs.readFileSync(RUNNER_PATH, 'utf-8');
    const startMarker = 'let openSyncBracketCount = 0;';
    const start = src.indexOf(startMarker);
    assert.ok(start !== -1, 'runner.js must still define openSyncBracketCount inside runSprintCycle() (apra-fleet-p2to.4.1)');
    const endMarker = '\n    // The shared full-DB beads snapshot served by fetchAllBeadsShared()';
    const end = src.indexOf(endMarker, start);
    assert.ok(end !== -1, 'could not find the end of the openSyncBracketCount/withOpenSyncBracket block -- runner.js must have changed shape near it');
    const body = src.slice(start, end);
    // Sanity: the slice must actually contain both pieces under test, not
    // just the counter declaration (guards against the end marker silently
    // matching too early after some future refactor).
    assert.ok(body.includes('async function withOpenSyncBracket(fn)'), 'extracted block must include withOpenSyncBracket()');
    assert.ok(body.includes('setPauseGuard(() => openSyncBracketCount === 0)'), 'extracted block must include the guard registration');

    // eslint-disable-next-line no-new-func
    const factory = new Function('setPauseGuard', `
        ${body}
        return { withOpenSyncBracket, getOpenSyncBracketCount: () => openSyncBracketCount };
    `);
    return factory(setPauseGuardSpy);
}

describe('apra-fleet-p2to.4.1: openSyncBracketCount / withOpenSyncBracket() (extracted from the real runner.js source)', () => {
    test('setPauseGuard is registered with a predicate reading openSyncBracketCount === 0, true while idle', () => {
        let capturedGuard = null;
        const internals = loadRealOpenSyncBracketInternals((fn) => { capturedGuard = fn; });
        assert.equal(typeof capturedGuard, 'function');
        assert.equal(internals.getOpenSyncBracketCount(), 0);
        assert.equal(capturedGuard(), true, 'guard must read true (permits pause) while no bracket is open');
    });

    test('setPauseGuard is only registered when a setPauseGuard function is supplied -- absent/non-function is a safe no-op (legacy/direct callers of runSprintCycle())', () => {
        let capturedGuard = 'unset';
        assert.doesNotThrow(() => { loadRealOpenSyncBracketInternals(undefined); });
        assert.doesNotThrow(() => { loadRealOpenSyncBracketInternals(null); });
        const internals = loadRealOpenSyncBracketInternals(undefined);
        // withOpenSyncBracket itself must still work with no guard registered.
        assert.equal(capturedGuard, 'unset');
        return internals.withOpenSyncBracket(async () => 'ok').then((v) => assert.equal(v, 'ok'));
    });

    test('withOpenSyncBracket increments for fn\'s duration (guard reads false) and decrements after it resolves (guard reads true again), passing fn\'s return value through', async () => {
        let capturedGuard = null;
        const internals = loadRealOpenSyncBracketInternals((fn) => { capturedGuard = fn; });

        let countDuringFn = null;
        let guardDuringFn = null;
        const result = await internals.withOpenSyncBracket(async () => {
            countDuringFn = internals.getOpenSyncBracketCount();
            guardDuringFn = capturedGuard();
            return 'dispatch-result';
        });

        assert.equal(countDuringFn, 1, 'the bracket must be open (count=1) for the whole duration of fn');
        assert.equal(guardDuringFn, false, 'a pending pause must NOT be permitted while the bracket is open');
        assert.equal(result, 'dispatch-result', 'the wrapped function\'s return value must pass through unchanged');
        assert.equal(internals.getOpenSyncBracketCount(), 0, 'the bracket must close again once fn resolves');
        assert.equal(capturedGuard(), true, 'the guard must permit a pause again once the bracket closes');
    });

    test('a throwing fn still decrements the counter back to zero via finally, and the original error propagates unchanged (never swallowed)', async () => {
        let capturedGuard = null;
        const internals = loadRealOpenSyncBracketInternals((fn) => { capturedGuard = fn; });

        class BoomError extends Error {}
        await assert.rejects(
            internals.withOpenSyncBracket(async () => { throw new BoomError('sync step failed'); }),
            BoomError,
        );
        assert.equal(internals.getOpenSyncBracketCount(), 0, 'the counter must never leak a stale increment after a throw');
        assert.equal(capturedGuard(), true, 'the guard must permit a pause again immediately after the throwing bracket unwinds');
    });

    test('a synchronously-throwing fn (throws before its first await) still decrements correctly', async () => {
        const internals = loadRealOpenSyncBracketInternals(() => {});
        await assert.rejects(
            internals.withOpenSyncBracket(() => { throw new Error('sync throw, no await at all'); }),
        );
        assert.equal(internals.getOpenSyncBracketCount(), 0);
    });

    test('nested withOpenSyncBracket calls are harmless double-counting, never a leak -- BOTH must close for the guard to read true again', async () => {
        let capturedGuard = null;
        const internals = loadRealOpenSyncBracketInternals((fn) => { capturedGuard = fn; });

        let innerCount = null;
        await internals.withOpenSyncBracket(async () => {
            await internals.withOpenSyncBracket(async () => {
                innerCount = internals.getOpenSyncBracketCount();
            });
            // The inner bracket closing must not clear the OUTER bracket
            // still open -- exactly the "nested one is harmless double-
            // counting, never a leak" invariant from runner.js's own doc
            // comment on openSyncBracketCount.
            assert.equal(internals.getOpenSyncBracketCount(), 1, 'the outer bracket must still read open after the inner one closes');
            assert.equal(capturedGuard(), false, 'the guard must still deny a pause with the outer bracket still open');
        });
        assert.equal(innerCount, 2, 'both brackets must be open simultaneously at the innermost point');
        assert.equal(internals.getOpenSyncBracketCount(), 0);
        assert.equal(capturedGuard(), true);
    });

    test('a throw from a NESTED bracket unwinds both counters correctly, leaving the guard true again', async () => {
        let capturedGuard = null;
        const internals = loadRealOpenSyncBracketInternals((fn) => { capturedGuard = fn; });

        await assert.rejects(
            internals.withOpenSyncBracket(() => internals.withOpenSyncBracket(async () => { throw new Error('nested boom'); })),
        );
        assert.equal(internals.getOpenSyncBracketCount(), 0, 'both the inner and outer bracket must decrement despite the nested throw');
        assert.equal(capturedGuard(), true);
    });
});

// ============================================================================
// Integration: prove the guard is actually WIRED to a live withGitSync
// bracket via a real (mocked) mini sprint, not just correct in isolation.
// ============================================================================

describe('apra-fleet-p2to.4.1: clean-state pause guard wiring (mock-sprint integration)', () => {
    test('a pause requested mid-doer-dispatch (inside a live withGitSync bracket) is deferred, then engages once the bracket\'s post-dispatch sync has also finished; resume then lets the sprint finish', async () => {
        const tag = 'p2to41guard';
        const { tempDir, epicBead } = await setupMinimal(tag, [{ title: 'Task: closes normally' }]);
        const priorBackoff = process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF;
        process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF = '1';
        try {
            const dispatched = [];
            const commandLog = [];
            const activityLog = [];
            let pausedDuringDispatch = null;
            let pauseRequestedAtActivity = null;
            let pausedAtActivity = null;
            let pausedEventFired = false;

            const doerHandler = async ({ opts, tempDir: td }) => {
                pauseRequestedAtActivity = activityLog.length;
                // eslint-disable-next-line no-use-before-define
                workflow.requestPause('apra-fleet-p2to.4.1 mid-bracket test');
                // Still mid-dispatch -- itself still nested inside the WHOLE
                // withGitSync bracket (pre-dispatch sync already ran, post-
                // dispatch git/dolt push has not yet run). The pause must
                // NOT have engaged synchronously here.
                // eslint-disable-next-line no-use-before-define
                pausedDuringDispatch = workflow._paused;
                const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
                const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                for (const id of ids) {
                    await runCmd(`bd close ${id}`, td);
                }
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Closed for real.' }) }] };
            };
            const approvingReviewerHandler = async () => ({
                content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
            });

            const mockFleetApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, {
                planReviewerMode: 'approve-immediately',
                doerHandler,
                reviewerHandler: approvingReviewerHandler,
            });
            const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
            workflow.on('activity:start', (meta) => { activityLog.push(meta); });
            workflow.on('paused', () => {
                pausedAtActivity = activityLog.length;
                pausedEventFired = true;
                // Unblock the rest of the sprint immediately -- this test
                // only cares that the pause deferred correctly and that
                // resume lets the run continue, not about staying paused.
                workflow.requestResume('apra-fleet-p2to.4.1 test cleanup');
            });

            const engine = new WorkflowEngine(workflow);
            const branch = uniqueMockBranch(tag);
            await engine.executeFile(RUNNER_PATH, {
                target_issue: epicBead.id,
                members: ['local'],
                branch,
                base_branch: 'main',
                goal: 'P1/P2',
                max_cycles: 3,
                callTool: defaultMockCallTool(),
            }, true);

            assert.equal(pausedDuringDispatch, false, 'the pause must not engage while still mid-dispatch inside the open withGitSync bracket');
            assert.ok(pausedEventFired, 'the pause must eventually engage once the bracket (and any other in-flight activity) has fully closed');
            assert.ok(
                pausedAtActivity > pauseRequestedAtActivity + 1,
                `expected at least one more activity (the post-dispatch git/dolt sync) to start between the pause request (activity #${pauseRequestedAtActivity}) and the pause actually engaging (activity #${pausedAtActivity}) -- proving the guard deferred past the rest of the bracket, not just past the single in-flight dispatch`,
            );

            const finalBeadsRaw = JSON.parse((await runCmd('bd list --all --json', tempDir)).stdout || '[]');
            const task = finalBeadsRaw.find((b) => b.title === 'Task: closes normally');
            assert.ok(task, 'expected the scenario\'s task bead to exist in the final beads state');
            assert.equal(task.status, 'closed', 'the sprint must have completed successfully after resume unblocked the deferred pause');
        } finally {
            if (priorBackoff === undefined) {
                delete process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF;
            } else {
                process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF = priorBackoff;
            }
            await teardown(tempDir);
        }
    });
});

// ============================================================================
// apra-fleet-p2to.4.4.2 -- verifies the apra-fleet-p2to.4.4/.4.4.1 fix: closing
// the LAST open sync bracket must itself engage a deferred pause (emitting
// 'paused', which in turn triggers releaseForPause()) even when NO further
// agent()/command() dispatch follows the bracket close. Before the fix,
// openSyncBracketCount-- never re-consulted the engine's pause-engage check,
// so a pause requested while a bracket was open stayed stranded until some
// later dispatch happened to hit the gate -- and a sprint that ends right
// after the last bracket closes never emitted 'paused' at all, silently
// skipping the reservation hand-back. These use the SAME verbatim source
// extraction as the apra-fleet-p2to.4.1 suite above (a real FleetWorkflow
// instance wired to the real, unmodified withOpenSyncBracket()/setPauseGuard
// registration out of runner.js), but drive it directly -- no full mock
// sprint -- so the assertion is precisely "the bracket closing alone is
// what engages the pause", not "some dispatch after it happened to".
// ============================================================================

function createNoopFleetApi() {
    return {
        async executePrompt() {
            return { content: [{ text: 'ok' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
        },
        async executeCommand() {
            return { content: [{ text: 'ok' }], isError: false };
        },
    };
}

describe('apra-fleet-p2to.4.4.2: deferred pause engages on sync-bracket guard clear; releaseForPause hands back reservations', () => {
    test('AC1: a pause requested while a bracket is open engages (emits paused) the instant the LAST bracket closes -- no further dispatch involved', async () => {
        const wf = new FleetWorkflow(createNoopFleetApi());
        const internals = loadRealOpenSyncBracketInternals(wf.setPauseGuard.bind(wf));

        let pausedFired = false;
        wf.on('paused', () => { pausedFired = true; });

        await internals.withOpenSyncBracket(async () => {
            wf.requestPause('apra-fleet-p2to.4.4.2 mid-bracket');
            // Still inside the bracket: the pause must stay deferred.
            assert.equal(wf._paused, false, 'must not engage while the bracket is still open');
            assert.equal(pausedFired, false);
        });

        // The bracket has now fully closed (its `finally` already ran) and NO
        // agent()/command() dispatch has happened since -- this is the exact
        // "sprint ends right after the last bracket closes" scenario the bug
        // described. The pause must already be engaged at this point.
        assert.equal(pausedFired, true, "'paused' must fire the instant the last open bracket closes, with zero further dispatch");
        assert.equal(wf._paused, true);
    });

    test('AC1 (nested): the pause only engages once the OUTER (truly last) bracket closes, not when an inner one closes', async () => {
        const wf = new FleetWorkflow(createNoopFleetApi());
        const internals = loadRealOpenSyncBracketInternals(wf.setPauseGuard.bind(wf));

        let pausedFired = false;
        wf.on('paused', () => { pausedFired = true; });

        await internals.withOpenSyncBracket(async () => {
            await internals.withOpenSyncBracket(async () => {
                wf.requestPause('apra-fleet-p2to.4.4.2 nested mid-bracket');
            });
            // The inner bracket just closed and poked the guard, but the outer
            // bracket is still open -- must NOT engage yet.
            assert.equal(pausedFired, false, 'an inner bracket closing must not engage a pause while the outer bracket is still open');
            assert.equal(wf._paused, false);
        });

        assert.equal(pausedFired, true, 'the outer bracket closing (the true last bracket) must engage the pause');
        assert.equal(wf._paused, true);
    });

    test('AC2: releaseForPause() hands back every member reservation in that same engage-on-clear path, wired exactly like cli.mjs\'s workflow.on(\'paused\', ...)', async () => {
        const wf = new FleetWorkflow(createNoopFleetApi());
        const internals = loadRealOpenSyncBracketInternals(wf.setPauseGuard.bind(wf));

        const calls = [];
        const sprintReservation = createMemberReservationClient({
            callTool: async (name, args) => { calls.push(args); return '[OK] released'; },
            members: ['alice', 'bob'],
            sprintId: 'feat/workflow-pause-resume',
        });
        // Mirror cli.mjs's real wiring verbatim: workflow.on('paused', () =>
        // sprintReservation.releaseForPause().catch(...)).
        let releasePromise = null;
        wf.on('paused', () => {
            releasePromise = sprintReservation.releaseForPause().catch((err) => {
                throw err;
            });
        });

        await internals.withOpenSyncBracket(async () => {
            wf.requestPause('apra-fleet-p2to.4.4.2 mid-bracket');
            // Bracket still open: releaseForPause() must not have run yet.
            assert.equal(calls.length, 0, 'must not release members before the pause has actually engaged');
        });

        assert.ok(releasePromise, "the 'paused' handler (and therefore releaseForPause()) must have fired synchronously as the bracket closed, with no dispatch in between");
        await releasePromise;
        assert.deepEqual(calls.map((a) => a.member_name), ['alice', 'bob'], 'every member must be handed back');
        assert.ok(calls.every((a) => a.action === 'release' && a.sprint_id === 'feat/workflow-pause-resume'));
    });

    test('AC3: releaseForPause and releaseAll are the exact same de-duplicated implementation (guards against a byte-identical second copy reappearing)', async () => {
        const calls = [];
        const client = createMemberReservationClient({
            callTool: async (name, args) => { calls.push(args); return '[OK] released'; },
            members: ['alice', 'bob'],
            sprintId: 'feat/workflow-pause-resume',
        });

        assert.equal(client.releaseForPause, client.releaseAll, 'releaseForPause must be the SAME function reference as releaseAll, not a duplicate implementation');

        // Behavioral confirmation: calling either produces the identical
        // release-every-member call sequence.
        await client.releaseAll();
        const viaReleaseAll = calls.splice(0, calls.length);
        await client.releaseForPause();
        const viaReleaseForPause = calls.splice(0, calls.length);
        assert.deepEqual(viaReleaseForPause, viaReleaseAll, 'releaseForPause() must produce an identical call sequence to releaseAll()');
    });
});
