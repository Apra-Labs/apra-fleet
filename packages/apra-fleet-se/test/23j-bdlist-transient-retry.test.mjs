import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { verifyDoerStreakClosed, computeChildFloor, isTransientBdCommandFailure } from '../fleet-sprint/runner.js';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

// Zero-wait backoff between retries (see runner.js's mockInstantRetryBackoff
// doc comment) so these tests exercise the real BD_LIST_RETRY_DELAYS_MS retry
// COUNT without actually sleeping the real 2s/5s backoff -- keeps the whole
// file well under the ~10s runtime acceptance criterion. Saved/restored
// exactly like the other suites that opt into this (e.g.
// mock-sprint-worklist-resume.test.mjs).
let priorInstantRetryBackoff;
before(() => {
    priorInstantRetryBackoff = process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF;
    process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF = '1';
});
after(() => {
    if (priorInstantRetryBackoff === undefined) delete process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF;
    else process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF = priorInstantRetryBackoff;
});

// =============================================================================
// apra-fleet-23j.2: bdListScoped (and its shared bdListWithRetry wrapper, added
// by apra-fleet-23j.1 and extended to the remaining bd-list/show call sites by
// apra-fleet-23j.3) survives a transient bd-command timeout and still fails
// loud when retries are exhausted.
// =============================================================================
//
// bdListWithRetry() itself is module-private (not exported), so these tests
// drive it through two of its real call sites instead of re-implementing its
// contract against a bare fake:
//
//   - verifyDoerStreakClosed() (runner.js ~2337) issues a `bd show <ids>
//     --json` through the wrapper with NO surrounding try/catch, so a
//     rejection from the wrapper propagates out unchanged -- this is what
//     lets tests 1/2/4 below observe both success values AND rejections
//     directly, and it doubles as coverage criterion 6: this is one of the
//     apra-fleet-23j.3-converted bd-show-style call sites. (Test 5, the
//     regression guard for AC5's "never substitutes an empty array for a
//     failed SCOPE query" wording, is a harness-driven case further down --
//     see its own comment -- because it needs to drive bdListScoped's
//     actual filter/scope query, which this bare fake cannot reach.)
//   - computeChildFloor() (runner.js ~2192) issues a `bd list --parent <id>
//     --json` through the wrapper; the call itself does the real retrying,
//     but the function wraps it in a try/catch that always resolves to a
//     number (0 on failure), so it is used only for test 6's "another
//     converted call site retries too" check, not for the reject-path
//     assertions.
//
// verifyDoerStreakClosed() also issues a D-pull (DoltSync.syncBefore) BEFORE
// its `bd show`, so the fake command() below answers the two `bd dolt`/`bd
// config` probes that bracket issues as an instant, uneventful success and
// only feeds test-controlled output to the `bd show` calls -- the ones the
// wrapper under test actually retries. `showCalls` (not the raw invocation
// count of the fake) is therefore the count that stands in for "command()
// was invoked N times" in the acceptance criteria below.

function makeFakeCommand(showResponder) {
    const showCalls = [];
    async function command(cmd, opts) {
        if (/^bd dolt pull/.test(cmd)) return { ok: true, output: '' };
        if (/^bd config get sync\.remote/.test(cmd)) return { ok: true, output: '' };
        if (/^bd list --parent/.test(cmd)) return showResponder(1, cmd, opts);
        if (/^bd show /.test(cmd)) {
            showCalls.push(cmd);
            return showResponder(showCalls.length, cmd, opts);
        }
        throw new Error(`Unexpected command in 23j.2 fake: ${cmd}`);
    }
    return { command, showCalls };
}

test('23j.2 (1): transient-then-success -- retries once then resolves with the parsed beads, command() invoked exactly twice', async () => {
    const { command, showCalls } = makeFakeCommand((n) => {
        if (n === 1) return 'Command timed out after 120000ms of inactivity';
        return JSON.stringify([{ id: 'abc.1', status: 'closed' }, { id: 'abc.2', status: 'closed' }]);
    });
    const stillOpen = await verifyDoerStreakClosed({ command, orchestratorMember: 'local', beadIds: ['abc.1', 'abc.2'], log: () => {} });
    assert.deepEqual(stillOpen, [], 'both beads report closed once the retry succeeds, so nothing should remain "still open"');
    assert.equal(showCalls.length, 2, 'command() must be invoked exactly twice: one transient failure + one success');
});

test('23j.2 (2): retries exhausted -- rejects, and command() is invoked exactly the configured max attempts, no more', async () => {
    const { command, showCalls } = makeFakeCommand(() => 'Command timed out after 120000ms of inactivity');
    await assert.rejects(
        () => verifyDoerStreakClosed({ command, orchestratorMember: 'local', beadIds: ['x.1'], log: () => {} }),
        /transient bd\/dolt command failure/,
        'exhausting every attempt on a persistently transient failure must still be fatal',
    );
    assert.equal(showCalls.length, 3, 'the retry must be bounded: exactly 3 attempts, not unbounded and not fewer');
});

test("23j.2 (3): 'Failed to execute command on ' is classified transient the same way as the timeout text", async () => {
    assert.equal(isTransientBdCommandFailure('Failed to execute command on member-2: connection reset'), true);
    assert.equal(isTransientBdCommandFailure('Command timed out after 120000ms of inactivity'), true);

    const { command, showCalls } = makeFakeCommand((n) => {
        if (n === 1) return 'Failed to execute command on member-2: connection reset';
        return JSON.stringify([{ id: 'y.1', status: 'closed' }]);
    });
    const stillOpen = await verifyDoerStreakClosed({ command, orchestratorMember: 'local', beadIds: ['y.1'], log: () => {} });
    assert.deepEqual(stillOpen, []);
    assert.equal(showCalls.length, 2, "'Failed to execute command on ' must be retried exactly like the timeout shape");
});

test('23j.2 (4): non-transient garbage output rejects on the FIRST attempt with the parse-error message and issues NO retry', async () => {
    const { command, showCalls } = makeFakeCommand(() => 'not json at all');
    await assert.rejects(
        () => verifyDoerStreakClosed({ command, orchestratorMember: 'local', beadIds: ['z.1'], log: () => {} }),
        /\[bd JSON Parse Error\]/,
        'unparseable, non-transient output is a real bug and must stay fatal on the first attempt',
    );
    assert.equal(showCalls.length, 1, 'non-transient garbage must NOT be retried at all');
});

test('23j.2 (6): coverage of apra-fleet-23j.3 -- the converted computeChildFloor (bd list --parent) call site also retries on the transient shape', async () => {
    let attempts = 0;
    const { command } = makeFakeCommand(() => {
        attempts++;
        if (attempts === 1) return 'Command timed out after 120000ms of inactivity';
        return JSON.stringify([{ id: 'p.1' }, { id: 'p.2' }, { id: 'p.10' }]);
    });
    const floor = await computeChildFloor({ command, member: 'local', parentId: 'p' });
    assert.equal(floor, 10, 'the retry must succeed and computeChildFloor must compute the max direct-child suffix from the recovered data');
    assert.equal(attempts, 2, 'the bd list --parent call site converted in apra-fleet-23j.3 must retry the transient failure too');
});

// =============================================================================
// Reviewer feedback (previous round): tests 1-6 above drive only
// verifyDoerStreakClosed (apra-fleet-23j.3's `bd show`) and computeChildFloor
// (apra-fleet-23j.3's `bd list --parent`) -- neither of bdListScoped's OWN two
// call sites (fetchAllBeadsShared's `bd list --all --limit 0 --json` and the
// filter query, runner.js ~5190/~5277 -- the actual apra-fleet-23j bug site)
// was exercised by anything in the suite. The two harness-driven cases below,
// built in the style of 66u-stall-progress-credit.test.mjs's real mock-sprint
// scenarios (real `bd` in a scratch tempDir, real FleetWorkflow/runner.js
// execution -- only the fleet dispatch layer and one specific bd-list command
// are mocked), close that gap by injecting the transient shape directly onto
// bdListScoped's own `bd list --all --limit 0 --json` dispatch and asserting
// on the SPRINT's real end-to-end outcome, not on a hand-rolled fake.
//
// `bdListInjector` (mock-sprint-harness.mjs) is the new, minimal, additive
// mechanism this required: `commandFailurePattern` (used by earlier
// unw.17 scenarios) can only express a fixed nonzero-exit/error-message
// failure, which is NOT what a transient bd/dolt failure looks like -- per
// isTransientBdCommandFailure's own doc comment, it is a normal EXIT-0 stdout
// payload containing one of two known strings, so it needed its own
// injection point that returns that exact shape.
// =============================================================================

// apra-fleet-23j.2 rework (2nd round): the previous version of this injector
// answered ONLY the very first-ever dispatch of the matched command with the
// transient shape, unconditionally. That happened to land on
// updateDashboard()'s bdListScoped('') call, which is wrapped in a
// non-fatal, degrade-and-continue try/catch (runner.js ~5834-5862,
// apra-fleet-23j.1's AC explicitly requires that swallow to stay). So the
// sprint "survived" via the dashboard's swallow, not via the retry wrapper
// -- reverting BD_LIST_RETRY_DELAYS_MS to a single attempt still passed
// harness (i), because the LATER real call (e.g. readyLeafBeads(), which is
// NOT wrapped and would have been fatal) never saw the transient at all --
// the injector had already exhausted its one-shot answer.
//
// Fixed by making the injector alternate PER EXACT COMMAND STRING: the
// dispatch immediately following an injected transient for that same
// command is let through to the real exec (this is the wrapper's own retry
// attempt reaching bd for real); every dispatch after THAT starts the
// transient/success pair over again for that command. That means every
// logical call site that dispatches a matched command -- including fatal,
// non-swallowed ones like readyLeafBeads()'s filter query -- independently
// sees "transient, then success" on ITS OWN first attempt: with the retry
// wrapper present, that attempt pair is absorbed inside a single
// bdListWithRetry() call and the sprint completes; with the wrapper
// reverted to one attempt, whichever call site's turn lands on "transient"
// takes it as fatal (unless it happens to be swallowed by
// updateDashboard() -- but with BOTH the --all query and the --ready
// filter query matched, and multiple call sites dispatching across a full
// cycle, at least one non-swallowed call site's turn lands on transient),
// and the sprint dies -- which is exactly what the self-check below proves.
//
// Matching /^bd list / (not the single hardcoded --all string) also picks
// up the filter/scope query (`bd list <flags> --limit 0`, runner.js ~5277)
// for free, closing the secondary gap the previous round's reviewer notes
// flagged (that call site was never exercised by any transient injection).
function makeAlternatingBdListInjector(pattern, onDispatch) {
    const lastWasTransientByCmd = new Map();
    return (cmd) => {
        if (!pattern.test(cmd)) return undefined;
        const prevWasTransient = lastWasTransientByCmd.get(cmd) === true;
        if (prevWasTransient) {
            // This dispatch is the wrapper's own retry attempt for `cmd` --
            // let it reach the real `bd` exec against the scratch tempDir.
            lastWasTransientByCmd.set(cmd, false);
            if (onDispatch) onDispatch(cmd, 'success');
            return undefined;
        }
        lastWasTransientByCmd.set(cmd, true);
        if (onDispatch) onDispatch(cmd, 'transient');
        return 'Command timed out after 120000ms of inactivity';
    };
}

function parseAssignedIds(prompt) {
    const match = prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

async function closingDoerHandler({ opts, tempDir, runCmd: run }) {
    const ids = parseAssignedIds(opts.prompt);
    for (const id of ids) {
        await run(`bd close ${id} --reason "Done"`, tempDir);
    }
    return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Closed for real.' }) }] };
}

const approvingReviewerHandler = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }]
});

test("23j.2 harness (i): bdListScoped's own call sites (bd list --all --limit 0 --json and the --ready filter query) survive a transient timeout and the sprint completes", async () => {
    await withScenarioMarkers('23j.2 harness (i): bdListScoped transient-then-success -> sprint completes', async () => {
        // See makeAlternatingBdListInjector's doc comment above: this must be
        // stateful per exact command string (transient, then success, then
        // transient again for the NEXT independent call to that same
        // command) so that every logical call site -- not just whichever one
        // happens to dispatch first -- is actually exercised through the
        // retry wrapper, including the ones that are fatal (not swallowed
        // by updateDashboard()'s degrade-and-continue try/catch).
        const outcomes = [];
        const bdListInjector = makeAlternatingBdListInjector(/^bd list /, (cmd, outcome) => outcomes.push({ cmd, outcome }));

        const stalled = await runDevelopLoopScenario('23j2harness-i', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: closes normally' }],
            maxCycles: 1,
            doerHandler: closingDoerHandler,
            reviewerHandler: approvingReviewerHandler,
            bdListInjector,
        });

        assert.ok(
            !stalled.error,
            `Expected the sprint to complete cleanly despite the injected transient timeout on bdListScoped's own call sites, got: ${stalled.error ? stalled.error.constructor.name + ': ' + stalled.error.message : 'none'}`
        );
        const allQueryOutcomes = outcomes.filter((o) => o.cmd === 'bd list --all --limit 0 --json').map((o) => o.outcome);
        assert.equal(allQueryOutcomes[0], 'transient', 'the first bd list --all --limit 0 --json dispatch must be the injected transient failure');
        assert.equal(allQueryOutcomes[1], 'success', "the wrapper's very next attempt must be let through to the real bd exec and succeed");
        assert.ok(
            outcomes.some((o) => o.cmd !== 'bd list --all --limit 0 --json' && o.outcome === 'transient'),
            'a filter/scope query (e.g. the --ready query) must also have been dispatched and hit the injected transient at least once, proving that call site was exercised too'
        );
        const task = stalled.finalBeadsById.get(stalled.tasks[0].id);
        assert.equal(task && task.status, 'closed', 'the sprint must have completed real work (the task closed) after the transient recovery, not merely swallowed the error');
    });
});

// SELF-CHECK (see makeAlternatingBdListInjector's doc comment above and
// AC "Test fails if the retry wrapper from 23j.1 is reverted"): confirmed
// by hand before closing apra-fleet-23j.2 -- temporarily editing
// runner.js:153 to `const BD_LIST_RETRY_DELAYS_MS = [0];` (single attempt =
// the retry wrapper reverted) and re-running this file makes harness (i)
// FAIL with "transient bd/dolt command failure running 'bd list --ready
// --json --limit 0'" (readyLeafBeads()'s non-swallowed filter-query call
// site takes the injected transient and the sprint dies), exactly as this
// case is supposed to guard against. Restoring the three-element array
// makes it pass again (verified: full suite green). Not automated here
// because mutating the module's internal retry-count constant from a test
// would require exporting it purely for that purpose, which runner.js does
// not otherwise need.

test("23j.2 (5) regression guard: a persistently-transient SCOPE (filter) query never substitutes an empty array for a failed read -- the sprint fails loud instead", async () => {
    await withScenarioMarkers('23j.2 (5): bdListScoped filter/scope query transient exhausted -> sprint fails loud', async () => {
        // Unlike harness (ii) (which targets the --all query), this
        // targets bdListScoped's SECOND query -- the caller's filter args
        // (`bd list <flags> --limit 0`, runner.js ~5277, e.g. the --ready
        // query readyLeafBeads() issues) -- because AC5's wording
        // ("never substitutes an empty array for a failed SCOPE query") is
        // about that filtered/scoped read, not the plain bd-show streak
        // check the old version of this test (redundant with test 2) drove.
        const bdListInjector = (cmd) => {
            if (cmd === 'bd list --all --limit 0 --json') return undefined; // let the --all fetch succeed normally
            if (!/^bd list .*--limit 0$/.test(cmd)) return undefined;
            return 'Command timed out after 120000ms of inactivity';
        };

        const stalled = await runDevelopLoopScenario('23j2harness-v', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: closes normally' }],
            maxCycles: 1,
            doerHandler: closingDoerHandler,
            reviewerHandler: approvingReviewerHandler,
            bdListInjector,
        });

        assert.ok(
            stalled.error,
            `Expected the sprint to fail loud when bdListScoped's filter/scope query is persistently transient (never silently resolve to an empty scope), got: ${stalled.error}`
        );
        assert.match(
            stalled.error.message,
            /transient bd\/dolt command failure/,
            `Expected the retry-exhausted failure to surface as the sprint's own error, got: ${stalled.error.message}`
        );
    });
});

test("23j.2 harness (ii): bdListScoped's own fetchAllBeadsShared call site persistently transient -- the sprint fails loud, never silently substitutes an empty scope", async () => {
    await withScenarioMarkers('23j.2 harness (ii): bdListScoped transient exhausted -> sprint fails loud', async () => {
        const bdListInjector = (cmd) => {
            if (cmd !== 'bd list --all --limit 0 --json') return undefined;
            return 'Command timed out after 120000ms of inactivity';
        };

        const stalled = await runDevelopLoopScenario('23j2harness-ii', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: closes normally' }],
            maxCycles: 1,
            doerHandler: closingDoerHandler,
            reviewerHandler: approvingReviewerHandler,
            bdListInjector,
        });

        assert.ok(
            stalled.error,
            `Expected the sprint to fail loud when bdListScoped's own fetchAllBeadsShared call site is persistently transient (never silently resolve to an empty scope), got: ${stalled.error}`
        );
        assert.match(
            stalled.error.message,
            /transient bd\/dolt command failure/,
            `Expected the retry-exhausted failure to surface as the sprint's own error, got: ${stalled.error.message}`
        );
    });
});
