import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandError } from '@apralabs/apra-fleet-workflow';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

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
