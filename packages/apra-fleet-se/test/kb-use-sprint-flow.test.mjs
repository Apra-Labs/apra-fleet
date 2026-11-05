import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { createFakeFleet, buildCallTool, buildOnCommand } from './helpers/kb-fake-fleet.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { TEST_CONCURRENCY } from './helpers/test-concurrency.mjs';
import { validateVerdict } from '../fleet-sprint/contracts.mjs';

// =============================================================================
// kb_used / kb_wrong end to end (D4), through the REAL runner.js on the
// mock-sprint harness. Every role report the sprint receives -- planner,
// plan-reviewer, doer, per-round reviewer, harvester -- carries kb_used and
// kb_wrong. Every member is REMOTE, so the kb_feedback the engine sends for a
// kb_wrong item is an `apra-fleet call --member <uuid> --kb-maintainer
// kb_feedback` on the mocked callTool, recorded by the fake fleet
// (kb-fake-fleet.mjs) as the kb_maintainer's KB call.
//
// The doer's report holds a malformed kb_wrong item (a bare string) next to a
// well-formed one. The final review reports no KB use at all: the engine must
// log it once and carry on (no gate, no retry).
//
// Named without the mock-sprint- prefix on purpose: that prefix enrolls a file
// in phase3-dispatch-engine-completeness's nested re-run budget.
// =============================================================================

const REPO_URL = 'https://github.com/mock-org/mock-repo.git';

const WRONG = {
    planner: { id: 'kb-wrong-planner', reason: 'the module it names was split in two' },
    'plan-reviewer': { id: 'kb-wrong-plan-reviewer', reason: 'the sizing rule it states was retired' },
    doer: { id: 'kb-wrong-doer', reason: 'the flag it names was removed' },
    reviewer: { id: 'kb-wrong-reviewer', reason: 'the test it cites no longer exists' },
    harvester: { id: 'kb-wrong-harvester', reason: 'the doc path it gives moved' },
};
const MALFORMED = 'kb-wrong-bare-string';
const used = (role) => [{ id: `kb-used-${role}`, how: `the ${role} followed it` }];

/** The scripted report of each role, as the role would emit it. */
const REPORTS = {
    planner: (ids) => ({ status: 'OK', notes: 'Planned.', featureIds: [], taskIds: ids, kb_used: used('planner'), kb_wrong: [WRONG.planner] }),
    'plan-reviewer': () => ({ verdict: 'APPROVED', notes: 'Plan is sound.', taskAssignments: [], kb_used: used('plan-reviewer'), kb_wrong: [WRONG['plan-reviewer']] }),
    doer: (ids) => ({
        status: 'VERIFY', closedIds: ids, notes: 'done',
        toolUse: { kb: 'used', code: 'used' },
        kb_used: used('doer'),
        kb_wrong: [MALFORMED, WRONG.doer],
    }),
    reviewer: () => ({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [], kb_used: used('reviewer'), kb_wrong: [WRONG.reviewer] }),
    harvester: () => ({ status: 'OK', notes: 'Harvested.', kb_used: used('harvester'), kb_wrong: [WRONG.harvester] }),
};

const text = (obj) => ({ content: [{ text: JSON.stringify(obj) }] });

describe('mock sprint: kb_used and kb_wrong flow from every role', () => {
    test('every role report validates, each well-formed kb_wrong reaches kb_feedback once, a malformed one is logged and dropped, a zero-query dispatch is logged and never gated',
        { timeout: scaledTimeout(240000, { concurrency: TEST_CONCURRENCY }) }, async () => {
            await withScenarioMarkers('kb use flow', async () => {
                // Every scripted report is a schema-valid report for its role
                // (the permissive kb_used/kb_wrong typing), including the
                // doer's with the bare-string item.
                for (const [schemaName, report] of [
                    ['planReviewerVerdict', REPORTS['plan-reviewer']()],
                    ['doerReport', REPORTS.doer(['T-1'])],
                    ['reviewerVerdict', REPORTS.reviewer()],
                    ['harvesterReport', REPORTS.harvester()],
                ]) {
                    const checked = validateVerdict(schemaName, report);
                    assert.equal(checked.valid, true, `${schemaName}: ${JSON.stringify(checked.errors)}`);
                }

                const fleet = createFakeFleet();
                let finalReviews = 0;
                const r = await runDevelopLoopScenario('kbuse', {
                    members: ['maint', 'dev'],
                    roleMap: { doer: ['dev'], reviewer: ['dev'] },
                    beadsIdentity: { maint: { repoRemote: REPO_URL }, dev: { repoRemote: REPO_URL } },
                    taskSpecs: [{ title: 'Task: kb use reporting' }],
                    // The planner has no schema: its report is its final
                    // response text, exactly like a real planner's.
                    plannerHandler: async () => text(REPORTS.planner([])),
                    planReviewerHandler: async () => text(REPORTS['plan-reviewer']()),
                    doerHandler: async ({ opts, tempDir, runCmd }) => {
                        const ids = (opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/)?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
                        for (const id of ids) await runCmd(`bd close ${id}`, tempDir);
                        return text(REPORTS.doer(ids));
                    },
                    reviewerHandler: async () => text(REPORTS.reviewer()),
                    // No kb_used, no kb_wrong, no toolUse: a dispatch whose
                    // member made no KB query.
                    finalReviewHandler: async () => {
                        finalReviews++;
                        return text({ verdict: 'PASS', notes: 'All goal beads closed.' });
                    },
                    harvesterHandler: async () => text(REPORTS.harvester()),
                    maxCycles: 1,
                    callToolFactory: (executeCommand) => buildCallTool(fleet, executeCommand),
                    onCommand: buildOnCommand(fleet),
                });
                assert.equal(r.error, null, `sprint error: ${r.error && r.error.message}`);
                const kbUseLogs = r.logs.filter((l) => l.includes('[kb-use]') || l.includes('kb_feedback') || l.includes('[kb-work] feedback'));

                // The sprint proceeded through every role, each dispatched once.
                const count = (agent) => r.dispatched.filter((d) => d.agent === agent && d.label !== 'Final Review').length;
                for (const agent of ['plan-reviewer', 'doer', 'reviewer', 'harvester']) {
                    assert.equal(count(agent), 1, `${agent} dispatched once: ${JSON.stringify(r.dispatched.map((d) => d.agent))}`);
                }
                assert.ok(count('planner') >= 1, 'the planner was dispatched');
                assert.ok(!r.logs.some((l) => /schema-valid|repair attempt/i.test(l) && /kb_used|kb_wrong/.test(l)), 'no report was repaired over its KB fields');

                // One kb_feedback per well-formed kb_wrong item, with matching
                // id and reason, in the kb_maintainer's session.
                const feedback = fleet.events.filter((e) => e.type === 'kb' && e.tool === 'kb_feedback');
                assert.deepEqual(
                    feedback.map((e) => e.args.id).sort(),
                    Object.values(WRONG).map((w) => w.id).sort(),
                    `kb_feedback calls: ${JSON.stringify(feedback.map((e) => e.args))}\n${kbUseLogs.join('\n')}`,
                );
                for (const w of Object.values(WRONG)) {
                    const call = feedback.find((e) => e.args.id === w.id);
                    assert.equal(call.args.reason, w.reason);
                    assert.equal(call.member, 'maint', 'kb_feedback runs on the kb_maintainer');
                    assert.equal(call.grant, true, 'kb_feedback carries the kb_maintainer grant');
                }

                // The malformed item: logged, dropped, never sent.
                assert.ok(!feedback.some((e) => e.args.id === MALFORMED));
                assert.ok(r.logs.some((l) => l.includes('dropped malformed item') && l.includes(MALFORMED)), kbUseLogs.join('\n'));

                // The zero-query final review: logged once, no gate, no retry.
                assert.equal(finalReviews, 1, 'the final review ran once -- not retried for its missing KB use');
                const noQuery = r.logs.filter((l) => /\[kb-use\] reviewer on \S+: no KB query reported/.test(l));
                assert.equal(noQuery.length, 1, kbUseLogs.join('\n'));
                assert.match(noQuery[0], /never gated/);
            });
        });
});
