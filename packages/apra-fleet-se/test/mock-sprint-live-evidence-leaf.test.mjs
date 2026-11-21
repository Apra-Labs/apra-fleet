// =============================================================================
// End-to-end mock sprints for verification-only leaves: a childless bead whose
// acceptance needs live evidence from the integration-test runner, marked with
// the live-evidence label (LIVE_EVIDENCE_LABEL in fleet-sprint/beads-scope.mjs).
// Before the marker, such a leaf was handed to a doer, which must refuse it
// (doers never manufacture integration evidence), so the sprint stalled.
//
//   (a) a sprint epic with a normal task T and a marked childless task L;
//       playbook and deploy.md present, the deploy succeeds. L is never in a
//       doer dispatch; the first Integration Test prompt names L as a verify
//       target; the scripted integ runner closes L with evidence; the sprint
//       completes without SPRINT_STALLED.
//   (b) the same, but the integ runner leaves L open on every pass
//       (inconclusive, no gap bug). After the needs-external-evidence limit
//       the run reaches Final Review / Finalization with verdict FAIL whose
//       notes name L as needs-external-evidence; no StalledSprintError.
//   (c) L carries NO marker; the scripted doer returns BLOCKED with
//       liveEvidenceIds [L]. L gets the marker, is not set aside as plain
//       doer-BLOCKED, and the next Integration Test phase names it as a
//       verify target.
//
// Reverts that make these fail:
//   - reverting the classifyVerifySet marker change (fleet-sprint/
//     beads-scope.mjs: the childless-leaf branch, plus readyLeafBeads'
//     liveEvidenceLeafIds exclusion) makes (a) fail: L is dispatched to the
//     doer and never named in the Integration Test verify clause.
//   - reverting the liveEvidenceIds handling in fleet-sprint/phases/
//     develop.mjs makes (c) fail: L is set aside as plain doer-BLOCKED and
//     never carries the marker, so Integration Test never names it.
//
// No real LLM CLI is used (every dispatch is a scripted handler); every bd
// call is replayed from test/fixtures/bd-recordings unless run in record or
// real mode; all beads state lives in the per-scenario temp clone.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { extractVerifyIds } from './helpers/verify-clause.mjs';
import { StalledSprintError } from '../fleet-sprint/errors.mjs';
import { LIVE_EVIDENCE_LABEL } from '../fleet-sprint/beads-scope.mjs';
import { NEEDS_EXTERNAL_EVIDENCE_CYCLE_LIMIT } from '../fleet-sprint/verify-carry-over.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';

const resetSyncMemo = () => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
};
const assignedIds = (prompt) => {
    const match = prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const report = (obj) => ({ content: [{ text: JSON.stringify(obj) }] });
const approve = async () => report({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] });
const rubberStampPass = async () => report({ verdict: 'PASS', notes: 'Rubber-stamp PASS from the final reviewer.' });
const passingRegression = () => report({ passed: true, suitePassed: true, smokePassed: true, bugsFiled: [], summary: 'Mock regression pass.' });
const errText = (run) => (run.error ? `${run.error.constructor.name}: ${run.error.message}` : 'none');

const NORMAL = 'Task: normal implementation work';
const LIVE = 'Task: verify the change on a live deployment';
const EXTERNAL_REASON = 'the live evidence needs a host the sprint members do not have';

const idOf = (tasks, title) => tasks.find((t) => t.title === title).id;

test('(a) a marked live-evidence leaf is never dispatched to a doer, is named by Integration Test, and closes there; no stall', async () => {
    resetSyncMemo();
    await withScenarioMarkers('live-evidence leaf closes in integ', async () => {
        let liveId = null;
        const doerAssigned = [];
        const integVerifyLists = [];
        const run = await runDevelopLoopScenario('live-leaf-close', {
            members: ['local'],
            taskSpecs: [{ title: NORMAL, priority: 'P1' }, { title: LIVE, priority: 'P1' }],
            maxCycles: 4,
            withRunbooks: true,
            withRegressionPlaybook: true,
            beforeSprint: async ({ tempDir, runCmd, tasks }) => {
                liveId = idOf(tasks, LIVE);
                await runCmd(`bd update ${liveId} --add-label ${LIVE_EVIDENCE_LABEL}`, tempDir);
            },
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts.prompt);
                doerAssigned.push(...ids);
                for (const id of ids) await rc(`bd close ${id} --reason "Done"`, td);
                return report({ status: 'VERIFY', closedIds: ids, notes: 'Closed.' });
            },
            reviewerHandler: approve,
            finalReviewHandler: rubberStampPass,
            regressionHandler: passingRegression,
            integHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const verifyIds = extractVerifyIds(opts.prompt);
                integVerifyLists.push(verifyIds);
                if (!verifyIds.includes(liveId)) {
                    return report({ featuresClosed: 0, issuesCreated: 0, passed: true, bugsFiled: [], summary: 'Nothing to verify.' });
                }
                await rc(`bd close ${liveId} --reason "Live check: ran the playbook smoke step, observed the expected output"`, td);
                return report({
                    featuresClosed: 0, issuesCreated: 0, passed: true, bugsFiled: [],
                    verifySetClosed: [liveId], verifySetLeftOpen: [],
                    summary: `Verified ${liveId} on the deployed build.`,
                });
            },
        });

        assert.ok(!(run.error instanceof StalledSprintError), `no StalledSprintError: ${errText(run)}`);
        assert.ok(!run.error, `the run finishes: ${errText(run)}`);
        assert.ok(!doerAssigned.includes(liveId), `the live-evidence leaf never reaches a doer: ${JSON.stringify(doerAssigned)}`);
        assert.ok(doerAssigned.includes(idOf(run.tasks, NORMAL)), 'the normal task is worked by a doer');
        assert.ok(integVerifyLists.length > 0, 'Integration Test ran');
        assert.ok(integVerifyLists[0].includes(liveId), `the first Integration Test prompt names the leaf: ${JSON.stringify(integVerifyLists)}`);
        const firstInteg = run.dispatched.find((d) => d.agent === 'integ-test-runner');
        assert.ok(firstInteg.prompt.includes(LIVE_EVIDENCE_LABEL), 'the verify clause names the leaf as a live-evidence bead');
        assert.equal(run.finalBeadsById.get(liveId).status, 'closed', 'the integ runner closed the leaf');
        assert.ok(run.dispatched.some((d) => d.label === 'Final Review'), 'Final Review must be dispatched');
        assert.equal(run.result.verdict, 'PASS', JSON.stringify(run.result));
    });
});

test('(b) a live-evidence leaf the integ runner leaves open is carried over as needs-external-evidence: Finalization runs, verdict FAIL names it', async () => {
    resetSyncMemo();
    await withScenarioMarkers('live-evidence leaf needs external evidence', async () => {
        let liveId = null;
        let liveVerifyDispatches = 0;
        const doerAssigned = [];
        const run = await runDevelopLoopScenario('live-leaf-nee', {
            members: ['local'],
            taskSpecs: [{ title: NORMAL, priority: 'P1' }, { title: LIVE, priority: 'P1' }],
            maxCycles: 6,
            withRunbooks: true,
            withRegressionPlaybook: true,
            beforeSprint: async ({ tempDir, runCmd, tasks }) => {
                liveId = idOf(tasks, LIVE);
                await runCmd(`bd update ${liveId} --add-label ${LIVE_EVIDENCE_LABEL}`, tempDir);
            },
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts.prompt);
                doerAssigned.push(...ids);
                for (const id of ids) await rc(`bd close ${id} --reason "Done"`, td);
                return report({ status: 'VERIFY', closedIds: ids, notes: 'Closed.' });
            },
            reviewerHandler: approve,
            finalReviewHandler: rubberStampPass,
            regressionHandler: passingRegression,
            integHandler: async ({ opts }) => {
                const inVerify = extractVerifyIds(opts.prompt).includes(liveId);
                if (inVerify) liveVerifyDispatches++;
                return report({
                    featuresClosed: 0, issuesCreated: 0, passed: true, bugsFiled: [],
                    ...(inVerify ? { verifySetClosed: [], verifySetLeftOpen: [{ id: liveId, reason: EXTERNAL_REASON }] } : {}),
                    summary: inVerify ? `Could not collect live evidence for ${liveId} here.` : 'Nothing to verify.',
                });
            },
        });

        assert.ok(!(run.error instanceof StalledSprintError), `no StalledSprintError: ${errText(run)}`);
        assert.ok(!run.error, `the run finishes: ${errText(run)}`);
        assert.ok(!doerAssigned.includes(liveId), 'the live-evidence leaf never reaches a doer');
        assert.equal(liveVerifyDispatches, NEEDS_EXTERNAL_EVIDENCE_CYCLE_LIMIT, 'carried over exactly at the limit');
        assert.ok(run.logs.some((l) => l.includes(liveId) && /carried over as needs-external-evidence/.test(l)), 'the carry-over is logged');
        assert.ok(run.dispatched.some((d) => d.label === 'Final Review'), 'Final Review must be dispatched');
        assert.equal(run.result.verdict, 'FAIL', JSON.stringify(run.result));
        assert.ok(run.result.notes.includes('needs-external-evidence') && run.result.notes.includes(liveId) && run.result.notes.includes(EXTERNAL_REASON), run.result.notes);
        assert.deepEqual(run.result.verifyCarryOver.map((e) => [e.id, e.kind]), [[liveId, 'needs-external-evidence']]);
        assert.notEqual(run.finalBeadsById.get(liveId).status, 'closed', 'the carried-over leaf stays open');
    });
});

test('(c) a doer BLOCKED report with liveEvidenceIds labels the bead, does not set it aside, and the next Integration Test names it', async () => {
    resetSyncMemo();
    await withScenarioMarkers('doer liveEvidenceIds routes to integ', async () => {
        let liveId = null;
        let normalId = null;
        const doerAssigned = [];
        const integVerifyLists = [];
        const run = await runDevelopLoopScenario('live-leaf-doer', {
            members: ['local'],
            taskSpecs: [{ title: NORMAL, priority: 'P1' }, { title: LIVE, priority: 'P1' }],
            maxCycles: 4,
            withRunbooks: true,
            withRegressionPlaybook: true,
            beforeSprint: async ({ tasks }) => {
                liveId = idOf(tasks, LIVE);
                normalId = idOf(tasks, NORMAL);
            },
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts.prompt);
                doerAssigned.push(...ids);
                const closable = ids.filter((id) => id !== liveId);
                for (const id of closable) await rc(`bd close ${id} --reason "Done"`, td);
                if (ids.includes(liveId)) {
                    return report({
                        status: 'BLOCKED', closedIds: closable, liveEvidenceIds: [liveId],
                        notes: 'Acceptance needs integration-phase evidence from a live deployment.',
                    });
                }
                return report({ status: 'VERIFY', closedIds: closable, notes: 'Closed.' });
            },
            reviewerHandler: approve,
            finalReviewHandler: rubberStampPass,
            regressionHandler: passingRegression,
            integHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const verifyIds = extractVerifyIds(opts.prompt);
                integVerifyLists.push(verifyIds);
                if (!verifyIds.includes(liveId)) {
                    return report({ featuresClosed: 0, issuesCreated: 0, passed: true, bugsFiled: [], summary: 'Nothing to verify.' });
                }
                await rc(`bd close ${liveId} --reason "Live check passed on the deployed build"`, td);
                return report({
                    featuresClosed: 0, issuesCreated: 0, passed: true, bugsFiled: [],
                    verifySetClosed: [liveId], verifySetLeftOpen: [],
                    summary: `Verified ${liveId} on the deployed build.`,
                });
            },
        });

        assert.ok(!(run.error instanceof StalledSprintError), `no StalledSprintError: ${errText(run)}`);
        assert.ok(!run.error, `the run finishes: ${errText(run)}`);
        assert.equal(doerAssigned.filter((id) => id === liveId).length, 1, `the bead reaches a doer exactly once: ${JSON.stringify(doerAssigned)}`);
        assert.ok(doerAssigned.includes(normalId), 'the normal task is worked by a doer');
        assert.ok(run.commandLog.some((c) => c.includes(`bd update ${liveId} --add-label ${LIVE_EVIDENCE_LABEL}`)), 'the engine applied the marker label');
        assert.ok((run.finalBeadsById.get(liveId).labels || []).includes(LIVE_EVIDENCE_LABEL), 'the bead carries the marker label');
        assert.ok(!run.logs.some((l) => l.includes('Doer BLOCKED set-aside') && l.includes(liveId)), 'not set aside as plain doer-BLOCKED');
        assert.ok(run.logs.some((l) => l.includes('Doer live-evidence') && l.includes(liveId)), 'the live-evidence routing is logged');
        const firstNaming = integVerifyLists.findIndex((ids) => ids.includes(liveId));
        assert.ok(firstNaming >= 0, `an Integration Test phase names the bead: ${JSON.stringify(integVerifyLists)}`);
        assert.equal(run.finalBeadsById.get(liveId).status, 'closed', 'the integ runner closed it');
        assert.equal(run.result.verdict, 'PASS', JSON.stringify(run.result));
    });
});

test('(d) without integ-test-playbook.md / deploy.md a live-evidence leaf is carried over with a typed reason, never a stall', async () => {
    resetSyncMemo();
    await withScenarioMarkers('live-evidence leaf without runbooks', async () => {
        let liveId = null;
        const doerAssigned = [];
        const run = await runDevelopLoopScenario('live-leaf-norunbook', {
            members: ['local'],
            taskSpecs: [{ title: NORMAL, priority: 'P1' }, { title: LIVE, priority: 'P1' }],
            maxCycles: 4,
            beforeSprint: async ({ tempDir, runCmd, tasks }) => {
                liveId = idOf(tasks, LIVE);
                await runCmd(`bd update ${liveId} --add-label ${LIVE_EVIDENCE_LABEL}`, tempDir);
            },
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts.prompt);
                doerAssigned.push(...ids);
                for (const id of ids) await rc(`bd close ${id} --reason "Done"`, td);
                return report({ status: 'VERIFY', closedIds: ids, notes: 'Closed.' });
            },
            reviewerHandler: approve,
            finalReviewHandler: rubberStampPass,
        });

        assert.ok(!(run.error instanceof StalledSprintError), `no StalledSprintError: ${errText(run)}`);
        assert.ok(!run.error, `the run finishes: ${errText(run)}`);
        assert.ok(!doerAssigned.includes(liveId), 'the live-evidence leaf never reaches a doer');
        assert.ok(run.dispatched.some((d) => d.label === 'Final Review'), 'Final Review must be dispatched');
        assert.equal(run.result.verdict, 'FAIL', JSON.stringify(run.result));
        assert.deepEqual(run.result.verifyCarryOver.map((e) => [e.id, e.kind]), [[liveId, 'needs-external-evidence']]);
        assert.ok(run.result.notes.includes(liveId) && run.result.notes.includes('cannot run in this run (no-playbook)'), run.result.notes);
        assert.notEqual(run.finalBeadsById.get(liveId).status, 'closed');
    });
});
