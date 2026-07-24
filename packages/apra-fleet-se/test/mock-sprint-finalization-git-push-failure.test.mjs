import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandError } from '@apralabs/apra-fleet-workflow';
import { GitSyncError } from '../auto-sprint/errors.mjs';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// Sanity: also inject a plain `git push` failure and confirm it, too,
// surfaces as a typed error (Publish PR's push step is not failSoft).
//
// Type note (apra-fleet-eft.8.x): before the withGitSync sync brackets, the
// FIRST `git push` a sprint issued was the finalization publish step -- a
// plain non-failSoft command(), so the injected failure surfaced as
// CommandError. The sync brackets now G-push (syncMemberAfter) after every
// code-writing dispatch, so the injected /^git push/ failure is hit first by
// a bracket push, which surfaces as the bracket's own typed GitSyncError
// after its bounded transient retries. Both are typed, never-swallowed
// surfaces of the same underlying failure -- accept either, and keep the
// underlying-git-text assertion so a silent swallow still fails this test.
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
            gitPushFailure.error instanceof CommandError || gitPushFailure.error instanceof GitSyncError,
            `Expected the surfaced git-push error to be a typed CommandError or GitSyncError, got: ${gitPushFailure.error ? gitPushFailure.error.constructor.name : 'n/a'}`
        );
        check(
            !!gitPushFailure.error && gitPushFailure.error.message.includes('Could not resolve host'),
            `Expected the surfaced error to include the underlying git failure text, got: ${gitPushFailure.error ? gitPushFailure.error.message : 'n/a'}`
        );
    });
});
