import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    finalizeAbort,
    attemptServerSidePrCreate,
    createServerSidePrCreator,
} from '../fleet-sprint/runner.js';
import { SprintPlanRejectedError } from '../fleet-sprint/errors.mjs';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-6bu -- PR creation must not depend on member-side `gh` auth.
//
// The fleet's provision_vcs_auth deploys GitHub App INSTALLATION tokens
// (`ghs_...`), which `gh auth login --with-token` rejects outright (401), so
// `gh pr create` could only ever work on a member carrying a leftover manual
// `gh auth login`. The fleet server's own `create_pull_request` tool mints an
// installation token with pull_requests:write and calls the GitHub REST API
// directly instead.
//
// These tests pin the RUNNER half of that change:
//   (a) the Publish PR path uses the tool when it is available and dispatches
//       no `gh pr create` at all;
//   (b) it falls back to the UNCHANGED `gh pr create` dispatch when the tool
//       answers with its "ERROR:" marker (no GitHub App configured) or is
//       missing entirely (older fleet server -> the call throws);
//   (c) the abort path (finalizeAbort) behaves the same way, including the
//       "already exists" idempotent success.
// =============================================================================

const MOCK_REPO_URL = 'https://github.com/mock-org/mock-repo.git';

function prCreated(number, url) {
    return { content: [{ text: `Created pull request #${number} in mock-org/mock-repo\n  ${url}\n  head -> base` }] };
}

function prAlreadyExists(url) {
    return { content: [{ text: `A pull request already exists for mock-org/mock-repo head "x" -- treating as success.\n  ${url}` }] };
}

function prNoApp() {
    return { content: [{ text: 'ERROR: GitHub App not configured. Run setup_git_app first, or create the PR another way.' }] };
}

// ---------------------------------------------------------------------------
// attemptServerSidePrCreate() unit cases -- the shared decision helper both
// call sites route through.
// ---------------------------------------------------------------------------

test('attemptServerSidePrCreate: returns null (fall back to gh) when no createPullRequest is wired', async () => {
    const res = await attemptServerSidePrCreate({
        createPullRequest: null, repo: 'o/r', base: 'main', head: 'b', title: 't',
    });
    assert.equal(res, null);
});

test('attemptServerSidePrCreate: returns null (fall back to gh) when no owner/repo could be derived', async () => {
    let called = 0;
    const res = await attemptServerSidePrCreate({
        createPullRequest: async () => { called += 1; return prCreated(1, 'https://x/1'); },
        repo: null, base: 'main', head: 'b', title: 't',
    });
    assert.equal(res, null);
    assert.equal(called, 0, 'the tool must not be called without a repo');
});

test('attemptServerSidePrCreate: success -> ok with the created PR url, and the payload carries repo/base/head/title/body', async () => {
    let payload = null;
    const res = await attemptServerSidePrCreate({
        createPullRequest: async (p) => { payload = p; return prCreated(42, 'https://github.com/mock-org/mock-repo/pull/42'); },
        repo: 'mock-org/mock-repo', base: 'main', head: 'feat/x', title: 'T', body: 'B',
    });
    check(res && res.ok === true, `expected ok result, got ${JSON.stringify(res)}`);
    assert.equal(res.alreadyExists, false);
    assert.equal(res.prUrl, 'https://github.com/mock-org/mock-repo/pull/42');
    assert.deepEqual(payload, { repo: 'mock-org/mock-repo', base: 'main', head: 'feat/x', title: 'T', body: 'B' });
});

test('attemptServerSidePrCreate: "already exists" -> idempotent success with the existing PR url', async () => {
    const res = await attemptServerSidePrCreate({
        createPullRequest: async () => prAlreadyExists('https://github.com/mock-org/mock-repo/pull/7'),
        repo: 'mock-org/mock-repo', base: 'main', head: 'feat/x', title: 'T',
    });
    check(res && res.ok === true && res.alreadyExists === true, `expected an already-exists success, got ${JSON.stringify(res)}`);
    assert.equal(res.prUrl, 'https://github.com/mock-org/mock-repo/pull/7');
});

test('attemptServerSidePrCreate: an "ERROR:" result (no GitHub App) -> null, so the caller falls back to gh', async () => {
    const logs = [];
    const res = await attemptServerSidePrCreate({
        createPullRequest: async () => prNoApp(),
        repo: 'mock-org/mock-repo', base: 'main', head: 'feat/x', title: 'T',
        log: (m) => logs.push(m),
    });
    assert.equal(res, null);
    check(logs.some((m) => /falling back to 'gh pr create'/.test(m)), `expected a fallback log line, logs: ${JSON.stringify(logs)}`);
});

test('attemptServerSidePrCreate: a throwing tool call (older server, tool not available) -> null', async () => {
    const logs = [];
    const res = await attemptServerSidePrCreate({
        createPullRequest: async () => { throw new Error('Tool create_pull_request not found'); },
        repo: 'mock-org/mock-repo', base: 'main', head: 'feat/x', title: 'T',
        log: (m) => logs.push(m),
    });
    assert.equal(res, null);
    check(logs.some((m) => /unavailable on this fleet server/.test(m)), `expected an unavailable log line, logs: ${JSON.stringify(logs)}`);
});

test('attemptServerSidePrCreate: an isError MCP result -> null', async () => {
    const res = await attemptServerSidePrCreate({
        createPullRequest: async () => ({ isError: true, content: [{ text: 'boom' }] }),
        repo: 'mock-org/mock-repo', base: 'main', head: 'feat/x', title: 'T',
    });
    assert.equal(res, null);
});

test('createServerSidePrCreator: returns null without a callTool, and routes to create_pull_request with one', async () => {
    assert.equal(createServerSidePrCreator({}), null);
    const seen = [];
    const creator = createServerSidePrCreator({ callTool: async (name, args) => { seen.push({ name, args }); return prCreated(1, 'https://x/1'); } });
    check(typeof creator === 'function', 'expected a creator function when callTool is wired');
    await creator({ repo: 'o/r', base: 'main', head: 'b', title: 't' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].name, 'create_pull_request');
    assert.deepEqual(seen[0].args, { repo: 'o/r', base: 'main', head: 'b', title: 't' });
});

// ---------------------------------------------------------------------------
// (c) Abort path -- finalizeAbort()
// ---------------------------------------------------------------------------

function buildAbortMockCommand({ commitCount = 2, originUrl = MOCK_REPO_URL, ghUrl = 'https://github.com/mock-org/mock-repo/pull/99' } = {}) {
    const log = [];
    const command = async (cmd) => {
        log.push(cmd);
        if (/^git fetch origin\b/.test(cmd)) return '';
        if (/^git rev-list --count\b/.test(cmd)) return String(commitCount);
        if (/^git remote get-url origin$/.test(cmd)) return { ok: true, output: `${originUrl}\n`, error: null };
        if (/^git push\b/.test(cmd)) return 'To mock-remote\n * [new branch] (mocked)';
        if (/^gh pr create\b/.test(cmd)) return { ok: true, output: `${ghUrl}\n`, error: null };
        throw new Error(`buildAbortMockCommand: unexpected command '${cmd}'`);
    };
    return { command, log };
}

test('finalizeAbort: uses create_pull_request when wired -- no gh pr create dispatched', async () => {
    const branch = 'auto-sprint/abort-server-side-pr';
    const { command, log } = buildAbortMockCommand();
    const logs = [];
    let payload = null;

    const result = await finalizeAbort({
        error: new SprintPlanRejectedError('Plan rejected after 3 rounds', { notes: null }),
        branch,
        baseBranch: 'main',
        member: 'local',
        command,
        log: (m) => logs.push(m),
        createPullRequest: async (p) => { payload = p; return prCreated(123, 'https://github.com/mock-org/mock-repo/pull/123'); },
    });

    assert.equal(result.reason, 'aborted-pr-created');
    assert.equal(result.pushed, true);
    assert.equal(result.prUrl, 'https://github.com/mock-org/mock-repo/pull/123');
    check(!log.some((c) => c.startsWith('gh pr create')), `expected NO gh pr create dispatch, command log: ${JSON.stringify(log)}`);
    check(log.some((c) => c.startsWith('git push -u origin')), `the branch must still be pushed, command log: ${JSON.stringify(log)}`);

    assert.equal(payload.repo, 'mock-org/mock-repo');
    assert.equal(payload.base, 'main');
    assert.equal(payload.head, branch);
    check(payload.title === `Auto-sprint [ABORTED]: ${branch}`, `unexpected title: ${payload.title}`);
    check(/Error code: SPRINT_PLAN_REJECTED/.test(payload.body), `expected the error evidence in the PR body, got: ${payload.body}`);
});

test('finalizeAbort: an "already exists" tool result stays an idempotent success with the existing url', async () => {
    const { command, log } = buildAbortMockCommand();
    const result = await finalizeAbort({
        error: new SprintPlanRejectedError('Plan rejected', { notes: null }),
        branch: 'auto-sprint/abort-server-side-pr-idem',
        baseBranch: 'main',
        member: 'local',
        command,
        createPullRequest: async () => prAlreadyExists('https://github.com/mock-org/mock-repo/pull/55'),
    });
    assert.equal(result.reason, 'already-exists');
    assert.equal(result.pushed, true);
    assert.equal(result.prUrl, 'https://github.com/mock-org/mock-repo/pull/55');
    check(!log.some((c) => c.startsWith('gh pr create')), `expected NO gh pr create dispatch, command log: ${JSON.stringify(log)}`);
});

test('finalizeAbort: a no-GitHub-App tool error falls back to the unchanged gh pr create dispatch', async () => {
    const branch = 'auto-sprint/abort-pr-fallback';
    const { command, log } = buildAbortMockCommand({ ghUrl: 'https://github.com/mock-org/mock-repo/pull/77' });
    const logs = [];

    const result = await finalizeAbort({
        error: new SprintPlanRejectedError('Plan rejected', { notes: null }),
        branch,
        baseBranch: 'main',
        member: 'local',
        command,
        log: (m) => logs.push(m),
        createPullRequest: async () => prNoApp(),
    });

    assert.equal(result.reason, 'aborted-pr-created');
    assert.equal(result.prUrl, 'https://github.com/mock-org/mock-repo/pull/77');
    const ghCmd = log.find((c) => c.startsWith('gh pr create'));
    check(!!ghCmd, `expected the gh pr create fallback to be dispatched, command log: ${JSON.stringify(log)}`);
    check(ghCmd.includes(`--title "Auto-sprint [ABORTED]: ${branch}"`), `fallback PR title changed: ${ghCmd}`);
    check(logs.some((m) => /falling back to 'gh pr create'/.test(m)), `expected a fallback log line, logs: ${JSON.stringify(logs)}`);
});

test('finalizeAbort: without a wired createPullRequest, the command sequence is byte-identical to the pre-6bu behavior', async () => {
    const { command, log } = buildAbortMockCommand();
    await finalizeAbort({
        error: new SprintPlanRejectedError('Plan rejected', { notes: null }),
        branch: 'auto-sprint/abort-no-tool',
        baseBranch: 'main',
        member: 'local',
        command,
    });
    check(
        !log.some((c) => c === 'git remote get-url origin'),
        `no origin-remote probe may be dispatched when no PR tool is wired, command log: ${JSON.stringify(log)}`
    );
    check(log.some((c) => c.startsWith('gh pr create')), `expected the gh pr create dispatch, command log: ${JSON.stringify(log)}`);
});

// ---------------------------------------------------------------------------
// (a)/(b) Publish PR path -- driven through the real runner via the mock
// sprint harness.
// ---------------------------------------------------------------------------

test('mock sprint: the Publish PR step uses create_pull_request when available and dispatches no gh pr create', async () => {
    await withScenarioMarkers('serversideprok', async () => {
        console.log('Running mock sprint scenario (Publish PR via the create_pull_request tool)...');
        const run = await runDevelopLoopScenario('serversideprok', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: apra-fleet-6bu server-side PR creation fixture' }],
            maxCycles: 1,
            prToolHandler: async () => prCreated(4242, 'https://github.com/mock-org/mock-repo/pull/4242'),
        });

        check(!run.error, `scenario should not throw: ${run.error ? `${run.error.constructor.name}: ${run.error.message}` : ''}`);
        check(run.result && run.result.status === 'success', `expected a successful sprint, got: ${JSON.stringify(run.result)}`);

        check(
            run.prToolCalls.length === 1,
            `expected exactly one create_pull_request call, got: ${JSON.stringify(run.prToolCalls)}`
        );
        const payload = run.prToolCalls[0];
        assert.equal(payload.repo, 'mock-org/mock-repo');
        assert.equal(payload.base, 'main');
        assert.equal(payload.head, run.branch);
        check(/^Auto-sprint \[PASS\]:/.test(payload.title), `unexpected PR title: ${payload.title}`);
        check(/Do NOT auto-merge/.test(payload.body), `expected the do-not-auto-merge notice in the body, got: ${payload.body}`);

        check(
            !run.commandLog.some((c) => c.startsWith('gh pr create')),
            `expected NO 'gh pr create' dispatch when the tool succeeded, commandLog: ${JSON.stringify(run.commandLog)}`
        );
        check(
            run.logs.some((m) => m.includes('PR created server-side via create_pull_request')),
            `expected a server-side PR log line, logs: ${JSON.stringify(run.logs)}`
        );
    });
});

test('mock sprint: the Publish PR step falls back to gh pr create when create_pull_request reports no GitHub App', async () => {
    await withScenarioMarkers('serversideprnoapp', async () => {
        console.log('Running mock sprint scenario (Publish PR falls back to gh when the tool has no App configured)...');
        const run = await runDevelopLoopScenario('serversideprnoapp', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: apra-fleet-6bu no-App fallback fixture' }],
            maxCycles: 1,
            prToolHandler: async () => prNoApp(),
        });

        check(!run.error, `scenario should not throw: ${run.error ? `${run.error.constructor.name}: ${run.error.message}` : ''}`);
        check(run.result && run.result.status === 'success', `expected a successful sprint, got: ${JSON.stringify(run.result)}`);
        check(run.prToolCalls.length === 1, `expected the tool to be tried once, got: ${JSON.stringify(run.prToolCalls)}`);
        check(
            run.commandLog.some((c) => c.startsWith('gh pr create') && c.includes(`--head "${run.branch}"`)),
            `expected the unchanged 'gh pr create' fallback dispatch, commandLog: ${JSON.stringify(run.commandLog)}`
        );
        check(
            run.logs.some((m) => m.includes("falling back to 'gh pr create'")),
            `expected a fallback log line, logs: ${JSON.stringify(run.logs)}`
        );
    });
});

test('mock sprint: the Publish PR step falls back to gh pr create when the tool does not exist on the server', async () => {
    await withScenarioMarkers('serversideprmissing', async () => {
        console.log('Running mock sprint scenario (Publish PR falls back to gh on an older server with no create_pull_request tool)...');
        const run = await runDevelopLoopScenario('serversideprmissing', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: apra-fleet-6bu tool-not-available fallback fixture' }],
            maxCycles: 1,
            prToolHandler: async () => { throw new Error('MCP error -32602: Tool create_pull_request not found'); },
        });

        check(!run.error, `scenario should not throw: ${run.error ? `${run.error.constructor.name}: ${run.error.message}` : ''}`);
        check(run.result && run.result.status === 'success', `expected a successful sprint, got: ${JSON.stringify(run.result)}`);
        check(
            run.commandLog.some((c) => c.startsWith('gh pr create') && c.includes(`--head "${run.branch}"`)),
            `expected the unchanged 'gh pr create' fallback dispatch, commandLog: ${JSON.stringify(run.commandLog)}`
        );
        check(
            run.logs.some((m) => m.includes('unavailable on this fleet server')),
            `expected a tool-unavailable log line, logs: ${JSON.stringify(run.logs)}`
        );
    });
});

test('mock sprint: an "already exists" tool result is an idempotent success -- no gh pr create, sprint still passes', async () => {
    await withScenarioMarkers('serversidepridem', async () => {
        console.log('Running mock sprint scenario (Publish PR tool reports the PR already exists)...');
        const run = await runDevelopLoopScenario('serversidepridem', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: apra-fleet-6bu already-exists idempotency fixture' }],
            maxCycles: 1,
            prToolHandler: async () => prAlreadyExists('https://github.com/mock-org/mock-repo/pull/11'),
        });

        check(!run.error, `scenario should not throw: ${run.error ? `${run.error.constructor.name}: ${run.error.message}` : ''}`);
        check(run.result && run.result.status === 'success', `expected a successful sprint, got: ${JSON.stringify(run.result)}`);
        check(
            !run.commandLog.some((c) => c.startsWith('gh pr create')),
            `an already-exists result must NOT fall back to gh, commandLog: ${JSON.stringify(run.commandLog)}`
        );
        check(
            run.logs.some((m) => m.includes('already exists') && m.includes('idempotent success')),
            `expected an idempotent-success log line, logs: ${JSON.stringify(run.logs)}`
        );
    });
});

test('mock sprint: a non-hosted (file://) remote never calls create_pull_request either', async () => {
    await withScenarioMarkers('serversideprnonhosted', async () => {
        console.log('Running mock sprint scenario (non-hosted remote: neither gh nor the PR tool is used)...');
        const run = await runDevelopLoopScenario('serversideprnonhosted', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: apra-fleet-6bu non-hosted-remote guard fixture' }],
            maxCycles: 1,
            originUrl: 'file:///tmp/apra-fleet-6bu-bare-mirror.git',
            prToolHandler: async () => prCreated(1, 'https://github.com/mock-org/mock-repo/pull/1'),
        });

        check(!run.error, `scenario should not throw: ${run.error ? `${run.error.constructor.name}: ${run.error.message}` : ''}`);
        check(run.result && run.result.status === 'success', `expected a successful sprint, got: ${JSON.stringify(run.result)}`);
        check(
            run.prToolCalls.length === 0,
            `a non-hosted remote must skip PR creation entirely, got: ${JSON.stringify(run.prToolCalls)}`
        );
        check(
            !run.commandLog.some((c) => /^gh\s/.test(c)),
            `expected NO 'gh' command against a non-hosted remote, commandLog: ${JSON.stringify(run.commandLog)}`
        );
    });
});
