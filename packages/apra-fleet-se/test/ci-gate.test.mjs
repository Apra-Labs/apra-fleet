import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    runCiGate, createCiGate, createCiGateContextResolver, parseCurlStatusOutput,
    CI_GATE_OUTCOME, CI_GATE_NOT_CONFIGURED_LOG,
} from '../fleet-sprint/ci-gate.mjs';
import { validateCiGate, validateArgs, DEFAULT_CI_GATE_TIMEOUT_S } from '../fleet-sprint/sprint-args.mjs';
import { getVcsProvider, supportsCiGate } from '../fleet-sprint/vcs-providers/index.mjs';

// =============================================================================
// Engine CI gate (fleet-sprint/ci-gate.mjs). The orchestrator -- never a doer --
// triggers/awaits the configured CI workflow on the sprint branch head and
// hands the result to the reviewer. Every test here stubs the provider HTTP
// layer (the injected `transport`) -- no real GitHub call is ever made. The
// REAL GitHub provider descriptor is used, so its request builders and
// response parsers are exercised, not re-derived.
// =============================================================================

const SHA = '0123456789abcdef0123456789abcdef01234567';
const RUN_URL = 'https://github.example/o/r/actions/runs/4242';
const GITHUB = getVcsProvider('github');
const PERMISSION_TEXT = 'actions:write';

/**
 * Stub transport over the GitHub CI actions. `script` overrides any action's
 * answer; every request is recorded (action + logSafeCommand) for assertions.
 */
function stubTransport(script = {}) {
    const calls = [];
    let getRunCalls = 0;
    const defaults = {
        'ci-branch-head': () => ({ status: 200, body: { commit: { sha: SHA } } }),
        'ci-find-runs': () => ({ status: 200, body: { workflow_runs: [] } }),
        'ci-dispatch': () => ({ status: 204, body: null }),
        'ci-get-run': () => ({ status: 200, body: { id: 4242, html_url: RUN_URL, head_sha: SHA, status: 'completed', conclusion: 'success' } }),
        'ci-list-jobs': () => ({ status: 200, body: { jobs: [] } }),
    };
    const transport = async (built) => {
        calls.push({ action: built.action, command: built.logSafeCommand });
        if (built.action === 'ci-get-run') getRunCalls += 1;
        const fn = script[built.action] || defaults[built.action];
        if (!fn) throw new Error(`unexpected CI action ${built.action}`);
        return fn({ getRunCalls, calls });
    };
    return { transport, calls };
}

/** A virtual clock: sleep() advances now() instantly, so polling tests are fast. */
function virtualClock() {
    let t = 0;
    return { now: () => t, sleep: async (ms) => { t += ms; } };
}

const GATE = { workflow: 'ci.yml', timeoutS: 600 };

describe('(1) configured gate + successful run', () => {
    test('records run id, url, head sha and per-job conclusions, and the reviewer prompt carries the run id and every job result', async () => {
        const logs = [];
        const clock = virtualClock();
        const { transport, calls } = stubTransport({
            // A run already triggered for this sha (push-triggered): located, not re-triggered.
            'ci-find-runs': () => ({ status: 200, body: { workflow_runs: [
                { id: 4241, html_url: 'stale', head_sha: 'f'.repeat(40), status: 'completed', conclusion: 'failure' },
                { id: 4242, html_url: RUN_URL, head_sha: SHA, status: 'in_progress', conclusion: null },
            ] } }),
            'ci-get-run': ({ getRunCalls }) => ({ status: 200, body: {
                id: 4242, html_url: RUN_URL, head_sha: SHA,
                status: getRunCalls >= 2 ? 'completed' : 'in_progress',
                conclusion: getRunCalls >= 2 ? 'success' : null,
            } }),
            'ci-list-jobs': () => ({ status: 200, body: { jobs: [
                { name: 'build (os-a)', conclusion: 'success' },
                { name: 'build (os-b)', conclusion: 'success' },
                { name: 'lint', conclusion: 'skipped' },
            ] } }),
        });
        const result = await runCiGate({
            ciGate: GATE, provider: GITHUB, repo: 'o/r', branch: 'feat/x', transport,
            log: (l) => logs.push(l), pollIntervalMs: 1000, ...clock,
        });

        assert.equal(result.outcome, CI_GATE_OUTCOME.PASS);
        assert.equal(result.runId, '4242');
        assert.equal(result.runUrl, RUN_URL);
        assert.equal(result.headSha, SHA);
        assert.equal(result.conclusion, 'success');
        assert.deepEqual(result.jobs, [
            { name: 'build (os-a)', conclusion: 'success' },
            { name: 'build (os-b)', conclusion: 'success' },
            { name: 'lint', conclusion: 'skipped' },
        ]);
        assert.ok(!calls.some((c) => c.action === 'ci-dispatch'), 'a run already triggered for the head sha must be located, not re-triggered');
        assert.ok(calls.filter((c) => c.action === 'ci-get-run').length >= 2, 'the run must be polled until completed');
        // The recorded result reaches the sprint log too.
        const passLine = logs.find((l) => l.includes('PASS'));
        assert.ok(passLine && passLine.includes('4242') && passLine.includes(RUN_URL) && passLine.includes(SHA), `PASS log line must carry run id/url/sha: ${passLine}`);
    });

    test('no run for the head sha: the gate triggers the workflow on the branch, then finds and awaits the new run', async () => {
        const clock = virtualClock();
        let findCalls = 0;
        const { transport, calls } = stubTransport({
            'ci-find-runs': () => {
                findCalls += 1;
                return { status: 200, body: { workflow_runs: findCalls >= 2
                    ? [{ id: 4242, html_url: RUN_URL, head_sha: SHA, status: 'queued', conclusion: null }]
                    : [] } };
            },
        });
        const result = await runCiGate({ ciGate: GATE, provider: GITHUB, repo: 'o/r', branch: 'feat/x', transport, pollIntervalMs: 1000, ...clock });
        assert.equal(result.outcome, CI_GATE_OUTCOME.PASS);
        const dispatch = calls.find((c) => c.action === 'ci-dispatch');
        assert.ok(dispatch, 'the workflow must be triggered');
        assert.match(dispatch.command, /actions\/workflows\/ci\.yml\/dispatches/);
        assert.match(dispatch.command, /feat\/x/);
        assert.doesNotMatch(dispatch.command, /vcs_token_inline/, 'the log-safe command must redact the credential placeholder');
    });

    test('a completed non-success run is FAIL with the failing job named,', async () => {
        const { transport } = stubTransport({
            'ci-find-runs': () => ({ status: 200, body: { workflow_runs: [{ id: 4242, html_url: RUN_URL, head_sha: SHA, status: 'completed', conclusion: 'failure' }] } }),
            'ci-list-jobs': () => ({ status: 200, body: { jobs: [{ name: 'build (os-a)', conclusion: 'success' }, { name: 'build (os-b)', conclusion: 'failure' }] } }),
        });
        const result = await runCiGate({ ciGate: GATE, provider: GITHUB, repo: 'o/r', branch: 'feat/x', transport, ...virtualClock() });
        assert.equal(result.outcome, CI_GATE_OUTCOME.FAIL);
        assert.match(result.reason, /build \(os-b\)=failure/);
    });
});

describe('(2) trigger refused with HTTP 403', () => {
    test('FAILED-TO-RUN (never pass), the log names the missing permission and the credential', async () => {
        const logs = [];
        const { transport, calls } = stubTransport({
            'ci-dispatch': () => ({ status: 403, body: { message: 'Resource not accessible by integration' }, bodyText: '{"message":"Resource not accessible by integration"}' }),
        });
        const result = await runCiGate({
            ciGate: GATE, provider: GITHUB, repo: 'o/r', branch: 'feat/x', transport,
            credential: "the 'github' push+pr VCS credential on member 'orch'",
            log: (l) => logs.push(l), ...virtualClock(),
        });

        assert.equal(result.outcome, CI_GATE_OUTCOME.FAILED_TO_RUN);
        assert.notEqual(result.outcome, CI_GATE_OUTCOME.PASS);
        assert.ok(calls.some((c) => c.action === 'ci-dispatch'), 'the trigger must actually have been attempted');
        assert.ok(!calls.some((c) => c.action === 'ci-get-run'), 'nothing may be polled after a refused trigger');
        const errorLine = logs.find((l) => l.includes('ERROR') && l.includes(CI_GATE_OUTCOME.FAILED_TO_RUN));
        assert.ok(errorLine, `a loud ERROR line must be logged; got:\n${logs.join('\n')}`);
        assert.ok(errorLine.includes(PERMISSION_TEXT), `the ERROR line must name the missing permission (${PERMISSION_TEXT}): ${errorLine}`);
        assert.ok(errorLine.includes("member 'orch'"), `the ERROR line must name the credential in use: ${errorLine}`);
        assert.ok(errorLine.includes('Resource not accessible by integration'), 'the provider refusal text must be preserved');

        assert.equal(result.outcome, CI_GATE_OUTCOME.FAILED_TO_RUN);
    });

    test('a 403-shaped refusal text at another status is still a named-permission FAILED-TO-RUN', async () => {
        const logs = [];
        const { transport } = stubTransport({
            'ci-dispatch': () => ({ status: 404, body: { message: 'Resource not accessible by integration' } }),
        });
        const result = await runCiGate({ ciGate: GATE, provider: GITHUB, repo: 'o/r', branch: 'feat/x', transport, log: (l) => logs.push(l), ...virtualClock() });
        assert.equal(result.outcome, CI_GATE_OUTCOME.FAILED_TO_RUN);
        assert.ok(result.reason.includes(PERMISSION_TEXT));
    });
});

describe('(3) a run that never completes', () => {
    test('stops at the bounded timeout and records a non-pass with the run url (real clock, short injected timeout)', async () => {
        const started = Date.now();
        const { transport } = stubTransport({
            'ci-find-runs': () => ({ status: 200, body: { workflow_runs: [{ id: 4242, html_url: RUN_URL, head_sha: SHA, status: 'in_progress', conclusion: null }] } }),
            'ci-get-run': () => ({ status: 200, body: { id: 4242, html_url: RUN_URL, head_sha: SHA, status: 'in_progress', conclusion: null } }),
        });
        const logs = [];
        const result = await runCiGate({
            ciGate: { workflow: 'ci.yml', timeoutS: 1 }, provider: GITHUB, repo: 'o/r', branch: 'feat/x', transport,
            log: (l) => logs.push(l), pollIntervalMs: 100,
        });
        const elapsed = Date.now() - started;
        assert.equal(result.outcome, CI_GATE_OUTCOME.TIMEOUT);
        assert.notEqual(result.outcome, CI_GATE_OUTCOME.PASS);
        assert.equal(result.runUrl, RUN_URL);
        assert.ok(result.reason.includes(RUN_URL), `the timeout reason must carry the run url: ${result.reason}`);
        assert.ok(logs.some((l) => l.includes('ERROR') && l.includes('TIMEOUT') && l.includes(RUN_URL)));
        assert.ok(elapsed < 5000, `the gate must stop at its bounded timeout (took ${elapsed}ms)`);
        assert.ok(elapsed >= 900, `the gate must actually wait for its timeout (took ${elapsed}ms)`);
    });
});

describe('(4) ci_gate arg validation, unsupported provider, unconfigured gate', () => {
    test('missing workflow, non-positive or non-integer timeout_s and bad shapes are rejected with a clear error', () => {
        assert.throws(() => validateCiGate({}), /ci_gate\.workflow.*required/);
        assert.throws(() => validateCiGate({ timeout_s: 60 }), /ci_gate\.workflow/);
        assert.throws(() => validateCiGate({ workflow: '' }), /ci_gate\.workflow/);
        assert.throws(() => validateCiGate({ workflow: 'ci.yml; rm -rf x' }), /ci_gate\.workflow/);
        assert.throws(() => validateCiGate({ workflow: 'ci.yml', timeout_s: 0 }), /ci_gate\.timeout_s.*positive integer/);
        assert.throws(() => validateCiGate({ workflow: 'ci.yml', timeout_s: -5 }), /ci_gate\.timeout_s/);
        assert.throws(() => validateCiGate({ workflow: 'ci.yml', timeout_s: 1.5 }), /ci_gate\.timeout_s/);
        assert.throws(() => validateCiGate({ workflow: 'ci.yml', timeout_s: '60' }), /ci_gate\.timeout_s/);
        assert.throws(() => validateCiGate('{not json'), /not valid JSON/);
        assert.throws(() => validateCiGate(['ci.yml']), /must be an object/);
        assert.throws(() => validateCiGate({ workflow: 'ci.yml', extra: 1 }), /unknown key/);
    });

    test('a valid shape is accepted, timeout_s defaults to 3600, and the CLI JSON string form parses', () => {
        assert.equal(DEFAULT_CI_GATE_TIMEOUT_S, 3600);
        assert.deepEqual(validateCiGate({ workflow: 'ci.yml' }), { workflow: 'ci.yml', timeoutS: 3600 });
        assert.deepEqual(validateCiGate({ workflow: '12345', timeout_s: 90 }), { workflow: '12345', timeoutS: 90 });
        assert.deepEqual(validateCiGate('{"workflow":"ci.yml","timeout_s":120}'), { workflow: 'ci.yml', timeoutS: 120 });
        assert.equal(validateCiGate(undefined), undefined);
    });

    // The ci_gate arg is deliberately NOT WIRED until the CI-as-quality-resource
    // epic (apra-fleet-dv8i) designs the flow: passing it must fail loudly as an
    // unknown arg, and a launch without it never configures the gate.
    test('validateArgs never configures the gate; ci_gate is rejected as an unknown arg', () => {
        const base = { target_issues: ['x-1'], members: ['m'], branch: 'feat/x', base_branch: 'main' };
        assert.equal(validateArgs(base).ciGate, undefined);
        assert.throws(() => validateArgs({ ...base, ci_gate: { workflow: 'ci.yml' } }), /\[Arg Contract\] Unknown arg\(s\): ci_gate/);
    });

    test('a provider without CI-trigger support + ci_gate set -> loud FAILED-TO-RUN naming the provider, zero CI requests', async () => {
        for (const name of ['bitbucket', 'azure-devops', 'generic-git']) {
            const provider = getVcsProvider(name);
            assert.equal(supportsCiGate(provider), false, `${name} declares no ciGate today`);
            const logs = [];
            let requests = 0;
            const result = await runCiGate({
                ciGate: GATE, provider, repo: 'o/r', branch: 'feat/x',
                transport: async () => { requests += 1; return { status: 200, body: {} }; },
                log: (l) => logs.push(l), ...virtualClock(),
            });
            assert.equal(result.outcome, CI_GATE_OUTCOME.FAILED_TO_RUN);
            assert.equal(requests, 0, `${name}: no CI request may be attempted`);
            const errorLine = logs.find((l) => l.includes('ERROR'));
            assert.ok(errorLine && errorLine.includes(`'${name}'`), `${name}: the ERROR line must name the provider: ${errorLine}`);
        }
        assert.equal(supportsCiGate(GITHUB), true);
    });

    test('the production resolver reports a remote with no CI-capable provider by name (file:// remote)', async () => {
        const logs = [];
        let vcsExecCalls = 0;
        const resolve = createCiGateContextResolver({
            fleetApi: { vcsCredentialExec: async () => { vcsExecCalls += 1; return {}; } },
            command: async () => ({ ok: true, output: 'file:///srv/mirror.git\n' }),
            orchestratorMember: 'orch', gitMember: 'git-m', log: () => {},
        });
        const gate = createCiGate({ ciGate: GATE, branch: 'feat/x', log: (l) => logs.push(l), resolveContext: resolve, gateOptions: virtualClock() });
        const result = await gate.check({ label: 'Review C1' });
        assert.equal(result.outcome, CI_GATE_OUTCOME.FAILED_TO_RUN);
        assert.match(result.reason, /no CI-trigger support/);
        assert.match(result.provider, /none/);
        assert.equal(vcsExecCalls, 0);
    });

    test('ci_gate absent -> zero provider CI calls and exactly one "CI gate not configured" log line', async () => {
        const logs = [];
        let resolveCalls = 0;
        const gate = createCiGate({
            ciGate: undefined, branch: 'feat/x', log: (l) => logs.push(l),
            resolveContext: async () => { resolveCalls += 1; throw new Error('must not be called'); },
        });
        assert.equal(gate.configured, false);
        // Several review rounds: still no CI calls and still exactly one line.
        assert.equal(await gate.check({ label: 'Review C1' }), null);
        assert.equal(await gate.check({ label: 'Review C2' }), null);
        assert.equal(resolveCalls, 0);
        assert.deepEqual(gate.results, []);
        assert.equal(logs.filter((l) => l.includes('CI gate not configured')).length, 1);
        assert.equal(logs.length, 1);
        assert.equal(logs[0], CI_GATE_NOT_CONFIGURED_LOG);
    });
});

describe('sprint-scoped gate', () => {
    test('an unchanged head reuses its terminal result; a moved head runs CI again', async () => {
        let head = SHA;
        let findCalls = 0;
        const transport = async (built) => {
            if (built.action === 'ci-branch-head') return { status: 200, body: { commit: { sha: head } } };
            if (built.action === 'ci-find-runs') {
                findCalls += 1;
                return { status: 200, body: { workflow_runs: [{ id: 100 + findCalls, html_url: `${RUN_URL}/${findCalls}`, head_sha: head, status: 'completed', conclusion: 'success' }] } };
            }
            if (built.action === 'ci-list-jobs') return { status: 200, body: { jobs: [{ name: 'j', conclusion: 'success' }] } };
            throw new Error(`unexpected ${built.action}`);
        };
        const gate = createCiGate({
            ciGate: GATE, branch: 'feat/x', log: () => {},
            resolveContext: async () => ({ provider: GITHUB, repo: 'o/r', transport }),
            gateOptions: virtualClock(),
        });
        const r1 = await gate.check({ label: 'Review C1' });
        const r2 = await gate.check({ label: 'Review C1' });
        assert.equal(findCalls, 1, 'an unchanged head must not re-run CI');
        assert.equal(r2.runId, r1.runId);
        head = 'b'.repeat(40);
        const r3 = await gate.check({ label: 'Review C2' });
        assert.equal(findCalls, 2);
        assert.equal(r3.headSha, head);
        assert.equal(gate.results.length, 3);
    });

    test('a context-resolution failure is recorded as FAILED-TO-RUN, never thrown and never a pass', async () => {
        const logs = [];
        const gate = createCiGate({
            ciGate: GATE, branch: 'feat/x', log: (l) => logs.push(l),
            resolveContext: async () => { throw new Error('origin unreadable'); },
        });
        const r = await gate.check();
        assert.equal(r.outcome, CI_GATE_OUTCOME.FAILED_TO_RUN);
        assert.ok(logs.some((l) => l.includes('ERROR') && l.includes('origin unreadable')));
    });
});

test('parseCurlStatusOutput splits the -w status trailer from the JSON body', () => {
    assert.deepEqual(parseCurlStatusOutput('{"a":1}\n200'), { status: 200, body: { a: 1 }, bodyText: '{"a":1}' });
    assert.equal(parseCurlStatusOutput('\n204').status, 204);
    assert.equal(parseCurlStatusOutput('garbage').status, null);
});
