import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilities } from '../fleet-sprint/vcs-module.mjs';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-eft.64.2: pin apra-fleet-eft.64/64.1's fix -- a non-hosted
// (`file://`) git 'origin' remote must never route the Publish PR step
// through `gh pr create` (which would hard-fail on 'gh auth login required'
// in exactly the sandbox integ-test-playbook.md wires up: a bare file://
// mirror with no gh auth/GH_TOKEN provisioned). Instead the target issue is
// closed directly once the sprint's own final verdict is PASS, and the
// sprint reaches a successful terminal state with no gh dependency at all.
//
// A companion scenario pins the opposite: a hosted GitHub remote (the
// default `originUrl` in mock-sprint-harness.mjs) must still route through
// `gh pr create` unchanged -- this guards against a regression that
// over-corrects and skips PR creation unconditionally.
// =============================================================================

test('mock sprint: non-hosted (file://) origin remote skips PR creation and closes the target issue directly', async () => {
    await withScenarioMarkers('filehosted', async () => {
        console.log('Running mock sprint scenario (non-hosted file:// origin remote)...');
        const fileRemoteUrl = 'file:///tmp/apra-fleet-eft64-bare-mirror.git';
        const run = await runDevelopLoopScenario('filehosted', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: eft.64.2 file:// remote fixture' }],
            maxCycles: 1,
            originUrl: fileRemoteUrl,
        });

        check(!run.error, `Scenario against a non-hosted file:// remote should not throw: ${run.error ? `${run.error.constructor.name}: ${run.error.message}` : ''}`);
        check(
            run.result && run.result.status === 'success',
            `Sprint should reach a successful terminal state against a non-hosted remote, got: ${JSON.stringify(run.result)}`
        );

        // The classification probe still runs (it is what decides the remote
        // is non-hosted in the first place)...
        check(
            run.commandLog.includes('git remote get-url origin'),
            `Expected the origin-remote classification probe to be dispatched, commandLog: ${JSON.stringify(run.commandLog)}`
        );
        // ...but no `gh` command of ANY kind is ever dispatched -- proof this
        // path has no dependency on gh auth / GH_TOKEN.
        check(
            !run.commandLog.some((c) => /^gh\s/.test(c)),
            `Expected NO 'gh' command to be dispatched against a non-hosted remote, commandLog: ${JSON.stringify(run.commandLog)}`
        );

        // The target/canary issue (the sprint's epic bead, target_issue) is
        // closed DIRECTLY (no PR gate) once the final verdict is PASS.
        check(
            run.commandLog.includes(`bd close ${run.epicBeadId}`),
            `Expected the target issue to be closed directly via 'bd close ${run.epicBeadId}', commandLog: ${JSON.stringify(run.commandLog)}`
        );
        const epicBead = run.finalBeadsById.get(run.epicBeadId);
        check(
            !!epicBead && epicBead.status === 'closed',
            `Expected the target/epic bead to be closed at end of sprint, got: ${JSON.stringify(epicBead)}`
        );

        check(
            run.logs.some((m) => m.includes('is not a gh-hostable GitHub remote') && m.includes('skipping PR creation entirely')),
            `Expected a logged message noting PR creation was skipped for the non-hosted remote, logs: ${JSON.stringify(run.logs)}`
        );
        check(
            run.logs.some((m) => m.includes(`closed target issue '${run.epicBeadId}' directly`)),
            `Expected a logged message noting the target issue was closed directly, logs: ${JSON.stringify(run.logs)}`
        );
    });
});

test('mock sprint: hosted GitHub origin remote still routes through PR creation (companion to the non-hosted fixture)', async () => {
    await withScenarioMarkers('hostedremote', async () => {
        console.log('Running mock sprint scenario (hosted GitHub origin remote)...');
        // No `originUrl` override -- mock-sprint-harness.mjs's default is a
        // hosted 'https://github.com/...' URL (see buildMockFleetApi's
        // `originUrl` option comment).
        const run = await runDevelopLoopScenario('hostedremote', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: eft.64.2 hosted-remote fixture' }],
            maxCycles: 1,
        });

        check(!run.error, `Scenario against a hosted GitHub remote should not throw: ${run.error ? `${run.error.constructor.name}: ${run.error.message}` : ''}`);
        check(
            run.result && run.result.status === 'success',
            `Sprint should reach a successful terminal state against a hosted remote, got: ${JSON.stringify(run.result)}`
        );

        check(
            run.commandLog.includes('git remote get-url origin'),
            `Expected the origin-remote classification probe to be dispatched, commandLog: ${JSON.stringify(run.commandLog)}`
        );
        check(
            run.commandLog.some((c) => /^curl -sS -X POST\b/.test(c) && /\/pulls\b/.test(c) && c.includes(`"head":"${run.branch}"`)),
            `Expected VCSModule's PR-create curl command to still be dispatched for the hosted remote, commandLog: ${JSON.stringify(run.commandLog)}`
        );

        // The target/epic bead must NOT be closed directly (the only `bd
        // close <id>` call in runner.js's Publish PR step is on the
        // non-hosted path) -- closure on the hosted path is gated on a human
        // merging the PR, not this direct-close shortcut.
        check(
            !run.commandLog.includes(`bd close ${run.epicBeadId}`),
            `Did not expect the target issue to be closed directly on the hosted-remote path, commandLog: ${JSON.stringify(run.commandLog)}`
        );
    });
});

// apra-fleet-eft.64.4: closure on the non-hosted path must stay gated on the
// sprint's OWN final verdict, exactly like the hosted (`gh pr create`) path
// already is -- a FAIL verdict must never be silently masked into a closed
// canary just because the remote happened to be non-hosted. This pins the
// `else` branch of the `if (finalVerdictResult.verdict === 'PASS')` gate
// (runner.js's Publish PR step, ~line 7207): no `bd close` is dispatched and
// the target/epic bead is left OPEN.
test('mock sprint: non-hosted (file://) origin remote with a FAIL verdict leaves the target issue OPEN (closure not masked)', async () => {
    await withScenarioMarkers('filehostedfail', async () => {
        console.log('Running mock sprint scenario (non-hosted file:// origin remote, FAIL verdict)...');
        const fileRemoteUrl = 'file:///tmp/apra-fleet-eft64-bare-mirror-fail.git';
        const run = await runDevelopLoopScenario('filehostedfail', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: eft.64.4 file:// remote + FAIL verdict fixture' }],
            maxCycles: 1,
            originUrl: fileRemoteUrl,
            finalReviewHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'FAIL', notes: 'Explicit test-injected FAIL for the eft.64.4 non-hosted-remote regression check.' }) }]
            }),
        });

        check(!run.error, `Scenario against a non-hosted file:// remote with a FAIL verdict should not throw: ${run.error ? `${run.error.constructor.name}: ${run.error.message}` : ''}`);
        check(
            run.result && run.result.status === 'failed',
            `Sprint should reach a 'failed' terminal state on a FAIL verdict, got: ${JSON.stringify(run.result)}`
        );

        // Still no `gh` dependency on this path at all, PASS or FAIL.
        check(
            !run.commandLog.some((c) => /^gh\s/.test(c)),
            `Expected NO 'gh' command to be dispatched against a non-hosted remote, commandLog: ${JSON.stringify(run.commandLog)}`
        );

        // The key regression guard: no direct `bd close` on a FAIL verdict.
        check(
            !run.commandLog.includes(`bd close ${run.epicBeadId}`),
            `Did not expect the target issue to be closed directly on a FAIL verdict, commandLog: ${JSON.stringify(run.commandLog)}`
        );
        const epicBead = run.finalBeadsById.get(run.epicBeadId);
        check(
            !!epicBead && epicBead.status !== 'closed',
            `Expected the target/epic bead to remain OPEN (not closed) on a FAIL verdict, got: ${JSON.stringify(epicBead)}`
        );

        check(
            run.logs.some((m) => m.includes('final verdict is FAIL') && m.includes('leaving target issue(s) open')),
            `Expected a logged message noting closure was skipped for the FAIL verdict, logs: ${JSON.stringify(run.logs)}`
        );
    });
});

// -----------------------------------------------------------------------
// VCSModule.capabilities() unit cases (apra-fleet-647.1.4.1, superseding the
// former isHostedGithubRemote() cases from apra-fleet-eft.64.4): pin the pure
// classifier's documented input classes directly, independent of the full
// mock-sprint scenario harness above. A fuller capabilities() table
// (GitHub Enterprise, Azure DevOps, GitLab, ...) lives in the dedicated
// VCSModule test suite (apra-fleet-647.1.4.2); these cases just pin the two
// runner.js call sites' preserved behavior.
// -----------------------------------------------------------------------
test('capabilities: classifies a plain file:// bare mirror as hasRemote but not PR-capable', () => {
    assert.deepEqual(
        capabilities('file:///tmp/some-bare-mirror.git'),
        { hasRemote: true, canOpenPullRequest: false, host: null }
    );
});

test('capabilities: classifies an https://github.com/... URL as PR-capable', () => {
    assert.equal(capabilities('https://github.com/mock-org/mock-repo.git').canOpenPullRequest, true);
    // With an embedded username (https://user@github.com/...) too.
    assert.equal(capabilities('https://x-access-token@github.com/mock-org/mock-repo.git').canOpenPullRequest, true);
});

test('capabilities: classifies a git@github.com:... SSH-shorthand URL as PR-capable', () => {
    assert.equal(capabilities('git@github.com:mock-org/mock-repo.git').canOpenPullRequest, true);
    assert.equal(capabilities('ssh://git@github.com/mock-org/mock-repo.git').canOpenPullRequest, true);
});

test('capabilities: fails closed to hasRemote:false/canOpenPullRequest:false for an empty/unresolvable remote', () => {
    assert.deepEqual(capabilities(''), { hasRemote: false, canOpenPullRequest: false, host: null });
    assert.deepEqual(capabilities(undefined), { hasRemote: false, canOpenPullRequest: false, host: null });
    assert.deepEqual(capabilities(null), { hasRemote: false, canOpenPullRequest: false, host: null });
    // A resolvable-but-non-GitHub host (e.g. a self-hosted GitLab) has a
    // remote but is not PR-capable, per GenericGitVCS's catch-all.
    const gitlab = capabilities('https://gitlab.example.com/mock-org/mock-repo.git');
    assert.equal(gitlab.hasRemote, true);
    assert.equal(gitlab.canOpenPullRequest, false);
    assert.equal(gitlab.host, 'gitlab.example.com');
});
