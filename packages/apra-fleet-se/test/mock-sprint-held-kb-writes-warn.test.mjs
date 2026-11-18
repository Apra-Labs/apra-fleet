import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetWorkflow, CancelledError } from '@apralabs/apra-fleet-workflow';
import { main } from '../fleet-sprint/runner.js';
import { createKbWorkClient } from '../fleet-sprint/kb.mjs';
import { installFatalDiagnosticsGuard } from '../fleet-sprint/fatal-diagnostics.mjs';
import { fakeMaintainerSelector } from './helpers/kb-maintainer-fakes.mjs';
import {
    setup, teardown, buildMockFleetApi, withScenarioMarkers, uniqueMockBranch, defaultMockCallTool,
    runDevelopLoopScenario,
} from './helpers/mock-sprint-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// =============================================================================
// Held KB writes WARN: a write, confirmation or demotion still held when the
// sprint ends is reported once, listing each held write (tool plus title or
// id), on every exit that reaches the engine entry point and from the
// fatal-diagnostics handler. A real createKbWorkClient is injected through the
// workflow's own `kbWork` (main() reads context.kbWork), with its maintainer
// unreachable so every write stays queued.
// =============================================================================

const REPO = 'github.com/org/repo';
const MAINT = Object.freeze({ id: 'id-maint', name: 'local', type: 'local' });
const capture = (title) => ({
    type: 'knowledge', title,
    summary: 'A held write used to prove the end-of-sprint WARN lists it.',
    content: 'src/widget-cache.ts builds its key as `${tenant}:${id}`; a cross-tenant read always misses.',
    source_files: ['src/widget-cache.ts'],
});

/** A real KB work client whose maintainer is unreachable, with two captures held. */
async function heldClient(logs) {
    const client = createKbWorkClient({
        maintainers: fakeMaintainerSelector({
            repoOf: { local: REPO }, maintainerOf: { [REPO]: MAINT },
        }),
        memberCall: async () => {
            const err = new Error('member local unreachable');
            err.code = 'E-CONNECT';
            throw err;
        },
        gPull: async () => {},
        log: (m) => logs.push(m),
    });
    await client.apply('doer', 'local', { kb_captures: [capture('held claim one'), capture('held claim two')] });
    assert.equal(client.pendingCount(), 2);
    logs.length = 0;
    return client;
}

const listLines = (logs) => logs.filter((l) => l.includes('are still queued'));
const assertListedOnce = (logs) => {
    const lines = listLines(logs);
    assert.equal(lines.length, 1, `exactly one held-writes WARN: ${JSON.stringify(logs)}`);
    assert.ok(lines[0].endsWith('not applied: kb_capture "held claim one", kb_capture "held claim two"'), lines[0]);
};

async function runScenario(tag, { planReviewerMode, stopOnPlanReview = false } = {}) {
    const { tempDir, epicBead } = await setup(tag);
    const logs = [];
    try {
        const mockFleetApi = buildMockFleetApi(tempDir, epicBead, [], [], planReviewerMode ? { planReviewerMode } : {});
        const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
        const kbWork = await heldClient(logs);
        if (stopOnPlanReview) {
            workflow.on('activity:start', (meta) => {
                if (meta && meta.type === 'agent' && /plan/i.test(String(meta.label || meta.agent || ''))) workflow.requestStop('test: cancel');
            });
        }
        let result = null;
        let error = null;
        try {
            // What WorkflowEngine.executeFile does, plus the kbWork seam main() reads.
            result = await workflow.runWithContext({
                target_issue: epicBead.id,
                members: ['local'],
                branch: uniqueMockBranch(tag),
                base_branch: 'main',
                goal: 'P1/P2',
                max_cycles: 5,
                callTool: defaultMockCallTool({ executeCommand: mockFleetApi.executeCommand }),
            }, (ctx) => main({ ...ctx, kbWork }));
        } catch (err) {
            error = err;
        }
        return { logs, result, error };
    } finally {
        await teardown(tempDir);
    }
}

describe('held KB writes WARN through the engine entry point', () => {
    test('(1) typed abort: the held writes are listed once', async () => {
        await withScenarioMarkers('held-kb-abort', async () => {
            const s = await runScenario('heldabort', { planReviewerMode: 'always-reject-free-text' });
            assert.ok(s.error, 'the sprint aborted');
            assert.notEqual(s.error.name, 'CancelledError');
            assertListedOnce(s.logs);
        });
    });

    test('(2) cancel: the held writes are listed once', async () => {
        await withScenarioMarkers('held-kb-cancel', async () => {
            const s = await runScenario('heldcancel', { stopOnPlanReview: true });
            assert.ok(s.error instanceof CancelledError || (s.error && s.error.name === 'CancelledError'), `cancelled: ${s.error && s.error.name}`);
            assertListedOnce(s.logs);
        });
    });

    test('(5) PASS sprint: the list prints exactly once, not per phase plus finally', async () => {
        await withScenarioMarkers('held-kb-pass', async () => {
            const s = await runScenario('heldpass');
            assert.equal(s.error, null, `no error: ${s.error && s.error.message}`);
            assert.equal(s.result && s.result.status, 'success');
            assertListedOnce(s.logs);
        });
    });

    test('(3) plan-rejected carry-over exit (returned, not thrown): the held writes are listed once', async () => {
        await withScenarioMarkers('held-kb-carry-over', async () => {
            const logs = [];
            const kbWork = await heldClient(logs);
            const report = (obj) => ({ content: [{ text: JSON.stringify(obj) }] });
            const ids = (prompt) => {
                const m = prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
                return m ? m[1].split(',').map((x) => x.trim()).filter(Boolean) : [];
            };
            const filed = [];
            let planCalls = 0;
            const FINDING = 'No in-repo change can meet the open bug; a human must decide.';
            const run = await runDevelopLoopScenario('heldcarry', {
                members: ['local'],
                goal: 'P1/P2',
                taskSpecs: [{ title: 'Task: closes in cycle one', priority: 'P1' }],
                maxCycles: 3,
                withRunbooks: true,
                withRegressionPlaybook: true,
                kbWork,
                doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                    const assigned = ids(opts.prompt);
                    for (const id of assigned) await rc(`bd close ${id} --reason "Done"`, td);
                    return report({ status: 'VERIFY', closedIds: assigned, notes: 'Closed.' });
                },
                reviewerHandler: async () => report({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }),
                finalReviewHandler: async () => report({ verdict: 'PASS', notes: 'PASS.' }),
                regressionHandler: async () => report({ passed: true, suitePassed: true, smokePassed: true, bugsFiled: [], summary: 'ok' }),
                integHandler: async ({ epicBead, runCmd: rc, tempDir: td }) => {
                    if (filed.length === 0) {
                        const out = await rc(`bd create -t bug "Bug: budget cannot be met" -d "Filed by integration test." -p P1 --parent ${epicBead.id} --silent`, td);
                        filed.push(String(out.stdout || '').trim());
                        return report({ featuresClosed: 0, issuesCreated: 1, passed: false, bugsFiled: [...filed], summary: 'Filed a bug.' });
                    }
                    return report({ featuresClosed: 0, issuesCreated: 0, passed: true, bugsFiled: [], summary: 'Nothing to verify.' });
                },
                planReviewerHandler: async () => {
                    planCalls++;
                    if (planCalls === 1) return report({ verdict: 'APPROVED', notes: 'Plan approved.', taskAssignments: [] });
                    return report({
                        verdict: 'CHANGES_NEEDED', notes: FINDING, taskAssignments: [],
                        findings: filed.map((id) => ({ id, kind: 'feasibility', detail: FINDING })),
                    });
                },
            });
            assert.ok(!run.error, `carry-over is a returned exit: ${run.error && run.error.message}`);
            assert.equal(run.result.exitReason, 'plan-rejected-carry-over', JSON.stringify(run.result));
            assertListedOnce(run.logs.concat(logs));
        });
    });
});

describe('held KB writes WARN: client and fatal handler', () => {
    test('(4) the fatal-diagnostics handler reports held writes, once even if it fires twice', async () => {
        const logs = [];
        const client = await heldClient(logs);
        const uninstall = installFatalDiagnosticsGuard({ log: (m) => logs.push(m), kbWorkOf: () => client });
        const listeners = process.listeners('uncaughtException');
        const handler = listeners[listeners.length - 1];
        try {
            handler(new Error('boom'));
            handler(new Error('boom again'));
        } finally {
            uninstall();
        }
        assert.ok(logs.some((l) => l.startsWith('[FATAL] uncaughtException')), JSON.stringify(logs));
        assertListedOnce(logs);
    });

    test('(4b) a throwing or absent kbWorkOf never breaks the fatal handler', () => {
        const logs = [];
        const uninstall = installFatalDiagnosticsGuard({ log: (m) => logs.push(m), kbWorkOf: () => { throw new Error('no kb'); } });
        const listeners = process.listeners('uncaughtException');
        const handler = listeners[listeners.length - 1];
        try { handler(new Error('boom')); } finally { uninstall(); }
        assert.ok(logs.some((l) => l.includes('failed to report held KB writes')), JSON.stringify(logs));
    });

    test('(6) pending confirmations and demotions are listed by id', async () => {
        const logs = [];
        const client = createKbWorkClient({
            maintainers: fakeMaintainerSelector({ repoOf: { local: REPO }, maintainerOf: { [REPO]: MAINT } }),
            memberCall: async (m, tool, args) => {
                if (tool === 'kb_query') return { l1_results: [{ id: 'kb-promo' }] };
                if (tool === 'kb_promote') return { id: args.id, previous_confidence: 'INFERRED', new_confidence: 'CONFIRMED' };
                return {};
            },
            gPull: async () => {},
            log: (m) => logs.push(m),
        });
        await client.promotionCandidates('local');
        await client.apply('reviewer', 'local', { kb_promotions: [{ id: 'kb-promo', reason: 'Verified against src/widget-cache.ts:42 and its test.' }] });
        assert.deepEqual(client.pendingConfirmations(REPO), ['kb-promo']);
        logs.length = 0;
        client.warnPending();
        client.warnPending();
        const lines = logs.filter((l) => l.includes('confirmation(s)'));
        assert.equal(lines.length, 1);
        assert.ok(lines[0].endsWith(': kb-promo'), lines[0]);
    });
});
