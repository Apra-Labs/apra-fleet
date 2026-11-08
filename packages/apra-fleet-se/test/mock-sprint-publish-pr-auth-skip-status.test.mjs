import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    runDevelopLoopScenario,
    withScenarioMarkers,
    defaultMockCallTool,
} from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';

// A PR skipped for an unrecoverable VCS auth failure must show in the final
// run result (persisted verbatim by the engine as state.result, which the
// supervisor serves for a finished run) and in the final summary log line,
// while the computed verdict stays PASS. A successful PR shows no marker.

const callToolFactory = (executeCommand) => {
    const base = defaultMockCallTool({ executeCommand });
    return async (name, args) => {
        if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider: 'github' }) }] };
        if (name === 'provision_vcs_auth') {
            const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            return { content: [{ text: `[OK] Mock ${args.provider} credentials deployed on "${args.member_name}"\n  expiresAt: ${expiresAt}\n` }] };
        }
        if (name === 'child_id_allocator') {
            return { content: [{ text: JSON.stringify(args && args.action === 'allocate' ? { childId: null, token: null } : { confirmed: true, released: true }) }] };
        }
        if (name === 'dolt_push_mutex') {
            return { content: [{ text: JSON.stringify(args && args.action === 'acquire' ? { granted: true, token: 'mock-mutex' } : { released: true }) }] };
        }
        return base(name, args);
    };
};

test('persistent 401 on PR create: result carries prSkipped, summary line says so, verdict stays PASS', { timeout: scaledTimeout(180000, { concurrency: 8 }) }, async () => {
    await withScenarioMarkers('prauthskip', async () => {
        const run = await runDevelopLoopScenario('prauthskip', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: PR auth-skip status fixture' }],
            maxCycles: 1,
            callToolFactory,
            prCurlResponseQueue: [{ status: 401, body: { message: 'Bad credentials' } }],
        });
        assert.ok(!run.error, `should not throw: ${run.error && run.error.message}`);
        assert.equal(run.result.verdict, 'PASS');
        assert.equal(run.result.status, 'success');
        assert.equal(run.result.pushed, true);
        assert.equal(run.result.prSkipped.reason, 'auth-failure');
        assert.match(run.result.prSkipped.message, /PR not opened: VCS auth failure/);
        const summary = run.logs.find((l) => l.startsWith('[Sprint Summary]'));
        assert.ok(summary && summary.includes('PASS') && summary.includes('PR not opened: VCS auth failure'), JSON.stringify(run.logs.filter((l) => /Summary|Skipped/.test(l))));
        assert.ok(/^[\x20-\x7e]*$/.test(summary), 'summary line must be ASCII');
    });
});

test('successful PR create: no prSkipped marker and no skip summary line', { timeout: scaledTimeout(180000, { concurrency: 8 }) }, async () => {
    await withScenarioMarkers('prnoskip', async () => {
        const run = await runDevelopLoopScenario('prnoskip', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: PR no-skip status fixture' }],
            maxCycles: 1,
            callToolFactory,
            prCurlResponseQueue: [{ status: 201, body: { number: 7, html_url: 'https://github.com/mock-org/mock-repo/pull/7' } }],
        });
        assert.ok(!run.error, `should not throw: ${run.error && run.error.message}`);
        assert.equal(run.result.verdict, 'PASS');
        assert.ok(!('prSkipped' in run.result), JSON.stringify(run.result));
        assert.ok(!run.logs.some((l) => l.startsWith('[Sprint Summary]')));
    });
});
