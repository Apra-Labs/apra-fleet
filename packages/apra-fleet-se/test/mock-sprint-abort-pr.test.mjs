import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import { finalizeAbort } from '../auto-sprint/runner.js';
import { SprintPlanRejectedError } from '../auto-sprint/errors.mjs';
import {
    setup,
    teardown,
    buildMockFleetApi,
    runOnce,
    runDevelopLoopScenario,
    withScenarioMarkers,
} from './helpers/mock-sprint-harness.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-eft.1.3 -- abort-PR paths: commits-exist, zero-commit, and PR
// idempotency.
//
// finalizeAbort() (apra-fleet-eft.1, runner.js) is deliberately
// dependency-injected on `command`/`log` (rather than closed over a live
// sprint `context`) specifically so it can be exercised HERE, directly,
// with a hand-rolled mock `command` -- no live fleet, no real `gh` binary,
// no network, and no need to spin up a full mock sprint run through
// WorkflowEngine just to reach the abort path. See finalizeAbort()'s own
// doc comment in runner.js for this exact rationale.
//
// Cases (a)-(c) below call finalizeAbort() directly. Case (b) is
// additionally exercised at the `main()`/full-engine level (below) to
// prove the terminal history record itself is actually published -- that
// part of the contract lives in main()'s catch site, not in finalizeAbort()
// itself, so it cannot be observed via a direct finalizeAbort() call alone.
// Case (d) is a regression check that the ordinary PASS/FAIL Publish PR
// step (a separate code path in runSprintCycle) is unaffected by this work.
// =============================================================================

// Builds a minimal, hermetic mock `command(cmd, opts)` for finalizeAbort()'s
// three call sites (`git rev-list --count`, `git push`, `gh pr create`).
// Mirrors the exact return-value CONTRACT finalizeAbort() actually relies on
// (see FleetWorkflow.command() in apra-fleet-workflow/src/workflow/index.mjs):
// a non-failSoft call (rev-list, push) resolves to a plain string (or throws
// on failure); a failSoft call (gh pr create) resolves to
// `{ ok, output, error }` and never throws.
function buildMockCommand({ commitCount, pushShouldFail = false, ghOutcome = 'created', ghUrl = 'https://github.com/mock-org/mock-repo/pull/99' } = {}) {
    const log = [];
    const command = async (cmd) => {
        log.push(cmd);
        if (/^git rev-list --count\b/.test(cmd)) {
            return String(commitCount);
        }
        if (/^git push\b/.test(cmd)) {
            if (pushShouldFail) {
                throw new Error('mock git push failure: fatal: unable to access remote');
            }
            return 'To mock-remote\n * [new branch] (mocked)';
        }
        if (/^gh pr create\b/.test(cmd)) {
            if (ghOutcome === 'already-exists') {
                return {
                    ok: false,
                    output: '',
                    error: `GraphQL: a pull request for branch already exists: ${ghUrl} (createPullRequest)`,
                };
            }
            return { ok: true, output: `${ghUrl}\n`, error: null };
        }
        throw new Error(`buildMockCommand: unexpected command dispatched in this scenario: '${cmd}'`);
    };
    return { command, log };
}

// -----------------------------------------------------------------------
// (a) commits exist -> branch pushed and an Auto-sprint [ABORTED] PR is
// created, with the triggering error's evidence embedded in the PR body.
// -----------------------------------------------------------------------
test('finalizeAbort: >=1 commit beyond base -> branch pushed and [ABORTED] PR created with error evidence in body', async () => {
    const branch = 'auto-sprint/abort-commits-exist';
    const { command, log } = buildMockCommand({
        commitCount: 2,
        ghOutcome: 'created',
        ghUrl: 'https://github.com/mock-org/mock-repo/pull/101',
    });
    const logs = [];
    const error = new SprintPlanRejectedError('Plan rejected after 3 rounds', {
        notes: 'The DAG is still missing a documentation task.',
        cycle: 1,
        planningRounds: 3,
    });

    const result = await finalizeAbort({
        error,
        branch,
        baseBranch: 'main',
        member: 'local',
        command,
        log: (m) => logs.push(m),
    });

    check(result.commitCount === 2, `Expected commitCount 2, got: ${JSON.stringify(result)}`);
    check(result.pushed === true, `Expected pushed:true when the branch carries real commits, got: ${JSON.stringify(result)}`);
    check(result.reason === 'aborted-pr-created', `Expected reason 'aborted-pr-created', got: ${JSON.stringify(result)}`);
    check(result.prUrl === 'https://github.com/mock-org/mock-repo/pull/101', `Expected the created PR's URL to be surfaced, got: ${JSON.stringify(result)}`);

    check(
        log.some((c) => c.startsWith(`git push -u origin ${branch}`)),
        `Expected a 'git push -u origin ${branch}' command to be dispatched, command log: ${JSON.stringify(log)}`
    );

    const prCmd = log.find((c) => c.startsWith('gh pr create'));
    check(!!prCmd, `Expected a 'gh pr create' command to be dispatched, command log: ${JSON.stringify(log)}`);
    check(
        prCmd.includes(`--title "Auto-sprint [ABORTED]: ${branch}"`),
        `Expected the [ABORTED] PR title prefix to appear EXACTLY, got: ${prCmd}`
    );
    check(
        prCmd.includes('--base "main"') && prCmd.includes(`--head "${branch}"`),
        `Expected the PR to target base 'main' from head '${branch}', got: ${prCmd}`
    );
    check(
        prCmd.includes('Error code: SPRINT_PLAN_REJECTED'),
        `Expected the triggering error's code to be embedded in the PR body, got: ${prCmd}`
    );
    check(
        prCmd.includes('Error message: Plan rejected after 3 rounds'),
        `Expected the triggering error's message to be embedded in the PR body, got: ${prCmd}`
    );
    check(
        prCmd.includes('Do NOT auto-merge'),
        `Expected the PR body to carry the do-not-auto-merge notice (pm skill R12), got: ${prCmd}`
    );
});

// -----------------------------------------------------------------------
// (b) same abort, but zero commits beyond base -> no `gh pr create` call at
// all (a zero-commit-abort is not worth an empty-diff PR).
// -----------------------------------------------------------------------
test('finalizeAbort: 0 commits beyond base -> no gh pr create call, zero-commit-abort reason', async () => {
    const branch = 'auto-sprint/abort-zero-commits';
    const { command, log } = buildMockCommand({ commitCount: 0 });
    const logs = [];
    const error = new SprintPlanRejectedError('Plan rejected after 3 rounds', { notes: null });

    const result = await finalizeAbort({
        error,
        branch,
        baseBranch: 'main',
        member: 'local',
        command,
        log: (m) => logs.push(m),
    });

    check(result.commitCount === 0, `Expected commitCount 0, got: ${JSON.stringify(result)}`);
    check(result.pushed === false, `Expected pushed:false for a zero-commit abort, got: ${JSON.stringify(result)}`);
    check(result.prUrl === null, `Expected prUrl:null for a zero-commit abort, got: ${JSON.stringify(result)}`);
    check(result.reason === 'zero-commit-abort', `Expected reason 'zero-commit-abort', got: ${JSON.stringify(result)}`);

    check(!log.some((c) => c.startsWith('git push')), `Expected NO 'git push' call for a zero-commit abort, command log: ${JSON.stringify(log)}`);
    check(!log.some((c) => c.startsWith('gh pr create')), `Expected NO 'gh pr create' call for a zero-commit abort, command log: ${JSON.stringify(log)}`);
    check(
        logs.some((m) => m.includes('0 commits beyond') && m.includes('no [ABORTED] PR raised')),
        `Expected a logged message explaining the zero-commit-abort policy, logs: ${JSON.stringify(logs)}`
    );
});

// -----------------------------------------------------------------------
// (b, continued) the zero-commit-abort case above is finalizeAbort()'s own
// behavior; the "a terminal history record still exists" half of the
// acceptance criterion is main()'s job (see runner.js's `main()` catch
// site). Drive an actual zero-commit sprint-abort (a plan-reviewer that
// never approves, via the SAME 'always-reject-free-text' scripted mock
// already used by mock-sprint-plan-contracts.test.mjs) through the real
// engine and assert a publishState('terminal', ...) record was emitted
// even though no PR was raised.
// -----------------------------------------------------------------------
async function runAbortTerminalRecordScenario(tag) {
    const { tempDir, epicBead } = await setup(tag);
    const dispatched = [];
    const commandLog = [];
    const states = [];
    try {
        const mockFleetApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, {
            planReviewerMode: 'always-reject-free-text',
        });
        const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
        workflow.on('state', (evt) => states.push(evt));
        const engine = new WorkflowEngine(workflow);
        const scriptPath = path.join(__dirname, '../auto-sprint/runner.js');
        const branch = `auto-sprint/mock-${tag}`;

        let error = null;
        try {
            await engine.executeFile(scriptPath, {
                target_issue: epicBead.id,
                members: ['local'],
                branch,
                base_branch: 'main',
                goal: 'P1/P2',
                max_cycles: 5,
            }, true);
        } catch (err) {
            error = err;
        }

        return { dispatched, commandLog, states, error, branch };
    } finally {
        await teardown(tempDir);
    }
}

test('mock sprint: a zero-commit sprint-abort dispatches no gh pr create but still writes a terminal history record', async () => {
    await withScenarioMarkers('abort-zero-commit-terminal-record', async () => {
        console.log('Running mock sprint scenario (zero-commit abort -> no PR, but terminal history record still written)...');
        const scenario = await runAbortTerminalRecordScenario('abortterm');

        check(!!scenario.error, 'Expected engine.executeFile() to reject on an unapproved plan');
        check(
            scenario.error instanceof SprintPlanRejectedError,
            `Expected a SprintPlanRejectedError, got: ${scenario.error ? scenario.error.constructor.name + ': ' + scenario.error.message : 'no error'}`
        );
        check(
            !scenario.dispatched.some((d) => d.agent === 'doer'),
            `Expected zero doer dispatches (no commits possible), got: ${JSON.stringify(scenario.dispatched.map((d) => d.agent))}`
        );
        check(
            !scenario.commandLog.some((c) => c.startsWith('gh pr create')),
            `Expected NO 'gh pr create' dispatch for a zero-commit abort, commandLog: ${JSON.stringify(scenario.commandLog)}`
        );

        const terminalState = scenario.states.find((e) => e.namespace === 'terminal');
        check(!!terminalState, `Expected a publishState('terminal', ...) record to have been written, states: ${JSON.stringify(scenario.states)}`);
        if (terminalState) {
            check(terminalState.data.verdict === 'ABORTED', `Expected the terminal record's verdict to be 'ABORTED', got: ${JSON.stringify(terminalState.data)}`);
            check(terminalState.data.prUrl === null, `Expected the terminal record's prUrl to be null (no PR raised), got: ${JSON.stringify(terminalState.data)}`);
            check(terminalState.data.pushed === false, `Expected the terminal record's pushed to be false, got: ${JSON.stringify(terminalState.data)}`);
            check(terminalState.data.commitCount === 0, `Expected the terminal record's commitCount to be 0, got: ${JSON.stringify(terminalState.data)}`);
            check(terminalState.data.branch === scenario.branch, `Expected the terminal record to carry the sprint branch, got: ${JSON.stringify(terminalState.data)}`);
            check(terminalState.data.baseBranch === 'main', `Expected the terminal record to carry the base branch, got: ${JSON.stringify(terminalState.data)}`);
        }
    });
});

// -----------------------------------------------------------------------
// (c) `gh pr create` returning "already exists" is swallowed (not thrown);
// the existing PR's URL is parsed out of the error text and surfaced.
// -----------------------------------------------------------------------
test('finalizeAbort: gh pr create "already exists" is swallowed, existing PR URL surfaced, no throw', async () => {
    const branch = 'auto-sprint/abort-idempotent-pr';
    const { command, log } = buildMockCommand({
        commitCount: 1,
        ghOutcome: 'already-exists',
        ghUrl: 'https://github.com/mock-org/mock-repo/pull/55',
    });
    const logs = [];
    const error = new SprintPlanRejectedError('Plan rejected after 3 rounds', { notes: null });

    let result;
    let thrown = null;
    try {
        result = await finalizeAbort({
            error,
            branch,
            baseBranch: 'main',
            member: 'local',
            command,
            log: (m) => logs.push(m),
        });
    } catch (err) {
        thrown = err;
    }

    check(thrown === null, `Expected finalizeAbort() NOT to throw on an "already exists" gh pr create failure, got: ${thrown ? thrown.message : ''}`);
    check(result.reason === 'already-exists', `Expected reason 'already-exists', got: ${JSON.stringify(result)}`);
    check(result.pushed === true, `Expected pushed:true (the branch push itself succeeded before the idempotent PR-create), got: ${JSON.stringify(result)}`);
    check(
        result.prUrl === 'https://github.com/mock-org/mock-repo/pull/55',
        `Expected the EXISTING PR's URL to be parsed out of the gh error text and surfaced, got: ${JSON.stringify(result)}`
    );
    check(
        log.some((c) => c.startsWith('gh pr create')),
        `Expected a 'gh pr create' command to still have been dispatched, command log: ${JSON.stringify(log)}`
    );
    check(
        logs.some((m) => m.includes('already exists') && m.includes('idempotent success')),
        `Expected a logged message noting the PR already exists and was treated as an idempotent success, logs: ${JSON.stringify(logs)}`
    );
});

// -----------------------------------------------------------------------
// (d) regression: the ordinary PASS/FAIL Publish PR step (runSprintCycle's
// own finalization, a separate code path from the abort-path finalizeAbort()
// above) is unaffected -- normal (non-"[ABORTED]") PRs are still raised for
// both a successful sprint and an explicit final FAIL verdict.
// -----------------------------------------------------------------------
test('regression: a successful (PASS) sprint still raises a normal, non-[ABORTED] PR', async () => {
    await withScenarioMarkers('abortprpass', async () => {
        console.log('Running mock sprint scenario (PASS/FAIL finalization regression check: PASS side)...');
        const passRun = await runOnce('abortprpass');
        check(passRun.result && passRun.result.status === 'success', `Expected the PASS regression run to succeed, got: ${JSON.stringify(passRun.result)}`);
        const prCmd = passRun.commandLog.find((c) => c.startsWith('gh pr create'));
        check(!!prCmd, `Expected a 'gh pr create' command to be dispatched, commandLog: ${JSON.stringify(passRun.commandLog)}`);
        check(!prCmd.includes('[ABORTED]'), `A successful sprint's PR must NOT carry the [ABORTED] prefix, got: ${prCmd}`);
    });
});

test('regression: an explicit final FAIL verdict still raises a normal, non-[ABORTED] PR', async () => {
    await withScenarioMarkers('abortprfail', async () => {
        console.log('Running mock sprint scenario (PASS/FAIL finalization regression check: FAIL side)...');
        const failRun = await runDevelopLoopScenario('abortprfail', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: PASS/FAIL finalization regression (FAIL side)' }],
            maxCycles: 1,
            finalReviewHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'FAIL', notes: 'Explicit test-injected FAIL for the eft.1.3 regression check.' }) }]
            }),
        });
        check(!failRun.error, `Expected the FAIL regression scenario not to throw: ${failRun.error ? failRun.error.message : ''}`);
        check(failRun.result && failRun.result.status === 'failed', `Expected a FAIL final verdict to produce status:'failed', got: ${JSON.stringify(failRun.result)}`);
        const prCmd = failRun.commandLog.find((c) => c.startsWith('gh pr create'));
        check(!!prCmd, `A FAIL verdict must still publish a PR, commandLog: ${JSON.stringify(failRun.commandLog)}`);
        check(prCmd.includes('FAIL'), `Expected the PR title/body to include the FAIL verdict, got: ${prCmd}`);
        check(!prCmd.includes('[ABORTED]'), `An ordinary FAIL-verdict PR must NOT carry the [ABORTED] prefix, got: ${prCmd}`);
    });
});
