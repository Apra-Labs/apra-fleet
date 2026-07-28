import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandError } from '@apralabs/apra-fleet-workflow';
import { GitSyncError, PostDispatchSyncError } from '../fleet-sprint/errors.mjs';
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
//
// apra-fleet-6z8.3: the bracket now distinguishes "the dispatch failed" from
// "a COMPLETED dispatch's post-step sync failed". This injected `git push`
// failure is the latter (the doer turn succeeded; only its G-push failed), so
// after the bracket retries the sync step on its own it surfaces as a
// PostDispatchSyncError WRAPPING the GitSyncError -- the distinct type is the
// whole point: it tells the retry ladder not to re-run the LLM turn. Still
// typed, still never swallowed, and still carrying the underlying git text.
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
            gitPushFailure.error instanceof CommandError
                || gitPushFailure.error instanceof GitSyncError
                || gitPushFailure.error instanceof PostDispatchSyncError,
            `Expected the surfaced git-push error to be a typed CommandError, GitSyncError or PostDispatchSyncError, got: ${gitPushFailure.error ? gitPushFailure.error.constructor.name : 'n/a'}`
        );
        // apra-fleet-6z8.3: when it IS the post-dispatch classification, the
        // underlying typed sync error must still be reachable as its cause --
        // the new wrapper adds information, it never hides the git failure.
        if (gitPushFailure.error instanceof PostDispatchSyncError) {
            check(
                gitPushFailure.error.cause instanceof GitSyncError || gitPushFailure.error.cause instanceof CommandError,
                `Expected the PostDispatchSyncError to wrap the underlying typed git error, got cause: ${gitPushFailure.error.cause ? gitPushFailure.error.cause.constructor.name : 'n/a'}`
            );
        }
        check(
            !!gitPushFailure.error && gitPushFailure.error.message.includes('Could not resolve host'),
            `Expected the surfaced error to include the underlying git failure text, got: ${gitPushFailure.error ? gitPushFailure.error.message : 'n/a'}`
        );
    });
});
