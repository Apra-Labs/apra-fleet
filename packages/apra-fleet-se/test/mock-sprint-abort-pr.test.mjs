import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import { finalizeAbort } from '../fleet-sprint/runner.js';
import { SprintPlanRejectedError } from '../fleet-sprint/errors.mjs';
import {
    setup,
    teardown,
    buildMockFleetApi,
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
// call sites (`git fetch origin`, `git rev-list --count`, `git push`, the
// `git remote get-url origin` repo-derivation probe, the just-provisioned
// git-credential-helper token read, and the VCSModule `curl ... /pulls`
// create-pull-request dispatch -- apra-fleet-tfx.8/tfx.8.4: the `gh pr
// create` call sites are gone). Mirrors the exact return-value CONTRACT
// finalizeAbort() actually relies on (see FleetWorkflow.command() in
// apra-fleet-workflow/src/workflow/index.mjs, and note the apra-fleet-5d5.1
// update below): whether a call resolves to a plain string/throws, or to
// `{ ok, output, error }` and never throws, is driven by `opts.failSoft` --
// NOT by which git subcommand it is. The VCSModule call sites (credential
// read, curl POST, and the repo-derivation `git remote get-url origin`) are
// ALWAYS dispatched with failSoft:true (see provisionVcsAuthForMember/
// readMemberVcsCredentialToken/raiseVcsPrForMember in runner.js). As of
// apra-fleet-5d5.1, finalizeAbort()'s own fetch/rev-list/push calls are
// routed through runGitStep() (for the provision_vcs_auth self-heal-and-
// retry-once path), which itself ALWAYS forces `failSoft: true` on the
// underlying command() call -- so this mock must branch on `opts.failSoft`
// exactly as the real production command() does, rather than assuming a
// fixed shape per subcommand.
function buildMockCommand({ commitCount, pushShouldFail = false, prOutcome = 'created', prUrl = 'https://github.com/mock-org/mock-repo/pull/99' } = {}) {
    const log = [];
    const command = async (cmd, opts = {}) => {
        log.push(cmd);
        const failSoft = !!opts.failSoft;
        const ok = (output) => (failSoft ? { ok: true, output, error: null } : output);
        const fail = (error) => {
            if (failSoft) return { ok: false, output: '', error };
            throw new Error(error);
        };
        if (/^git fetch origin\b/.test(cmd)) {
            return ok('');
        }
        if (/^git rev-list --count\b/.test(cmd)) {
            return ok(String(commitCount));
        }
        if (/^git push\b/.test(cmd)) {
            if (pushShouldFail) {
                return fail('mock git push failure: fatal: unable to access remote');
            }
            return ok('To mock-remote\n * [new branch] (mocked)');
        }
        // provisionPrCapableAuthForMember (provisionVcsAuthForMember) derives
        // 'owner/repo' from this probe BEFORE minting the push+pr credential.
        if (/^git remote get-url origin\b/.test(cmd)) {
            return ok('https://github.com/mock-org/mock-repo.git');
        }
        // readMemberVcsCredentialToken reads back the just-provisioned
        // git-credential-helper script's deployed token.
        if (/^\$HOME\/\.fleet-git-credential-/.test(cmd)) {
            return ok('protocol=https\nhost=github.com\nusername=x-access-token\npassword=mock-vcs-module-token\n');
        }
        // VCSModule's buildCreatePrCommand: a curl POST to .../pulls, with
        // `-w '\n%{http_code}'` appended (see parseVcsCurlOutput in runner.js).
        if (/^curl -sS -X POST\b/.test(cmd) && /\/pulls\b/.test(cmd)) {
            if (prOutcome === 'already-exists') {
                const body = JSON.stringify({
                    message: 'Validation Failed',
                    errors: [{ message: `A pull request already exists for this branch. ${prUrl}` }],
                });
                return ok(`${body}\n422`);
            }
            const body = JSON.stringify({ number: 101, html_url: prUrl });
            return ok(`${body}\n201`);
        }
        throw new Error(`buildMockCommand: unexpected command dispatched in this scenario: '${cmd}'`);
    };
    return { command, log };
}

// apra-fleet-tfx.8.4: finalizeAbort()'s PR-raising call sites now mint a
// just-in-time push+pr credential via `callTool('provision_vcs_auth', ...)`
// (ApraFleet.provisionVcsAuth) BEFORE building/dispatching the VCSModule
// create-pull-request command -- so every scenario below that expects the PR
// to actually be raised (as opposed to the callTool-absent graceful
// degradation path, apra-fleet-tfx.8.1) must supply a working `callTool`.
// Mirrors mock-sprint-harness.mjs's defaultMockCallTool() exactly.
function mockAbortCallTool() {
    return async (name, toolArgs) => {
        // apra-fleet-647.1.2.1: provisionVcsAuthForMember resolves the
        // member's provider via VCSModule.resolveProvider() (a
        // 'member_detail' call) BEFORE every provision_vcs_auth call.
        if (name === 'member_detail') {
            return { content: [{ text: JSON.stringify({ vcsProvider: 'github' }) }] };
        }
        if (name === 'provision_vcs_auth') {
            const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            return { content: [{ text: `✅ Mock ${toolArgs && toolArgs.provider} credentials deployed on "${toolArgs && toolArgs.member_name}"\n  expiresAt: ${expiresAt}\n` }] };
        }
        return { content: [{ text: `✅ mock ${name}` }] };
    };
}

// -----------------------------------------------------------------------
// (a) commits exist -> branch pushed and an Auto-sprint [ABORTED] PR is
// created, with the triggering error's evidence embedded in the PR body.
// -----------------------------------------------------------------------
test('finalizeAbort: >=1 commit beyond base -> branch pushed and [ABORTED] PR created with error evidence in body', async () => {
    const branch = 'auto-sprint/abort-commits-exist';
    const { command, log } = buildMockCommand({
        commitCount: 2,
        prOutcome: 'created',
        prUrl: 'https://github.com/mock-org/mock-repo/pull/101',
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
        callTool: mockAbortCallTool(),
    });

    check(result.commitCount === 2, `Expected commitCount 2, got: ${JSON.stringify(result)}`);
    check(result.pushed === true, `Expected pushed:true when the branch carries real commits, got: ${JSON.stringify(result)}`);
    check(result.reason === 'aborted-pr-created', `Expected reason 'aborted-pr-created', got: ${JSON.stringify(result)}`);
    check(result.prUrl === 'https://github.com/mock-org/mock-repo/pull/101', `Expected the created PR's URL to be surfaced, got: ${JSON.stringify(result)}`);

    check(
        log.some((c) => c.startsWith(`git push -u origin ${branch}`)),
        `Expected a 'git push -u origin ${branch}' command to be dispatched, command log: ${JSON.stringify(log)}`
    );

    const prCmd = log.find((c) => c.startsWith('curl -sS -X POST') && c.includes('/pulls'));
    check(!!prCmd, `Expected a VCSModule 'curl ... /pulls' create-pull-request command to be dispatched, command log: ${JSON.stringify(log)}`);
    check(
        prCmd.includes(`"title":"Auto-sprint [ABORTED]: ${branch}"`),
        `Expected the [ABORTED] PR title prefix to appear EXACTLY in the JSON payload, got: ${prCmd}`
    );
    check(
        prCmd.includes('"base":"main"') && prCmd.includes(`"head":"${branch}"`),
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
// (b) same abort, but zero commits beyond base -> no create-pull-request
// call at all (a zero-commit-abort is not worth an empty-diff PR).
// -----------------------------------------------------------------------
test('finalizeAbort: 0 commits beyond base -> no create-pull-request call, zero-commit-abort reason', async () => {
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
        callTool: mockAbortCallTool(),
    });

    check(result.commitCount === 0, `Expected commitCount 0, got: ${JSON.stringify(result)}`);
    check(result.pushed === false, `Expected pushed:false for a zero-commit abort, got: ${JSON.stringify(result)}`);
    check(result.prUrl === null, `Expected prUrl:null for a zero-commit abort, got: ${JSON.stringify(result)}`);
    check(result.reason === 'zero-commit-abort', `Expected reason 'zero-commit-abort', got: ${JSON.stringify(result)}`);

    check(!log.some((c) => c.startsWith('git push')), `Expected NO 'git push' call for a zero-commit abort, command log: ${JSON.stringify(log)}`);
    check(!log.some((c) => c.startsWith('curl -sS -X POST') && c.includes('/pulls')), `Expected NO create-pull-request call for a zero-commit abort, command log: ${JSON.stringify(log)}`);
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
        const scriptPath = path.join(__dirname, '../fleet-sprint/runner.js');
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
            !scenario.commandLog.some((c) => c.startsWith('curl -sS -X POST') && c.includes('/pulls')),
            `Expected NO create-pull-request dispatch for a zero-commit abort, commandLog: ${JSON.stringify(scenario.commandLog)}`
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
// (c) VCSModule's create-pull-request curl call returning HTTP 422 "already
// exists" is swallowed (not thrown); the existing PR's URL is parsed out of
// the response body and surfaced.
// -----------------------------------------------------------------------
test('finalizeAbort: gh pr create "already exists" is swallowed, existing PR URL surfaced, no throw', async () => {
    const branch = 'auto-sprint/abort-idempotent-pr';
    const { command, log } = buildMockCommand({
        commitCount: 1,
        prOutcome: 'already-exists',
        prUrl: 'https://github.com/mock-org/mock-repo/pull/55',
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
            callTool: mockAbortCallTool(),
        });
    } catch (err) {
        thrown = err;
    }

    check(thrown === null, `Expected finalizeAbort() NOT to throw on an "already exists" (422) create-pull-request response, got: ${thrown ? thrown.message : ''}`);
    check(result.reason === 'already-exists', `Expected reason 'already-exists', got: ${JSON.stringify(result)}`);
    check(result.pushed === true, `Expected pushed:true (the branch push itself succeeded before the idempotent PR-create), got: ${JSON.stringify(result)}`);
    check(
        result.prUrl === 'https://github.com/mock-org/mock-repo/pull/55',
        `Expected the EXISTING PR's URL to be parsed out of the 422 response body and surfaced, got: ${JSON.stringify(result)}`
    );
    check(
        log.some((c) => c.startsWith('curl -sS -X POST') && c.includes('/pulls')),
        `Expected a VCSModule 'curl ... /pulls' create-pull-request command to still have been dispatched, command log: ${JSON.stringify(log)}`
    );
    check(
        logs.some((m) => m.includes('already exists') && m.includes('idempotent success')),
        `Expected a logged message noting the PR already exists and was treated as an idempotent success, logs: ${JSON.stringify(logs)}`
    );
});

// =============================================================================
// apra-fleet-5d5.1 -- finalizeAbort()'s own git ops (fetch/rev-list/push) now
// get the SAME provision_vcs_auth self-heal-and-retry-once treatment as the
// main withGitSync dispatch bracket (runGitStep's onAuthFailure, runner.js
// ~line 616), instead of silently swallowing a mid-abort auth failure with no
// self-heal (live: apra-fleet-l7n Cycle 3 abort hit exactly this).
//
// A tiny scripted command() mock: pass a map from cmd-substring -> a queue of
// results (each `{ ok, output, error }`). Mirrors makeCommandMock in
// git-sync-brackets.test.mjs -- finalizeAbort()'s fetch/rev-list/push calls
// now ALWAYS go through runGitStep(), which itself always forces
// `failSoft: true` on the underlying command() call, so this mock can return
// the `{ ok, output, error }` shape unconditionally (matching production's
// real command() under failSoft:true) rather than branching on opts.
// =============================================================================
function makeQueuedAbortCommandMock(script) {
    const calls = [];
    const queues = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]));
    const command = async (cmd, opts = {}) => {
        calls.push({ cmd, opts });
        for (const [key, queue] of queues) {
            if (cmd.includes(key)) {
                const next = queue.length > 1 ? queue.shift() : queue[0];
                return next;
            }
        }
        return { ok: true, output: '', error: null };
    };
    return { command, calls };
}

const QOK = (output = '') => ({ ok: true, output, error: null });
const qfail = (error) => ({ ok: false, output: '', error });

// apra-fleet-tfx.8.4: every (5d5.1) scenario below that expects finalizeAbort()
// to reach the PR-raising step (result.reason === 'aborted-pr-created') must
// answer the VCSModule call sites too -- the repo-derivation `git remote
// get-url origin` probe, the just-provisioned credential-token read, and the
// curl POST create-pull-request dispatch itself -- plus supply a `callTool`
// so the just-in-time push+pr credential mint (provision_vcs_auth) succeeds.
const VCS_MODULE_SCRIPT = (prUrl) => ({
    'git remote get-url origin': [QOK('https://github.com/mock-org/mock-repo.git')],
    '.fleet-git-credential-': [QOK('protocol=https\nhost=github.com\nusername=x-access-token\npassword=mock-vcs-module-token\n')],
    '/pulls': [QOK(`${JSON.stringify({ number: 101, html_url: prUrl })}\n201`)],
});

test('(5d5.1) an auth-classified git fetch failure heals once via onAuthFailure and the retry succeeds', async () => {
    const branch = 'auto-sprint/abort-fetch-auth-heal';
    const { command, calls } = makeQueuedAbortCommandMock({
        'git fetch origin': [
            qfail("fatal: could not read Username for 'https://github.com': Device not configured"),
            QOK(''),
        ],
        'git rev-list --count': [QOK('2')],
        'git push': [QOK('To mock-remote\n * [new branch] (mocked)')],
        ...VCS_MODULE_SCRIPT('https://github.com/mock-org/mock-repo/pull/201'),
    });
    let healCalls = 0;
    const onAuthFailure = async (info) => {
        healCalls += 1;
        check(info.member === 'local', 'onAuthFailure receives the member');
        check(/could not read Username/.test(info.error), 'onAuthFailure receives the raw error text');
    };

    const result = await finalizeAbort({
        error: new SprintPlanRejectedError('Plan rejected', { notes: null }),
        branch,
        baseBranch: 'main',
        member: 'local',
        command,
        onAuthFailure,
        callTool: mockAbortCallTool(),
    });

    check(result.reason === 'aborted-pr-created', `expected the abort to still complete successfully after self-heal, got: ${JSON.stringify(result)}`);
    check(healCalls === 1, `expected exactly one self-heal call, got ${healCalls}`);
    check(
        calls.filter((c) => c.cmd.startsWith('git fetch origin')).length === 2,
        `expected fetch retried exactly once after self-heal (bounded, not a loop), saw ${calls.filter((c) => c.cmd.startsWith('git fetch origin')).length}`,
    );
});

test('(5d5.1) an auth-classified git push failure heals once via onAuthFailure and the retry succeeds', async () => {
    const branch = 'auto-sprint/abort-push-auth-heal';
    const { command, calls } = makeQueuedAbortCommandMock({
        'git fetch origin': [QOK('')],
        'git rev-list --count': [QOK('3')],
        'git push': [
            qfail('remote: Invalid username or token.'),
            QOK('To mock-remote\n * [new branch] (mocked)'),
        ],
        ...VCS_MODULE_SCRIPT('https://github.com/mock-org/mock-repo/pull/202'),
    });
    let healCalls = 0;
    const onAuthFailure = async () => { healCalls += 1; };

    const result = await finalizeAbort({
        error: new SprintPlanRejectedError('Plan rejected', { notes: null }),
        branch,
        baseBranch: 'main',
        member: 'local',
        command,
        onAuthFailure,
        callTool: mockAbortCallTool(),
    });

    check(result.reason === 'aborted-pr-created', `expected the abort to still complete successfully after self-heal, got: ${JSON.stringify(result)}`);
    check(result.pushed === true, `expected pushed:true once the retried push succeeds, got: ${JSON.stringify(result)}`);
    check(healCalls === 1, `expected exactly one self-heal call, got ${healCalls}`);
    check(
        calls.filter((c) => c.cmd.startsWith('git push')).length === 2,
        `expected push retried exactly once after self-heal, saw ${calls.filter((c) => c.cmd.startsWith('git push')).length}`,
    );
});

test('(5d5.1) self-heal invoked but the retry STILL fails: finalizeAbort() still throws (falls back to the existing "no PR lookup" log path), self-heal called exactly once, no infinite loop', async () => {
    const branch = 'auto-sprint/abort-push-auth-still-fails';
    const { command, calls } = makeQueuedAbortCommandMock({
        'git fetch origin': [QOK('')],
        'git rev-list --count': [QOK('1')],
        // Single-entry queue -> makeQueuedAbortCommandMock returns the same
        // failure on every call, so both the first attempt and the post-heal
        // retry fail identically.
        'git push': [qfail('remote: Invalid username or token.')],
    });
    let healCalls = 0;
    const onAuthFailure = async () => { healCalls += 1; };

    let thrown = null;
    try {
        await finalizeAbort({
            error: new SprintPlanRejectedError('Plan rejected', { notes: null }),
            branch,
            baseBranch: 'main',
            member: 'local',
            command,
            onAuthFailure,
        });
    } catch (e) {
        thrown = e;
    }

    check(thrown !== null, 'expected finalizeAbort() to throw when the retry after self-heal still fails');
    check(/git push/.test(thrown.message), `expected the thrown error to name the failing git push, got: ${thrown.message}`);
    check(healCalls === 1, `self-heal must be invoked EXACTLY ONCE (bounded, never a loop), got ${healCalls}`);
    check(
        calls.filter((c) => c.cmd.startsWith('git push')).length === 2,
        `expected exactly one bounded retry after self-heal (2 total push attempts), saw ${calls.filter((c) => c.cmd.startsWith('git push')).length}`,
    );
});

test('(5d5.1) omitting onAuthFailure preserves the pre-existing throw-on-auth-failure behavior (no heal, single attempt)', async () => {
    const branch = 'auto-sprint/abort-push-auth-no-heal-wired';
    const { command, calls } = makeQueuedAbortCommandMock({
        'git fetch origin': [QOK('')],
        'git rev-list --count': [QOK('1')],
        'git push': [qfail('remote: Invalid username or token.')],
    });

    let thrown = null;
    try {
        await finalizeAbort({
            error: new SprintPlanRejectedError('Plan rejected', { notes: null }),
            branch,
            baseBranch: 'main',
            member: 'local',
            command, // no onAuthFailure injected
        });
    } catch (e) {
        thrown = e;
    }

    check(thrown !== null, 'expected finalizeAbort() to still throw on an auth failure with no self-heal wired');
    check(
        calls.filter((c) => c.cmd.startsWith('git push')).length === 1,
        `no self-heal retry may occur when onAuthFailure is not provided -- expected a single push attempt, saw ${calls.filter((c) => c.cmd.startsWith('git push')).length}`,
    );
});

test('(5d5.1) the happy path (git ops succeed first try) is unaffected -- no self-heal call at all', async () => {
    const branch = 'auto-sprint/abort-happy-path-unaffected';
    const { command, calls } = makeQueuedAbortCommandMock({
        'git fetch origin': [QOK('')],
        'git rev-list --count': [QOK('2')],
        'git push': [QOK('To mock-remote\n * [new branch] (mocked)')],
        ...VCS_MODULE_SCRIPT('https://github.com/mock-org/mock-repo/pull/203'),
    });
    let healCalls = 0;
    const onAuthFailure = async () => { healCalls += 1; };

    const result = await finalizeAbort({
        error: new SprintPlanRejectedError('Plan rejected', { notes: null }),
        branch,
        baseBranch: 'main',
        member: 'local',
        command,
        onAuthFailure,
        callTool: mockAbortCallTool(),
    });

    check(result.reason === 'aborted-pr-created', `expected a normal successful abort, got: ${JSON.stringify(result)}`);
    check(healCalls === 0, `expected NO self-heal call on the happy path, got ${healCalls}`);
    check(calls.filter((c) => c.cmd.startsWith('git fetch origin')).length === 1, 'fetch dispatched exactly once');
    check(calls.filter((c) => c.cmd.startsWith('git push')).length === 1, 'push dispatched exactly once');
});

// =============================================================================
// apra-fleet-647.1.1.1 -- REACTIVE auth self-heal for the two VCSModule PR
// call sites (raiseVcsPrForMember, shared by finalizeAbort's [ABORTED] PR and
// the ordinary Publish PR step). On an auth-classified PR response (401, 403,
// or a 404 whose body explains a token-scope refusal) the PR call site now
// re-provisions a push+pr credential (provisionPrCapableAuthForMember) and
// retries the SAME create-pull-request command exactly once, mirroring the
// bounded runGitStep/runDoltStep onAuthFailure semantics. A non-auth PR
// failure (422 already-exists, 5xx, malformed) is untouched.
// =============================================================================

// Like buildMockCommand above, but the `/pulls` create-pull-request response
// and the deployed credential token are each drawn from their own queue (one
// entry consumed per successive call; the last entry repeats once exhausted),
// so a scenario can script "first attempt fails, retry succeeds" or "both
// attempts fail identically". `pullsQueue` entries are raw curl stdout
// (`"<json body>\n<status>"`, matching parseVcsCurlOutput's contract).
function buildMockCommandForPrRetry({ commitCount = 1, pullsQueue, credQueue } = {}) {
    const log = [];
    let pullsCallIndex = 0;
    let credCallIndex = 0;
    const command = async (cmd, opts = {}) => {
        log.push(cmd);
        const failSoft = !!opts.failSoft;
        const ok = (output) => (failSoft ? { ok: true, output, error: null } : output);
        const fail = (error) => {
            if (failSoft) return { ok: false, output: '', error };
            throw new Error(error);
        };
        if (/^git fetch origin\b/.test(cmd)) return ok('');
        if (/^git rev-list --count\b/.test(cmd)) return ok(String(commitCount));
        if (/^git push\b/.test(cmd)) return ok('To mock-remote\n * [new branch] (mocked)');
        if (/^git remote get-url origin\b/.test(cmd)) return ok('https://github.com/mock-org/mock-repo.git');
        if (/^\$HOME\/\.fleet-git-credential-/.test(cmd)) {
            const queue = credQueue || ['protocol=https\nhost=github.com\nusername=x-access-token\npassword=mock-vcs-module-token\n'];
            const idx = Math.min(credCallIndex, queue.length - 1);
            credCallIndex += 1;
            return ok(queue[idx]);
        }
        if (/^curl -sS -X POST\b/.test(cmd) && /\/pulls\b/.test(cmd)) {
            const idx = Math.min(pullsCallIndex, pullsQueue.length - 1);
            pullsCallIndex += 1;
            return ok(pullsQueue[idx]);
        }
        return fail(`buildMockCommandForPrRetry: unexpected command dispatched in this scenario: '${cmd}'`);
    };
    return { command, log };
}

function mockAbortCallToolCounting() {
    let provisionVcsAuthCalls = 0;
    const callTool = async (name, toolArgs) => {
        if (name === 'member_detail') {
            return { content: [{ text: JSON.stringify({ vcsProvider: 'github' }) }] };
        }
        if (name === 'provision_vcs_auth') {
            provisionVcsAuthCalls += 1;
            const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            return { content: [{ text: `✅ Mock ${toolArgs && toolArgs.provider} credentials deployed on "${toolArgs && toolArgs.member_name}"\n  expiresAt: ${expiresAt}\n` }] };
        }
        return { content: [{ text: `✅ mock ${name}` }] };
    };
    return { callTool, counts: () => ({ provisionVcsAuthCalls }) };
}

const PR_401_BODY = `${JSON.stringify({ message: 'Bad credentials' })}\n401`;
const PR_403_BODY = `${JSON.stringify({ message: 'Resource not accessible by integration' })}\n403`;
const PR_500_BODY = `${JSON.stringify({ message: 'Internal Server Error' })}\n500`;
const PR_SUCCESS_BODY = (prUrl) => `${JSON.stringify({ number: 101, html_url: prUrl })}\n201`;

test('(647.1.1.1) finalizeAbort PR call: a 401 heals once via provision_vcs_auth and the retry succeeds', async () => {
    const branch = 'auto-sprint/abort-pr-401-heal';
    const prUrl = 'https://github.com/mock-org/mock-repo/pull/301';
    const { command, log } = buildMockCommandForPrRetry({
        commitCount: 1,
        pullsQueue: [PR_401_BODY, PR_SUCCESS_BODY(prUrl)],
    });
    const { callTool, counts } = mockAbortCallToolCounting();
    const logs = [];

    const result = await finalizeAbort({
        error: new SprintPlanRejectedError('Plan rejected', { notes: null }),
        branch,
        baseBranch: 'main',
        member: 'local',
        command,
        log: (m) => logs.push(m),
        callTool,
    });

    check(result.reason === 'aborted-pr-created', `expected the abort PR to succeed after the reactive self-heal retry, got: ${JSON.stringify(result)}`);
    check(result.prUrl === prUrl, `expected the retried PR's URL to be returned, got: ${JSON.stringify(result)}`);
    check(counts().provisionVcsAuthCalls === 2, `expected provision_vcs_auth called twice (initial JIT mint + one reactive heal), got ${counts().provisionVcsAuthCalls}`);
    check(log.filter((c) => c.startsWith('curl -sS -X POST') && c.includes('/pulls')).length === 2, `expected the create-pull-request curl dispatched exactly twice (original + one bounded retry), command log: ${JSON.stringify(log)}`);
    check(logs.some((m) => m.includes('auth-classified failure') && m.includes('HTTP 401')), `expected a logged auth-classified-failure message naming HTTP 401, logs: ${JSON.stringify(logs)}`);
    check(!logs.some((m) => m.includes('mock-vcs-module-token')), `no log line may ever carry the raw token, logs: ${JSON.stringify(logs)}`);
});

test('(647.1.1.1) finalizeAbort PR call: a 403 that still fails after the retry is degraded/logged, NOT thrown out of finalizeAbort', async () => {
    const branch = 'auto-sprint/abort-pr-403-still-fails';
    const { command, log } = buildMockCommandForPrRetry({
        commitCount: 1,
        pullsQueue: [PR_403_BODY], // repeats -- both attempts fail identically
    });
    const { callTool, counts } = mockAbortCallToolCounting();
    const logs = [];

    let thrown = null;
    let result = null;
    try {
        result = await finalizeAbort({
            error: new SprintPlanRejectedError('Plan rejected', { notes: null }),
            branch,
            baseBranch: 'main',
            member: 'local',
            command,
            log: (m) => logs.push(m),
            callTool,
        });
    } catch (e) {
        thrown = e;
    }

    check(thrown === null, `expected finalizeAbort() NOT to throw on a PR auth failure that survives the retry, got: ${thrown ? thrown.message : ''}`);
    check(result !== null && result.reason === 'pr-auth-failed', `expected a degraded 'pr-auth-failed' reason, got: ${JSON.stringify(result)}`);
    check(result.pushed === true, `expected pushed:true -- the branch push already succeeded before the PR attempt, got: ${JSON.stringify(result)}`);
    check(result.prUrl === null, `expected prUrl:null since the PR itself was never raised, got: ${JSON.stringify(result)}`);
    check(counts().provisionVcsAuthCalls === 2, `expected exactly one reactive heal attempt (2 total provision_vcs_auth calls: JIT mint + one heal), got ${counts().provisionVcsAuthCalls}`);
    check(log.filter((c) => c.startsWith('curl -sS -X POST') && c.includes('/pulls')).length === 2, `expected exactly one bounded retry (2 total create-pull-request attempts), command log: ${JSON.stringify(log)}`);
    check(logs.some((m) => m.includes('degrading') || m.includes('degraded')), `expected a logged message noting the degrade-not-throw outcome, logs: ${JSON.stringify(logs)}`);
});

test('(647.1.1.1) finalizeAbort PR call: a non-auth failure (5xx) keeps today\'s throw-CommandError behavior exactly, with no self-heal call', async () => {
    const branch = 'auto-sprint/abort-pr-5xx-no-heal';
    const { command, log } = buildMockCommandForPrRetry({
        commitCount: 1,
        pullsQueue: [PR_500_BODY],
    });
    const { callTool, counts } = mockAbortCallToolCounting();

    let thrown = null;
    try {
        await finalizeAbort({
            error: new SprintPlanRejectedError('Plan rejected', { notes: null }),
            branch,
            baseBranch: 'main',
            member: 'local',
            command,
            callTool,
        });
    } catch (e) {
        thrown = e;
    }

    check(thrown !== null, 'expected finalizeAbort() to still throw a CommandError for a non-auth (5xx) PR failure');
    check(/Publish Abort PR Failed/.test(thrown.message), `expected the existing '[Publish Abort PR Failed]' message, got: ${thrown.message}`);
    check(counts().provisionVcsAuthCalls === 1, `expected NO reactive heal for a non-auth failure -- only the initial JIT mint, got ${counts().provisionVcsAuthCalls} provision_vcs_auth calls`);
    check(log.filter((c) => c.startsWith('curl -sS -X POST') && c.includes('/pulls')).length === 1, `expected the create-pull-request curl dispatched exactly once (no retry for a non-auth failure), command log: ${JSON.stringify(log)}`);
});
