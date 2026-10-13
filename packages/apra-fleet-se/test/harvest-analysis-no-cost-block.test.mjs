import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHarvestPhase } from '../fleet-sprint/phases/harvest.mjs';
import { buildSprintPrBody } from '../fleet-sprint/pr-body.mjs';
import { createRecordingCtx } from './helpers/dispatch-role-harness.mjs';

// =============================================================================
// The harvester commits its analysisText to the product branch, so that text
// must carry no Cost heading and no spend figures. The Publish PR body still
// renders the Cost section from the cost block the Harvest phase returns.
// =============================================================================

const COST_MARKER = 'COST-MARKER-9f3a spend=$12.34';
const REPORT_MARKER = 'SPRINT-REPORT-BODY-7c1d';

async function runHarvest() {
    const { ctx, rec } = createRecordingCtx({ responses: [{ status: 'OK', notes: 'harvested' }] });
    const out = await runHarvestPhase({
        phase: () => {},
        log: () => {},
        dispatchCtx: ctx,
        validated: { branch: 'feat/cost-split', baseBranch: 'main' },
        targetIssues: ['issue-1'],
        finalCycleLabel: '1',
        budget: {},
        closedCountHistory: [],
        highWaterClosedCount: 0,
        deployFailures: [],
        integFailures: [],
        rejectedNewTasks: [],
        integTestRunnerSpend: 0,
        integTestRunnerDispatchCount: 0,
        finalVerdictResult: { verdict: 'PASS' },
        finalClosedCount: 1,
        finalOpenAtGoalCount: 0,
        finalDeferredAtGoalIds: [],
        regressionResult: null,
        computeBranchSlug: (b) => b.replace(/[^A-Za-z0-9]+/g, '-'),
        buildAnalysisText: () => `# Sprint analysis\n\n${REPORT_MARKER}`,
        buildCostAnalysis: () => COST_MARKER,
    });
    return { out, rec };
}

test('assertion 1: the harvester dispatch prompt (and the analysis text it writes) has no Cost heading or cost marker', async () => {
    const { rec } = await runHarvest();
    assert.equal(rec.dispatches.length, 1, 'exactly one harvester dispatch');
    const prompt = rec.dispatches[0].prompt;
    assert.ok(prompt.includes(REPORT_MARKER), 'the sprint report still reaches the harvester');
    assert.ok(!prompt.includes('COST-MARKER-9f3a'), 'no cost figures in the harvester prompt');
    assert.ok(!prompt.includes('spend=$12.34'), 'no cost figures in the harvester prompt');
    assert.ok(!/^#{1,6}\s*Cost\b/mi.test(prompt), 'no Cost heading in the harvester prompt');
});

test('assertion 2: the PR body built for the same run still carries the Cost section', async () => {
    const { out } = await runHarvest();
    assert.equal(out.costAnalysis, COST_MARKER, 'the Harvest phase still hands the cost block to Publish PR');
    const body = buildSprintPrBody({
        verdict: 'PASS',
        goal: 'g',
        branch: 'feat/cost-split',
        baseBranch: 'main',
        runId: 'run-1',
        notes: 'ok',
        costAnalysis: out.costAnalysis,
    });
    assert.ok(/^### Cost$/m.test(body), 'PR body has its Cost section');
    assert.ok(body.includes('COST-MARKER-9f3a'), 'PR body carries the cost marker');
});
