import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-9ta.6: a failing Publish push must not destroy the sprint's
// already-computed verdict.
//
// The Publish step's `git push -u origin <branch>` had no failSoft and no
// retry, so a transient failure (a racing writer, a momentarily unreachable
// remote, a credential refresh in flight) threw a CommandError out of the LAST
// step of a sprint that had already done all of its work -- turning a computed
// PASS into `verdict: 'ABORTED'` over a network hiccup.
//
// apra-fleet (Publish-PR push self-heal, superseding the original minimal
// hardening described below): Publish PR no longer issues its own bespoke
// 3x-identical-retry loop -- it now routes through the SAME syncMemberAfter()
// every other per-dispatch G-push already uses, via a new opt-in
// `setUpstream: true` that keeps the `-u origin` spelling (so this scenario's
// `gitGhFailurePattern` still targets ONLY Publish's push, not every other
// G-push in the sprint, which stay on the plain `git push <remote> <branch>`
// syncMemberAfter always used). Publish now gets the exact same bounded
// transient-retry (maxTransientRetries, inside runGitStep) + one-shot
// pull-rebase-then-re-push on a genuine non-fast-forward divergence, rather
// than blindly repeating an identical push 3 times (which could never
// self-heal a real "fetch first" rejection). A non-diverged failure (this
// scenario's simulated "Could not resolve host", classified 'transient')
// still fails after its bounded retry -- there is nothing to rebase against
// for a transient/unknown failure -- so the original hardening goal
// (failSoft, loud log, computed verdict preserved, `pushed: false`, PR
// creation skipped) is unchanged; only the retry COUNT/shape changed.
// =============================================================================

test('mock sprint: a persistently failing Publish push keeps the computed verdict (pushed:false), skips gh pr create, and never reports ABORTED', { timeout: 180000 }, async () => {
    await withScenarioMarkers('publishpushfails', async () => {
        const scenario = await runDevelopLoopScenario('publishpushfails', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: publish-push-failure scenario work' }],
            maxCycles: 1,
            gitGhFailurePattern: /^git push -u origin/,
            gitGhFailureMessage: 'fatal: unable to access origin: Could not resolve host (simulated transient remote failure)',
        });

        // The sprint completes normally -- it does NOT throw out of Publish.
        check(!scenario.error, `expected no thrown sprint abort, got: ${scenario.error && scenario.error.message}`);
        check(scenario.result, 'expected runSprintCycle to return a result rather than throw');

        // The verdict the sprint actually COMPUTED survives the push failure.
        check(
            scenario.result.verdict === 'PASS' && scenario.result.status === 'success',
            `expected the computed PASS verdict to be preserved, got: ${JSON.stringify(scenario.result)}`,
        );
        check(
            scenario.result.pushed === false,
            `expected pushed:false on a persistent publish-push failure, got: ${JSON.stringify(scenario.result)}`,
        );

        // No ABORTED terminal record: the typed-abort path must never have been
        // entered for what is a publish-time transport failure.
        const abortedStates = scenario.states.filter((s) => s.namespace === 'terminal' && s.data && s.data.verdict === 'ABORTED');
        check(
            abortedStates.length === 0,
            `expected no ABORTED terminal state for a publish-push failure, got: ${JSON.stringify(abortedStates)}`,
        );

        // Bounded retry, not a single shot and not an unbounded loop: a
        // 'transient'-classified failure (this scenario's simulated DNS
        // failure) gets syncMemberAfter's own bounded retry -- the initial
        // attempt plus maxTransientRetries (default 1) -- then fails for
        // good; there is no rebase to attempt against a non-diverged error.
        const publishPushes = scenario.commandLog.filter((c) => /^git push -u origin/.test(c));
        check(
            publishPushes.length === 2,
            `expected exactly 2 bounded publish-push attempts (1 initial + 1 transient retry), got ${publishPushes.length}: ${JSON.stringify(publishPushes)}`,
        );

        // Loud, not silent.
        check(
            scenario.logs.some((m) => m.includes('[Publish Push Failed]')),
            `expected a loud [Publish Push Failed] log line, logs: ${JSON.stringify(scenario.logs.slice(-25))}`,
        );

        // Nothing downstream of the push runs: a PR cannot be raised for
        // commits that never reached the remote.
        check(
            scenario.commandLog.every((c) => !(/^curl -sS -X POST\b/.test(c) && /\/pulls\b/.test(c))),
            `expected no VCSModule PR-create curl command after a failed publish push, commands: ${JSON.stringify(scenario.commandLog.filter((c) => /^curl /.test(c)))}`,
        );
    });
});

test('mock sprint: the Publish push success path is unchanged -- one push, VCSModule PR create still raised, pushed:true', { timeout: 180000 }, async () => {
    await withScenarioMarkers('publishpushok', async () => {
        const scenario = await runDevelopLoopScenario('publishpushok', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: publish-push-success control scenario work' }],
            maxCycles: 1,
        });

        check(!scenario.error, `expected no thrown sprint abort, got: ${scenario.error && scenario.error.message}`);
        check(
            scenario.result && scenario.result.verdict === 'PASS' && scenario.result.pushed === true,
            `expected a PASS verdict with pushed:true on the success path, got: ${JSON.stringify(scenario.result)}`,
        );

        // Exactly one push attempt (the retry ladder never engages when the
        // first attempt succeeds), and the PR is still raised as before.
        const publishPushes = scenario.commandLog.filter((c) => /^git push -u origin/.test(c));
        check(
            publishPushes.length === 1,
            `expected exactly one publish-push attempt on the success path, got ${publishPushes.length}`,
        );
        check(
            scenario.commandLog.some((c) => /^curl -sS -X POST\b/.test(c) && /\/pulls\b/.test(c)),
            `expected VCSModule's PR-create curl command to still be dispatched on the success path, commands: ${JSON.stringify(scenario.commandLog.filter((c) => /^curl /.test(c)))}`,
        );
    });
});
