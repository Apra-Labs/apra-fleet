import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { verifyDoerStreakClosed, computeChildFloor, isTransientBdCommandFailure } from '../fleet-sprint/runner.js';

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
//     lets tests 1/2/4/5 below observe both success values AND rejections
//     directly, and it doubles as coverage criterion 6: this is one of the
//     apra-fleet-23j.3-converted bd-show-style call sites.
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

test('23j.2 (5) regression guard: exhausted retries never resolve to an empty result standing in for "all closed"', async () => {
    const { command } = makeFakeCommand(() => 'Command timed out after 120000ms of inactivity');
    let resolvedValue;
    let caught;
    try {
        resolvedValue = await verifyDoerStreakClosed({ command, orchestratorMember: 'local', beadIds: ['w.1', 'w.2'], log: () => {} });
    } catch (err) {
        caught = err;
    }
    assert.equal(resolvedValue, undefined, 'a persistently-transient scope query must never silently resolve (e.g. to []) instead of throwing');
    assert.ok(caught, 'the retry-exhausted failure must surface as a rejection, not a swallowed empty success');
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
