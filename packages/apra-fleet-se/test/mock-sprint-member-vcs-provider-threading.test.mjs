import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-417.9 -- end-to-end coverage for the resolveMemberVcsProvider
// wiring runSprintCycle's withGitSync bracket passes into syncMemberBefore
// (G-pull) and syncMemberAfterOrdered (G-push), through the REAL runner.js
// call sites (~line 4931/4981), not just the isolated
// vcs-nongithub-auth-selfheal.test.mjs unit tests (which inject a hand-rolled
// resolveMemberProvider straight into syncMemberAfter, bypassing withGitSync
// entirely) or vcs-member-provider-resolver.test.mjs (apra-fleet-417.8, which
// covers createMemberVcsProviderResolver in isolation with a stubbed
// callTool, never dispatched through a sprint).
//
// Precedence note (see runner.js's own comment on `resolveMemberVcsProvider`,
// just above the withGitSync brackets it feeds): there are two ways this
// resolver gets wired --
//   1. `context.resolveMemberVcsProvider` -- an explicitly-injected resolver.
//      This tier is NOT reachable through the production entry point: every
//      real caller (bin/cli.mjs, and this harness) drives runner.js via
//      `WorkflowEngine.executeFile()`, whose `runWithContext()` always builds
//      `context` as `{ ...this._bindPrimitives(), args, budget }` (see
//      apra-fleet-workflow/src/workflow/index.mjs) -- there is no key through
//      which a caller of `executeFile()` can set `context.resolveMemberVcsProvider`
//      (or its `onAuthFailure`/`memberSessionGuard`/`ensureVcsAuthFresh`/
//      `onLlmAuthFailure` siblings); those are direct-`main()`/
//      `runSprintCycle()`-call-only injection points, exercised nowhere in
//      this suite.
//   2. `args.callTool` -- the real VCSModule.resolveProvider() lookup via
//      createMemberVcsProviderResolver, which IS reachable through
//      `executeFile()` (via the `callTool` arg this harness already
//      threads through as `args.callTool` -- see apra-fleet-eft.75.3's
//      `callTool` passthrough). This is the tier exercised below.
//
// The observable that proves the threading (not just that a self-heal fired,
// since both AUTH and UNKNOWN classifications share the same bounded
// self-heal + single-retry mechanics -- see vcs-nongithub-auth-selfheal.
// test.mjs's own note on this): a BARE Azure DevOps TF401019 failure text (no
// generic git auth tail) on the per-member G-push classifies 'auth' (not
// 'unknown') ONLY once the member's own resolved 'azure-devops' provider is
// threaded all the way from `args.callTool`'s member_detail response, through
// createMemberVcsProviderResolver, through withGitSync's
// syncMemberAfterOrdered call, to classifyGitFailure(text, provider).
// =============================================================================

// The syncMemberAfter G-push command shape is exactly `git push <remote>
// <branch>` (no `-u`) -- this pattern deliberately excludes the Publish
// step's `git push -u origin <branch>` (a different command entirely, see
// mock-sprint-publish-push-failure.test.mjs's own note on this), so this
// injection cannot accidentally reach any step but the per-dispatch G-push.
const G_PUSH_PATTERN = /^git push origin /;

// A bare TF401019 literal -- no generic git-auth tail -- so classifyFailure()
// alone would call it 'unknown'; only naming the 'azure-devops' provider
// reaches azure-devops.mjs's own TF401019 rule (apra-fleet-417.6/417.7).
const TF401019_BARE = "remote: TF401019: The Git repository with name or identifier 'core' does not exist, or you do not have permission to perform this operation.";

test('mock sprint: a member whose provider resolves to azure-devops (via args.callTool) classifies a bare G-push TF401019 failure as auth, not unknown, end to end through withGitSync', { timeout: 180000 }, async () => {
    await withScenarioMarkers('417.9 resolveMemberVcsProvider threading', async () => {
        const vcsAuthCalls = [];
        const base = defaultMockCallTool();
        const callTool = async (name, args) => {
            if (name === 'member_detail') {
                return { content: [{ text: JSON.stringify({ vcsProvider: 'azure-devops' }) }] };
            }
            if (name === 'provision_vcs_auth') {
                vcsAuthCalls.push(args);
            }
            return base(name, args);
        };

        const scenario = await runDevelopLoopScenario('417_9vcsprov', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: exercise resolveMemberVcsProvider threading through withGitSync' }],
            maxCycles: 1,
            callTool,
            gitGhFailurePattern: G_PUSH_PATTERN,
            gitGhFailureMessage: TF401019_BARE,
        });

        // The persistent (never-recovering) G-push failure surfaces as a
        // typed post-dispatch sync failure -- same shape as
        // mock-sprint-planner-dpush-failure-no-redispatch.test.mjs's D-push
        // equivalent -- rather than hanging or silently succeeding.
        check(scenario.error, `expected the persistently-failing G-push to surface as a sync error, got no error at all. logs: ${JSON.stringify(scenario.logs.slice(-30))}`);

        // THE acceptance criterion: the bare TF401019 literal classifies
        // 'auth', not 'unknown', once the member's azure-devops provider is
        // resolved via args.callTool -> createMemberVcsProviderResolver ->
        // withGitSync's resolveMemberVcsProvider -> syncMemberAfterOrdered ->
        // classifyGitFailure(text, provider).
        check(
            scenario.logs.some((l) => /auth git failure for member 'local'/.test(l)),
            `expected an 'auth git failure' log line for member 'local' (provider threading must classify auth, not unknown), got logs: ${JSON.stringify(scenario.logs.filter((l) => /git failure/.test(l)))}`,
        );
        check(
            !scenario.logs.some((l) => /unknown git failure for member 'local'/.test(l)),
            `must NOT classify unknown once the member's azure-devops provider is resolved end to end, got logs: ${JSON.stringify(scenario.logs.filter((l) => /git failure/.test(l)))}`,
        );

        // The self-heal (provision_vcs_auth) fired for the classified auth
        // failure -- proving the whole chain (not just the log line) reached
        // the real onAuthFailure callback.
        check(
            vcsAuthCalls.some((c) => c && c.member_name === 'local'),
            `expected a provision_vcs_auth self-heal call for member 'local', got: ${JSON.stringify(vcsAuthCalls)}`,
        );
    });
});
