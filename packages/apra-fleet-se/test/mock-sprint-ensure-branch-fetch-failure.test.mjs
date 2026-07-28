import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// auto-sprint-9 follow-up (fable-review finding): the Ensure Sprint Branch
// phase's failSoft fetch of `origin/<branch>` must only fall back to
// resetting to base when git says the branch genuinely doesn't exist yet
// (`fatal: couldn't find remote ref <branch>`). Any OTHER fetch failure
// (network blip, auth expiry, DNS hiccup) must abort loudly instead of
// silently taking the same fallback path -- collapsing both cases would
// silently discard real pushed work on a transient failure, exactly the
// data-loss bug auto-sprint-9 fixed in the first place.
test('mock sprint: a non-"branch doesn\'t exist" fetch failure on Ensure Sprint Branch aborts loudly, does not silently reset to base', async () => {
    await withScenarioMarkers('branchfetcherr', async () => {
        console.log('Running mock sprint scenario (Ensure Sprint Branch: transient fetch failure must not silently fall back)...');
        const scenario = await runDevelopLoopScenario('branchfetcherr', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: branch-fetch-failure injection scenario' }],
            maxCycles: 1,
            gitGhFailurePattern: /^git fetch origin auto-sprint\/mock-branchfetcherr\b/,
            gitGhFailureMessage: 'fatal: unable to access remote: Could not resolve host',
        });
        check(!!scenario.error, 'Expected the transient fetch failure to abort the sprint, not be silently swallowed');
        check(
            scenario.error.message.includes('failed for a reason other than "branch doesn\'t exist"'),
            `Expected the discrimination error message, got: ${scenario.error ? scenario.error.message : 'n/a'}`
        );
        check(
            scenario.error.message.includes('Could not resolve host'),
            `Expected the surfaced error to include the underlying git failure text, got: ${scenario.error ? scenario.error.message : 'n/a'}`
        );
        // The critical negative assertion: a checkout using origin/main (the
        // destructive fallback) must never have been attempted.
        const checkoutCommands = scenario.commandLog.filter((c) => c.startsWith('git checkout -B'));
        check(
            checkoutCommands.length === 0,
            `Expected zero git checkout attempts after the discriminated fetch failure, got: ${JSON.stringify(checkoutCommands)}`
        );
    });
});

test('mock sprint: a genuine "branch doesn\'t exist yet" fetch failure still falls back to base (sanity, unchanged behavior)', async () => {
    await withScenarioMarkers('branchnotexist', async () => {
        console.log('Running mock sprint scenario (Ensure Sprint Branch: brand-new branch legitimately absent from origin)...');
        const scenario = await runDevelopLoopScenario('branchnotexist', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: brand-new-branch scenario' }],
            maxCycles: 1,
            gitGhFailurePattern: /^git fetch origin auto-sprint\/mock-branchnotexist\b/,
            gitGhFailureMessage: "fatal: couldn't find remote ref auto-sprint/mock-branchnotexist",
        });
        check(!scenario.error, `Expected no error for a legitimately-new branch, got: ${scenario.error ? scenario.error.message : 'n/a'}`);
        const checkoutCommands = scenario.commandLog.filter((c) => c.startsWith('git checkout -B'));
        check(checkoutCommands.length === 1, `Expected exactly one checkout, got: ${JSON.stringify(checkoutCommands)}`);
        check(
            checkoutCommands[0].includes('origin/main'),
            `Expected the fallback checkout to use origin/main (the base branch), got: ${checkoutCommands[0]}`
        );
    });
});
