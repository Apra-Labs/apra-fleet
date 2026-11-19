import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';
import { PAUSED_AWAITING_DECISION } from '../fleet-sprint/decision-wait.mjs';

// =============================================================================
// The scoped in-cycle replan planner shares planner.md's contract, so it may
// return a NEEDS-DECISION `decision`. phases/replan.mjs must route it like
// phases/plan.mjs: a separate decision bead, the work bead set aside (never
// labelled human), the scoped plan-reviewer told the bead is non-blocking, and
// a finding naming only that bead not treated as a rejection. A scoped replan
// without a decision is unchanged (mock-sprint-replan-short-circuit.test.mjs).
// =============================================================================

const check = (cond, msg) => assert.ok(cond, msg);
const QUESTION = 'The criteria can only be met by upgrading the vendored parser or carrying a local patch; nothing in the bead ' +
    'or the code says which is acceptable. Which should the bead take?';
const OPTIONS = [
    { id: 'a', text: 'Upgrade the parser to the next major.' },
    { id: 'b', text: 'Carry a local patch file.' },
];
const HELD_CLAUSE = 'SET ASIDE FOR AN OPERATOR DECISION';
const X = 'Task: Replan target X';

test('mock sprint: a decision returned by the scoped replan planner is filed, sets the bead aside, and is non-blocking for the scoped plan-reviewer', async () => {
    invalidateSyncRemoteCache(); clearLastSyncedTip(); clearTipProbeFailures();
    await withScenarioMarkers('scoped replan needs-decision', async () => {
        const seen = { scopedReviewPrompts: [], states: [] };
        const sc = await runDevelopLoopScenario('replandec', {
            members: ['local'],
            taskSpecs: [{ title: X }],
            maxCycles: 1,
            onWorkflow: async (workflow) => {
                workflow.on('state', (e) => { if (e.namespace === 'decisions') seen.states.push(e.data); });
                workflow.on('pause:requested', (e) => {
                    if (e.source === 'needs_decision') workflow.requestStop('test: stop at the decision pause');
                });
            },
            reviewerHandler: async ({ tempDir, runCmd, epicBead, reviewRound }) => {
                if (reviewRound === 1) {
                    const list = JSON.parse((await runCmd(`bd list --parent ${epicBead.id} --all --json`, tempDir)).stdout || '[]');
                    const x = list.find((b) => b.title.includes('Replan target X'));
                    return { content: [{ text: JSON.stringify({
                        verdict: 'CHANGES_NEEDED', notes: `${x.id}'s criteria are defective.`,
                        reopenIds: [x.id], replanIds: [x.id], newTasks: [],
                    }) }] };
                }
                return { content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'ok', reopenIds: [], newTasks: [] }) }] };
            },
            plannerHandler: async ({ opts, tempDir, runCmd }) => {
                const report = { status: 'OK', notes: 'Plan ready.', featureIds: [], taskIds: [] };
                if (opts.prompt.includes('SCOPED IN-CYCLE REPLAN')) {
                    const list = JSON.parse((await runCmd('bd list --all --json', tempDir)).stdout || '[]');
                    const x = list.find((b) => b.title === X);
                    report.notes = 'Scoped replan; the bead needs an operator decision.';
                    report.decision = { beadId: x.id, question: QUESTION, options: OPTIONS, recommendation: 'a, the patch is carried forever.' };
                }
                return { content: [{ text: `Done.\n\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\`\n` }] };
            },
            planReviewerHandler: async ({ opts, tempDir, runCmd }) => {
                if (!opts.prompt.includes('SCOPED IN-CYCLE REPLAN REVIEW')) {
                    return { content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', taskAssignments: [] }) }] };
                }
                seen.scopedReviewPrompts.push(opts.prompt);
                const list = JSON.parse((await runCmd('bd list --all --json', tempDir)).stdout || '[]');
                const x = list.find((b) => b.title === X);
                return { content: [{ text: JSON.stringify({
                    verdict: 'CHANGES_NEEDED', notes: `${x.id} needs rework.`,
                    findings: [{ id: x.id, kind: 'coverage', detail: `${x.id} is unresolved.` }], taskAssignments: [],
                }) }] };
            },
        });
        const xId = sc.tasks.find((t) => t.title === X).id;

        const line = sc.logs.find((m) => m.includes('NEEDS-DECISION set-aside'));
        check(line, 'the scoped planner decision is recorded');
        const rec = JSON.parse(line.slice(line.indexOf('Request: ') + 'Request: '.length));
        assert.equal(rec.beadId, xId);
        check(rec.raisedBy.startsWith('planner (Replan C1'), `raised by the scoped planner: ${rec.raisedBy}`);
        check(rec.decisionBeadId && rec.decisionBeadId !== xId, 'a separate decision bead');
        const decisionBead = sc.finalBeadsById.get(rec.decisionBeadId);
        check(decisionBead && (decisionBead.labels || []).includes('human'), 'decision bead labelled human');
        check(decisionBead.description.includes(QUESTION), 'decision bead holds the question');
        const work = sc.finalBeadsById.get(xId);
        assert.notEqual(work.status, 'closed', 'the work bead stays open');
        check(!(work.labels || []).includes('human'), 'the work bead is never labelled human');

        assert.equal(seen.scopedReviewPrompts.length, 1, 'one scoped plan-review');
        check(seen.scopedReviewPrompts[0].includes(HELD_CLAUSE) && seen.scopedReviewPrompts[0].includes(xId),
            'the scoped plan-reviewer prompt names the held bead as non-blocking');
        check(sc.logs.some((m) => m.includes('scoped replan: CHANGES_NEEDED names only bead(s) set aside') && m.includes(xId)),
            'the finding naming only the held bead is non-blocking');
        check(seen.states.some((d) => d.state === PAUSED_AWAITING_DECISION), 'the run parked awaiting the decision');
    });
});
