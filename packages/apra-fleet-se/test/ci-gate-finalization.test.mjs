import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    startFinalizationCiGate, formatCiGateReport, createCiGate, CI_GATE_OUTCOME,
    CI_GATE_NOT_CONFIGURED_LOG, CI_GATE_FINALIZATION_LABEL,
} from '../fleet-sprint/ci-gate.mjs';
import { buildSprintPrBody } from '../fleet-sprint/pr-body.mjs';
import { runPublishPrPhase } from '../fleet-sprint/phases/publish-pr.mjs';
import { getVcsProvider } from '../fleet-sprint/vcs-providers/index.mjs';

// =============================================================================
// The ci_gate sprint arg, wired: CI runs ONCE per sprint, started at the
// beginning of Finalization and awaited by Publish PR, which renders the
// result into the PR body. These are the unit-level pieces:
//   - startFinalizationCiGate(): starts without blocking, its promise never
//     rejects (an early throw becomes FAILED-TO-RUN with no unhandled
//     rejection), and cancel() stops a pending poll promptly.
//   - formatCiGateReport(): PASS / FAIL / TIMEOUT / FAILED-TO-RUN lines and
//     the explicit sha-mismatch note.
//   - runPublishPrPhase(): awaits the gate after its push and before the PR
//     POST, puts the CI section in the body, never blocks the PR on a
//     non-PASS result and never changes the verdict; without a gate the body
//     has no CI section at all.
// The full-sprint ordering (gate started before Final Review, Regression and
// Harvest not blocked) is proved by mock-sprint-ci-gate-finalization.test.mjs.
// No real network: the CI transport and the PR REST calls are stubbed.
// ASCII only.
// =============================================================================

const SHA = '0123456789abcdef0123456789abcdef01234567';
const LATER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const RUN_URL = 'https://github.example/o/r/actions/runs/4242';
const GITHUB = getVcsProvider('github');
const GATE = { workflow: 'ci.yml', timeoutS: 600 };

function virtualClock() {
    let t = 0;
    return { now: () => t, sleep: async (ms) => { t += ms; } };
}

/** A transport for a completed run with the given conclusion and jobs. */
function completedRunTransport({ conclusion = 'success', jobs = [{ name: 'build (os-a)', conclusion: 'success' }, { name: 'build (os-b)', conclusion: 'success' }], gateBeforeAnswer = null } = {}) {
    return async (built) => {
        if (gateBeforeAnswer) await gateBeforeAnswer;
        switch (built.action) {
            case 'ci-branch-head': return { status: 200, body: { commit: { sha: SHA } } };
            case 'ci-find-runs': return { status: 200, body: { workflow_runs: [{ id: 4242, html_url: RUN_URL, head_sha: SHA, status: 'completed', conclusion }] } };
            case 'ci-list-jobs': return { status: 200, body: { jobs } };
            default: throw new Error(`unexpected CI action ${built.action}`);
        }
    };
}

/** Collect unhandled rejections for the duration of `fn`. */
async function withRejectionWatch(fn) {
    const seen = [];
    const onRejection = (reason) => { seen.push(reason); };
    process.on('unhandledRejection', onRejection);
    try {
        await fn();
        // Let any stray rejection surface on the next turns.
        await new Promise((r) => setTimeout(r, 20));
    } finally {
        process.removeListener('unhandledRejection', onRejection);
    }
    return seen;
}

describe('startFinalizationCiGate', () => {
    test('returns before CI resolves (non-blocking) and resolves PASS with run url, sha and jobs', async () => {
        let release;
        const gateBeforeAnswer = new Promise((r) => { release = r; });
        const logs = [];
        const run = startFinalizationCiGate({
            ciGate: GATE, branch: 'feat/x', log: (l) => logs.push(l),
            resolveContext: async () => ({ provider: GITHUB, repo: 'o/r', transport: completedRunTransport({ gateBeforeAnswer }) }),
            gateOptions: virtualClock(),
        });
        let settled = false;
        run.promise.then(() => { settled = true; });
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(settled, false, 'the gate must still be running: the caller was not blocked on it');
        assert.equal(run.settled(), false);
        assert.ok(logs.some((l) => l.includes('started at Finalization')), logs.join(' | '));
        assert.ok(logs.some((l) => l.includes('run once at Finalization')), 'the configured line names the new placement');
        assert.ok(!logs.some((l) => l.includes('before each reviewer dispatch')), 'stale per-review wording must be gone');
        release();
        const record = await run.promise;
        assert.equal(record.outcome, CI_GATE_OUTCOME.PASS);
        assert.equal(record.runUrl, RUN_URL);
        assert.equal(record.headSha, SHA);
        assert.equal(record.label, CI_GATE_FINALIZATION_LABEL);
        assert.equal(run.settled(), true);
    });

    test('a resolver that throws, a gate factory that throws, or a check() that rejects -> FAILED-TO-RUN, never an unhandled rejection', async () => {
        const seen = await withRejectionWatch(async () => {
            const logs = [];
            const a = startFinalizationCiGate({
                ciGate: GATE, branch: 'feat/x', log: (l) => logs.push(l),
                resolveContext: async () => { throw new Error('origin unreadable'); },
            });
            const b = startFinalizationCiGate({
                ciGate: GATE, branch: 'feat/x', log: (l) => logs.push(l), resolveContext: async () => ({}),
                createGate: () => { throw new Error('factory exploded'); },
            });
            const c = startFinalizationCiGate({
                ciGate: GATE, branch: 'feat/x', log: (l) => logs.push(l), resolveContext: async () => ({}),
                createGate: () => ({ check: () => Promise.reject(new Error('check exploded')) }),
            });
            // Nobody awaits for a while (the sprint is busy in Final Review);
            // an early rejection must not escape in the meantime.
            await new Promise((r) => setTimeout(r, 20));
            for (const [run, why] of [[a, 'origin unreadable'], [b, 'factory exploded'], [c, 'check exploded']]) {
                const r = await run.promise;
                assert.equal(r.outcome, CI_GATE_OUTCOME.FAILED_TO_RUN);
                assert.match(r.reason, new RegExp(why));
                assert.ok(logs.some((l) => l.includes('ERROR') && l.includes(why)), `loud ERROR line for ${why}: ${logs.join(' | ')}`);
            }
        });
        assert.deepEqual(seen, []);
    });

    test('cancel() stops a pending poll promptly (real timers) and records FAILED-TO-RUN; a no-op once settled', async () => {
        const transport = async (built) => {
            if (built.action === 'ci-branch-head') return { status: 200, body: { commit: { sha: SHA } } };
            if (built.action === 'ci-find-runs') return { status: 200, body: { workflow_runs: [{ id: 7, html_url: RUN_URL, head_sha: SHA, status: 'in_progress', conclusion: null }] } };
            if (built.action === 'ci-get-run') return { status: 200, body: { id: 7, html_url: RUN_URL, head_sha: SHA, status: 'in_progress', conclusion: null } };
            throw new Error(`unexpected ${built.action}`);
        };
        const run = startFinalizationCiGate({
            ciGate: { workflow: 'ci.yml', timeoutS: 3600 }, branch: 'feat/x', log: () => {},
            resolveContext: async () => ({ provider: GITHUB, repo: 'o/r', transport }),
            gateOptions: { pollIntervalMs: 60_000 },
        });
        await new Promise((r) => setTimeout(r, 20));
        const started = Date.now();
        run.cancel('the sprint aborted');
        const record = await run.promise;
        assert.ok(Date.now() - started < 2000, 'cancel must not wait out the poll interval');
        assert.equal(record.outcome, CI_GATE_OUTCOME.FAILED_TO_RUN);
        assert.match(record.reason, /the sprint aborted/);
        run.cancel('again');
        assert.equal((await run.promise).outcome, CI_GATE_OUTCOME.FAILED_TO_RUN);
    });

    test('the unconfigured path is untouched: createCiGate(undefined) still logs only its one line, and startFinalizationCiGate is never needed', () => {
        const logs = [];
        createCiGate({ ciGate: undefined, branch: 'feat/x', log: (l) => logs.push(l), resolveContext: async () => ({}) });
        assert.deepEqual(logs, [CI_GATE_NOT_CONFIGURED_LOG]);
    });
});

describe('formatCiGateReport', () => {
    const base = { workflow: 'ci.yml', branch: 'feat/x', headSha: SHA, runId: '4242', runUrl: RUN_URL, jobs: [{ name: 'build', conclusion: 'success' }] };

    test('PASS: outcome, workflow, run url, sha and jobs; no mismatch when the head is unchanged', () => {
        const r = formatCiGateReport({ ...base, outcome: 'PASS' }, { branchHeadSha: SHA });
        assert.equal(r.pass, true);
        assert.equal(r.shaMismatch, null);
        const text = r.lines.join('\n');
        assert.match(text, /CI gate: PASS -- workflow 'ci\.yml'/);
        assert.ok(text.includes(RUN_URL));
        assert.ok(text.includes(`CI ran on commit: ${SHA}`));
        assert.ok(text.includes('CI jobs: build=success'));
        assert.ok(r.logLines[0].includes('PASS') && !r.logLines[0].includes('ERROR'));
    });

    for (const [outcome, reason] of [['FAIL', "run concluded 'failure'"], ['TIMEOUT', 'run did not complete within 600s'], ['FAILED-TO-RUN', 'Missing permission: actions:write']]) {
        test(`${outcome}: loud ERROR log and a clearly-worded non-pass body line with the reason`, () => {
            const r = formatCiGateReport({ ...base, outcome, reason }, { branchHeadSha: SHA });
            assert.equal(r.pass, false);
            assert.match(r.lines[0], new RegExp(`^CI gate: ${outcome} -- workflow 'ci\\.yml' did NOT pass; CI has not verified this branch`));
            assert.ok(r.lines.some((l) => l.includes(reason)));
            assert.ok(r.logLines.some((l) => l.includes('ERROR') && l.includes(outcome) && l.includes('sprint verdict is unchanged')));
        });
    }

    test('sha mismatch is stated explicitly in the body and the log', () => {
        const r = formatCiGateReport({ ...base, outcome: 'PASS' }, { branchHeadSha: LATER_SHA });
        const note = `CI ran on ${SHA}; branch head is now ${LATER_SHA} (commits after CI started: not covered).`;
        assert.equal(r.shaMismatch, note);
        assert.ok(r.lines.includes(note));
        assert.ok(r.logLines.some((l) => l.includes('WARNING') && l.includes(note)));
    });

    test('a null record (no result) is reported as FAILED-TO-RUN, never a pass', () => {
        const r = formatCiGateReport(null, {});
        assert.equal(r.pass, false);
        assert.match(r.lines[0], /FAILED-TO-RUN/);
    });

    test('PR body: a CI section only when lines are given; no lines -> body byte-identical', () => {
        const opts = { verdict: 'PASS', goal: 'G', branch: 'feat/x', baseBranch: 'main', runId: 'r1', now: new Date('2026-10-01T09:30:00Z'), notes: 'ok' };
        assert.equal(buildSprintPrBody({ ...opts, ciLines: [] }), buildSprintPrBody(opts));
        const body = buildSprintPrBody({ ...opts, ciLines: formatCiGateReport({ ...base, outcome: 'PASS' }).lines });
        assert.match(body, /\n### CI\n\n- CI gate: PASS -- workflow 'ci\.yml'\./);
    });
});

// -----------------------------------------------------------------------------
// Publish PR with an in-flight gate: a fake GitHub behind vcs_credential_exec.
// -----------------------------------------------------------------------------
function fakePrApi(events) {
    const state = { body: null, title: null };
    const respond = (status, body) => ({ content: [{ text: '' }], structuredContent: { ok: true, reason: 'ok', exitCode: 0, stdout: `${JSON.stringify(body)}\n${status}`, stderr: '' } });
    state.callTool = async (name, toolArgs) => {
        if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider: 'github', os: 'linux', shell: '' }) }] };
        if (name === 'provision_vcs_auth') return { content: [{ text: 'ok' }], structuredContent: { ok: true, expiresAt: null } };
        if (name === 'credential_store_list') return { content: [{ text: '[]' }] };
        if (name === 'vcs_credential_exec') {
            const cmd = toolArgs.command;
            const method = /^curl -sS -X (\w+)/.exec(cmd)[1];
            if (method === 'POST') {
                events.push('pr-post');
                const m = /-d '((?:[^']|'\\'')*)' -w/.exec(cmd);
                const payload = JSON.parse(m[1].replace(/'\\''/g, "'"));
                state.title = payload.title;
                state.body = payload.body;
                return respond(201, { number: 7, html_url: 'https://github.com/acme/widgets/pull/7' });
            }
            throw new Error(`unexpected ${method}`);
        }
        throw new Error(`unexpected tool ${name}`);
    };
    return state;
}

async function publishWithGate({ record, headSha = SHA, verdict = 'PASS', ciGateRun: explicitRun } = {}) {
    const events = [];
    const logs = [];
    const pr = fakePrApi(events);
    let ciGateRun = explicitRun;
    if (ciGateRun === undefined && record) {
        let resolveRecord;
        const promise = new Promise((r) => { resolveRecord = r; });
        ciGateRun = {
            workflow: 'ci.yml',
            promise: promise.then((r) => { events.push('ci-awaited'); return r; }),
            cancel: () => { events.push('ci-cancelled'); },
            settled: () => false,
        };
        // The gate finishes only after the phase has already pushed: the
        // phase must be the one waiting for it.
        setTimeout(() => resolveRecord(record), 10);
    }
    const result = await runPublishPrPhase({
        phase: () => {},
        log: (m) => logs.push(m),
        command: async (cmd) => {
            if (cmd === 'git remote get-url origin') return { ok: true, output: 'https://github.com/acme/widgets.git', error: null };
            if (cmd === 'git rev-parse HEAD') { events.push('head-read'); return { ok: true, output: `${headSha}\n`, error: null }; }
            return { ok: true, output: '', error: null };
        },
        args: { callTool: pr.callTool, run_id: 'run-ci' },
        validated: { branch: 'feat/x', baseBranch: 'main', goal: 'Ship X', runId: 'run-ci' },
        targetIssues: [],
        backlogMember: 'orch',
        finalCycleLabel: '1',
        gitSync: { pushGitAfter: async () => { events.push('push'); }, syncBeadsAfter: async () => {} },
        getMemberForRole: () => 'git-member',
        finalVerdictResult: { verdict, notes: 'notes' },
        ciGateRun,
    });
    return { result, logs, events, pr };
}

describe('Publish PR awaits the Finalization CI gate run and reports it in the PR body', () => {
    const pass = { outcome: 'PASS', workflow: 'ci.yml', branch: 'feat/x', headSha: SHA, runId: '4242', runUrl: RUN_URL, jobs: [{ name: 'build (os-a)', conclusion: 'success' }], reason: null };

    test('ordering: push -> await CI -> PR POST; PASS rendered with run url, sha and jobs', async () => {
        const { result, events, pr, logs } = await publishWithGate({ record: pass });
        assert.equal(result.pushed, true);
        assert.deepEqual(events.filter((e) => e !== 'head-read'), ['push', 'ci-awaited', 'pr-post']);
        assert.ok(pr.body.includes('### CI'), pr.body);
        assert.ok(pr.body.includes("CI gate: PASS -- workflow 'ci.yml'."));
        assert.ok(pr.body.includes(RUN_URL));
        assert.ok(pr.body.includes(`CI ran on commit: ${SHA}`));
        assert.ok(pr.body.includes('build (os-a)=success'));
        assert.equal(pr.title, 'fleet-sprint [PASS]: feat/x');
        assert.ok(logs.some((l) => l.includes('awaiting the Finalization CI gate run')));
    });

    for (const outcome of ['FAIL', 'TIMEOUT', 'FAILED-TO-RUN']) {
        test(`${outcome}: the PR is still raised, the verdict is unchanged, and the body and log say CI did not pass`, async () => {
            const record = { ...pass, outcome, reason: `simulated ${outcome}` };
            const { result, pr, logs } = await publishWithGate({ record });
            assert.equal(result.pushed, true);
            assert.equal(pr.title, 'fleet-sprint [PASS]: feat/x', 'CI must never change the verdict');
            assert.ok(pr.body.startsWith('## Sprint verdict: PASS'));
            assert.ok(pr.body.includes(`CI gate: ${outcome} -- workflow 'ci.yml' did NOT pass`), pr.body);
            assert.ok(pr.body.includes(`simulated ${outcome}`));
            assert.ok(logs.some((l) => l.includes('[CI Gate] ERROR') && l.includes(outcome)), logs.join(' | '));
        });
    }

    test('sha mismatch: the pushed head moved after CI started -> explicit note in the body and log, no second run', async () => {
        const { pr, logs } = await publishWithGate({ record: pass, headSha: LATER_SHA });
        const note = `CI ran on ${SHA}; branch head is now ${LATER_SHA} (commits after CI started: not covered).`;
        assert.ok(pr.body.includes(note), pr.body);
        assert.ok(logs.some((l) => l.includes(note)));
    });

    test('no gate configured: no head read, no CI section, body unchanged', async () => {
        const { pr, events, logs } = await publishWithGate({ ciGateRun: null });
        assert.ok(!events.includes('head-read'));
        assert.ok(!pr.body.includes('### CI'));
        assert.ok(!logs.some((l) => l.includes('[CI Gate]')));
    });

    test('a failed push cancels the in-flight gate instead of waiting on it', async () => {
        const events = [];
        const run = { workflow: 'ci.yml', promise: new Promise(() => {}), cancel: () => events.push('cancel'), settled: () => false };
        const logs = [];
        const result = await runPublishPrPhase({
            phase: () => {}, log: (m) => logs.push(m), command: async () => ({ ok: true, output: '' }),
            args: {}, validated: { branch: 'feat/x', baseBranch: 'main' }, targetIssues: [], backlogMember: 'orch', finalCycleLabel: '1',
            gitSync: { pushGitAfter: async () => { throw new Error('remote unreachable'); }, syncBeadsAfter: async () => {} },
            getMemberForRole: () => 'git-member', finalVerdictResult: { verdict: 'PASS', notes: '' }, ciGateRun: run,
        });
        assert.equal(result.pushed, false);
        assert.deepEqual(events, ['cancel']);
        assert.ok(logs.some((l) => l.includes('cancelling the in-flight Finalization CI gate run')));
    });
});
