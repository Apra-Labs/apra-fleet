import { test } from 'node:test';
import assert from 'node:assert/strict';

import { finalizeAbort, createVcsAuthPreflightCallback } from '../fleet-sprint/runner.js';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-647.1.1.3 -- simulated auth failure at the two PR-raising call
// sites (Publish PR, finalizeAbort) proves the reactive self-heal
// (apra-fleet-647.1.1.1) actually recovers a 401, and that a non-auth PR
// failure (422 already-exists, 500) never triggers a spurious re-provision.
// Also pins that the read-side proactive preflight (apra-fleet-647.1.1.2)
// logs its line, and that no captured log line anywhere in this suite ever
// carries the raw VCS credential token.
//
// PASS/FAIL contract (per the bead): reverting either apra-fleet-647.1.1.1
// (the raiseVcsPrForMember reactive self-heal) or apra-fleet-647.1.1.2 (the
// needsVcsAuth-gated proactive preflight) must fail at least one assertion
// in this file.
//
// The RAW TOKEN NEVER IN A LOG assertion is checked against every scenario's
// `logs` array below (the FleetWorkflow 'log' event stream a real sprint run
// actually emits) -- deliberately NOT against `commandLog`/the raw command()
// dispatch text, which necessarily carries the live token in its
// Authorization header (see vcs-module.mjs's own token-safety invariant:
// `command` is dispatched, never logged; `logSafeCommand`, with the token
// redacted, is what's used in log()).
// =============================================================================

const RAW_PR_TOKEN = 'mock-vcs-module-pr-token';

function assertNoRawTokenInLogs(logs, token = RAW_PR_TOKEN) {
    check(
        !logs.some((l) => l.includes(token)),
        `expected NO captured log line to contain the raw VCS token '${token}', got: ${JSON.stringify(logs.filter((l) => l.includes(token)))}`,
    );
}

// -----------------------------------------------------------------------
// Assertion 1: Publish-PR path -- first curl returns 401, exactly one
// provision_vcs_auth self-heal call, one retry, the PR succeeds and the
// sprint completes.
// -----------------------------------------------------------------------
test('Publish-PR path: a 401 on the first PR-create call triggers exactly one self-heal provision_vcs_auth + one retry, then succeeds', async () => {
    await withScenarioMarkers('pr401selfheal', async () => {
        const provisionCalls = [];
        const callTool = async (name, args) => {
            if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider: 'github' }) }] };
            if (name === 'provision_vcs_auth') {
                provisionCalls.push(args);
                const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
                return { content: [{ text: `check-mark Mock ${args.provider} credentials deployed on "${args.member_name}"\n  expiresAt: ${expiresAt}\n` }] };
            }
            if (name === 'child_id_allocator') {
                return { content: [{ text: JSON.stringify(args && args.action === 'allocate' ? { childId: null, token: null } : { confirmed: true, released: true }) }] };
            }
            if (name === 'dolt_push_mutex') {
                return { content: [{ text: JSON.stringify(args && args.action === 'acquire' ? { granted: true, token: 'mock-mutex' } : { released: true }) }] };
            }
            return { content: [{ text: `mock ${name}` }] };
        };

        const run = await runDevelopLoopScenario('pr401selfheal', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: 647.1.1.3 Publish-PR 401 self-heal fixture' }],
            maxCycles: 1,
            callTool,
            prCurlResponseQueue: [
                { status: 401, body: { message: 'Bad credentials' } },
                { status: 201, body: { number: 202, html_url: 'https://github.com/mock-org/mock-repo/pull/202' } },
            ],
        });

        check(!run.error, `scenario should not throw: ${run.error ? `${run.error.constructor.name}: ${run.error.message}` : ''}`);
        check(run.result && run.result.status === 'success', `expected a successful terminal sprint state, got: ${JSON.stringify(run.result)}`);

        const curlCalls = run.commandLog.filter((c) => /^curl -sS -X POST\b/.test(c) && /\/pulls\b/.test(c));
        check(curlCalls.length === 2, `expected exactly two PR-create curl dispatches (the 401 attempt + the retry), saw ${curlCalls.length}`);

        // The doer's own dispatch also mints a plain 'push' credential via
        // the UNRELATED proactive preflight (apra-fleet-647.1.1.2, needsVcsAuth)
        // before it ever reaches Publish PR -- filter to the 'push+pr'-scoped
        // calls (VCSModule.buildCreatePrCommand's own credential) to isolate
        // THIS bead's self-heal: the PR step's mandatory just-in-time mint
        // happens once regardless of outcome, and the 401 self-heal adds
        // exactly ONE more.
        const prCapableCalls = provisionCalls.filter((c) => c.git_access === 'push+pr');
        check(
            prCapableCalls.length === 2,
            `expected exactly two 'push+pr' provision_vcs_auth calls (the PR step's mandatory just-in-time mint, plus exactly ONE self-heal re-provision after the 401), got ${prCapableCalls.length}: ${JSON.stringify(provisionCalls)}`,
        );
        check(
            run.logs.some((l) => /PR creation returned an auth-classified failure/.test(l) && /HTTP 401/.test(l)),
            `expected a logged auth-classified-failure line naming HTTP 401, got: ${JSON.stringify(run.logs)}`,
        );
        check(
            run.logs.some((l) => /PR auth self-heal completed/.test(l) && /retrying PR creation once/.test(l)),
            `expected a logged self-heal-completed + retry line, got: ${JSON.stringify(run.logs)}`,
        );
        assertNoRawTokenInLogs(run.logs);
    });
});

// -----------------------------------------------------------------------
// Assertion 3 (Publish-PR side): non-auth failures never trigger a
// re-provision -- companion regression guard so assertion 1 above cannot be
// vacuously satisfied by a self-heal that fires unconditionally on ANY
// non-2xx status.
// -----------------------------------------------------------------------
test('Publish-PR path: a persistent non-auth 500 never triggers a self-heal re-provision', async () => {
    await withScenarioMarkers('pr500noheal', async () => {
        const provisionCalls = [];
        const callTool = async (name, args) => {
            if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider: 'github' }) }] };
            if (name === 'provision_vcs_auth') {
                provisionCalls.push(args);
                return { content: [{ text: `check-mark Mock ${args.provider} credentials deployed on "${args.member_name}"\n` }] };
            }
            if (name === 'child_id_allocator') {
                return { content: [{ text: JSON.stringify(args && args.action === 'allocate' ? { childId: null, token: null } : { confirmed: true, released: true }) }] };
            }
            if (name === 'dolt_push_mutex') {
                return { content: [{ text: JSON.stringify(args && args.action === 'acquire' ? { granted: true, token: 'mock-mutex' } : { released: true }) }] };
            }
            return { content: [{ text: `mock ${name}` }] };
        };

        const run = await runDevelopLoopScenario('pr500noheal', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: 647.1.1.3 Publish-PR non-auth 500 fixture' }],
            maxCycles: 1,
            callTool,
            prCurlResponseQueue: [{ status: 500, body: { message: 'Internal Server Error' } }],
        });

        // A genuine (non-auth) PR-create failure is NOT swallowed into a
        // soft 'failed' terminal status -- runner.js's Publish PR step
        // throws a CommandError for it (unlike the non-hosted-remote skip
        // path), which the sprint records as a terminal history entry and
        // then re-throws (isTerminalSprintFailure/isTypedAbortError) -- so
        // this scenario surfaces it as `run.error`, not `run.result`.
        check(!!run.error, `expected the persistent 500 to surface as a thrown CommandError, got no error and result: ${JSON.stringify(run.result)}`);
        check(/Publish PR Failed/.test(run.error.message) && /HTTP 500/.test(run.error.message), `expected the thrown error to name the Publish PR failure and HTTP 500, got: ${run.error.message}`);

        const curlCalls = run.commandLog.filter((c) => /^curl -sS -X POST\b/.test(c) && /\/pulls\b/.test(c));
        check(curlCalls.length === 1, `expected exactly ONE PR-create curl dispatch (no retry for a non-auth failure), saw ${curlCalls.length}`);
        const prCapableCalls = provisionCalls.filter((c) => c.git_access === 'push+pr');
        check(
            prCapableCalls.length === 1,
            `expected exactly ONE 'push+pr' provision_vcs_auth call (the PR step's mandatory just-in-time mint only -- no self-heal re-provision for a non-auth 500), got ${prCapableCalls.length}: ${JSON.stringify(provisionCalls)}`,
        );
        check(
            !run.logs.some((l) => /PR creation returned an auth-classified failure/.test(l)),
            `expected NO auth-classified-failure log line for a 500, got: ${JSON.stringify(run.logs)}`,
        );
        assertNoRawTokenInLogs(run.logs);
    });
});

// -----------------------------------------------------------------------
// finalizeAbort: a direct command()/callTool mock, since finalizeAbort is
// exported and independently callable (no full mock-sprint scenario
// needed).
// -----------------------------------------------------------------------
function makeFinalizeAbortMocks({ curlResponses, commitCount = 2 }) {
    const commandLog = [];
    const queue = [...curlResponses];
    const command = async (cmd, opts = {}) => {
        commandLog.push(cmd);
        if (cmd === 'git remote get-url origin') return { ok: true, output: 'https://github.com/mock-org/mock-repo.git', error: null };
        if (/^git fetch origin\b/.test(cmd)) return { ok: true, output: '', error: null };
        if (/^git rev-list --count\b/.test(cmd)) return { ok: true, output: String(commitCount), error: null };
        if (/^git push -u origin\b/.test(cmd)) return { ok: true, output: '', error: null };
        if (/^\$HOME\/\.fleet-git-credential-/.test(cmd)) {
            return { ok: true, output: `protocol=https\nhost=github.com\nusername=x-access-token\npassword=${RAW_PR_TOKEN}\n`, error: null };
        }
        if (/^curl -sS -X POST\b/.test(cmd) && /\/pulls\b/.test(cmd)) {
            const next = queue.length > 1 ? queue.shift() : queue[0];
            const bodyText = next.body !== undefined ? JSON.stringify(next.body) : '';
            return { ok: true, output: `${bodyText}\n${next.status}`, error: null };
        }
        return { ok: true, output: '', error: null };
    };
    const provisionCalls = [];
    const callTool = async (name, args) => {
        if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider: 'github' }) }] };
        if (name === 'provision_vcs_auth') {
            provisionCalls.push(args);
            const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            return { content: [{ text: `check-mark Mock ${args.provider} credentials deployed\n  expiresAt: ${expiresAt}\n` }] };
        }
        return { content: [{ text: `mock ${name}` }] };
    };
    return { command, callTool, commandLog, provisionCalls };
}

test('finalizeAbort path: a 401 on the [ABORTED] PR-create call self-heals + retries once, then succeeds', async () => {
    const logs = [];
    const { command, callTool, commandLog, provisionCalls } = makeFinalizeAbortMocks({
        curlResponses: [
            { status: 401, body: { message: 'Bad credentials' } },
            { status: 201, body: { number: 303, html_url: 'https://github.com/mock-org/mock-repo/pull/303' } },
        ],
    });

    const res = await finalizeAbort({
        error: new Error('typed abort'),
        branch: 'sprint/x',
        baseBranch: 'main',
        member: 'm1',
        command,
        callTool,
        log: (m) => logs.push(m),
    });

    check(res.reason === 'aborted-pr-created', `expected the [ABORTED] PR to be raised after the self-heal retry, got: ${JSON.stringify(res)}`);
    check(res.prUrl === 'https://github.com/mock-org/mock-repo/pull/303', `expected the retry's PR url, got: ${JSON.stringify(res)}`);

    const curlCalls = commandLog.filter((c) => /^curl -sS -X POST\b/.test(c) && /\/pulls\b/.test(c));
    check(curlCalls.length === 2, `expected exactly two PR-create curl dispatches, saw ${curlCalls.length}`);
    check(
        provisionCalls.length === 2,
        `expected exactly two provision_vcs_auth calls (mandatory just-in-time mint + one self-heal re-provision), got ${provisionCalls.length}`,
    );
    check(
        logs.some((l) => /PR creation returned an auth-classified failure/.test(l) && /HTTP 401/.test(l)),
        `expected a logged auth-classified-failure line, got: ${JSON.stringify(logs)}`,
    );
    assertNoRawTokenInLogs(logs);
});

// The 2026-08-02 fleet-mac failure mode this bead exists to prevent: a PR
// auth failure that SURVIVES the one-shot self-heal must never throw out of
// finalizeAbort -- the abort must still complete (its terminal-history
// record still gets written by the caller) instead of the whole sprint run
// being killed by the very auth failure finalizeAbort was trying to report.
test('finalizeAbort path: a 401 that persists through the self-heal retry does NOT throw -- finalizeAbort still completes', async () => {
    const logs = [];
    const { command, callTool, commandLog, provisionCalls } = makeFinalizeAbortMocks({
        curlResponses: [
            { status: 401, body: { message: 'Bad credentials' } },
            { status: 401, body: { message: 'Bad credentials' } },
        ],
    });

    const res = await finalizeAbort({
        error: new Error('typed abort'),
        branch: 'sprint/x',
        baseBranch: 'main',
        member: 'm1',
        command,
        callTool,
        log: (m) => logs.push(m),
    });

    check(res.reason === 'pr-auth-failed', `expected the degraded pr-auth-failed outcome (never a throw), got: ${JSON.stringify(res)}`);
    check(res.pushed === true, 'the branch push must still be reported, even though the PR itself could not be raised');

    const curlCalls = commandLog.filter((c) => /^curl -sS -X POST\b/.test(c) && /\/pulls\b/.test(c));
    check(curlCalls.length === 2, `expected exactly two PR-create curl dispatches (initial + the one bounded retry, never more), saw ${curlCalls.length}`);
    check(
        provisionCalls.length === 2,
        `expected exactly two provision_vcs_auth calls (mandatory mint + the one bounded self-heal retry, never more), got ${provisionCalls.length}`,
    );
    check(
        logs.some((l) => /survived the reactive self-heal retry/.test(l)),
        `expected a logged line noting the auth failure survived the self-heal retry, got: ${JSON.stringify(logs)}`,
    );
    assertNoRawTokenInLogs(logs);
});

// -----------------------------------------------------------------------
// Assertion 3 (finalizeAbort side): non-auth failures (422 already-exists,
// 500) never trigger a re-provision.
// -----------------------------------------------------------------------
test('finalizeAbort path: a 422 already-exists response is treated as idempotent success with NO self-heal re-provision', async () => {
    const logs = [];
    const { command, callTool, commandLog, provisionCalls } = makeFinalizeAbortMocks({
        curlResponses: [{
            status: 422,
            body: { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for sprint/x. https://github.com/mock-org/mock-repo/pull/9' }] },
        }],
    });

    const res = await finalizeAbort({
        error: new Error('typed abort'), branch: 'sprint/x', baseBranch: 'main', member: 'm1',
        command, callTool, log: (m) => logs.push(m),
    });

    check(res.reason === 'already-exists', `expected the idempotent already-exists outcome, got: ${JSON.stringify(res)}`);
    const curlCalls = commandLog.filter((c) => /^curl -sS -X POST\b/.test(c) && /\/pulls\b/.test(c));
    check(curlCalls.length === 1, `expected exactly ONE PR-create curl dispatch (no retry for an already-exists 422), saw ${curlCalls.length}`);
    check(
        provisionCalls.length === 1,
        `expected exactly ONE provision_vcs_auth call (the mandatory just-in-time mint only), got ${provisionCalls.length}`,
    );
    assertNoRawTokenInLogs(logs);
});

test('finalizeAbort path: a persistent non-auth 500 never triggers a self-heal re-provision and is re-thrown as a CommandError', async () => {
    const logs = [];
    const { command, callTool, commandLog, provisionCalls } = makeFinalizeAbortMocks({
        curlResponses: [{ status: 500, body: { message: 'Internal Server Error' } }],
    });

    await assert.rejects(
        () => finalizeAbort({
            error: new Error('typed abort'), branch: 'sprint/x', baseBranch: 'main', member: 'm1',
            command, callTool, log: (m) => logs.push(m),
        }),
        (err) => {
            check(err.name === 'CommandError' || /VCSModule create-pull-request failed/.test(err.message), `expected a CommandError naming the failed PR create, got: ${err.constructor.name}: ${err.message}`);
            return true;
        },
    );

    const curlCalls = commandLog.filter((c) => /^curl -sS -X POST\b/.test(c) && /\/pulls\b/.test(c));
    check(curlCalls.length === 1, `expected exactly ONE PR-create curl dispatch (no retry for a non-auth 500), saw ${curlCalls.length}`);
    check(
        provisionCalls.length === 1,
        `expected exactly ONE provision_vcs_auth call (the mandatory just-in-time mint only -- no self-heal re-provision for a non-auth 500), got ${provisionCalls.length}`,
    );
    assertNoRawTokenInLogs(logs);
});

// -----------------------------------------------------------------------
// Assertion 4: the read-side proactive preflight logs its line when invoked
// (createVcsAuthPreflightCallback, apra-fleet-647.1.1.2). The runtime
// needsVcsAuth on/off gating itself (a read-side dispatch with
// needsVcsAuth:true triggers ensureVcsAuthFresh; a pure read-only dispatch
// with it unset/false never does) is already covered end-to-end by
// vcs-auth-preflight.test.mjs's "runSprintCycle: the real withGitSync
// pushCode-gated preflight wiring" suite (apra-fleet-647.1.1.2's own test),
// which asserts call counts/targets for a pushCode:true doer vs read-only
// reviewer/deployer/integ-test-runner roles through a real mock sprint --
// not duplicated here.
// -----------------------------------------------------------------------
test('createVcsAuthPreflightCallback logs the "[Sync] preflight:" line and never logs the raw token', async () => {
    const logs = [];
    const command = async (cmd) => {
        if (cmd === 'git remote get-url origin') return { ok: true, output: 'https://github.com/acme/widgets.git', error: null };
        return { ok: true, output: '', error: null };
    };
    const callTool = async (name, args) => {
        if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider: 'github' }) }] };
        if (name === 'provision_vcs_auth') {
            const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            return { content: [{ text: `check-mark Mock github credentials deployed\n  expiresAt: ${expiresAt}\n` }] };
        }
        return { content: [{ text: 'ok' }] };
    };
    const ensureVcsAuthFresh = createVcsAuthPreflightCallback({ callTool, command, log: (m) => logs.push(m) });

    await ensureVcsAuthFresh('member-doer');

    check(
        logs.some((l) => /^\[Sync\] preflight: ensuring member 'member-doer' has a fresh VCS credential before dispatch/.test(l)),
        `expected the preflight line to be logged, got: ${JSON.stringify(logs)}`,
    );
    check(
        logs.some((l) => /preflight: provision_vcs_auth succeeded for member 'member-doer'/.test(l)),
        `expected the preflight success line to be logged, got: ${JSON.stringify(logs)}`,
    );
    assertNoRawTokenInLogs(logs);
});
