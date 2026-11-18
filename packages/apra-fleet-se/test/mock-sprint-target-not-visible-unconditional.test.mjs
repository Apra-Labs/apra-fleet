import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import { setupMinimal, buildMockFleetApi, teardown, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, '../fleet-sprint/runner.js');

// A direct launch whose target list holds one resolvable id WITH ready work
// plus one id that does not exist must fail at Sprint Setup with
// TARGET_NOT_VISIBLE naming the bad id -- before any dispatch or bead
// mutation -- instead of running a full sprint on the valid id.
test('one resolvable target (with ready work) plus one unresolvable id fails at Sprint Setup with TARGET_NOT_VISIBLE, before any dispatch or bead mutation', async () => {
    await withScenarioMarkers('target-not-visible-mixed', async () => {
        const { tempDir, epicBead } = await setupMinimal('target-not-visible-mixed', [{ title: 'Task: ready work under the valid target' }]);
        const dispatched = [];
        const commandLog = [];
        const badId = 'apra-fleet-nosuchid9';
        let passed = false;
        try {
            const mockFleetApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, {
                planReviewerMode: 'approve-immediately',
                addExtraTaskDuringPlan: false,
            });
            const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir }, '[target-not-visible-mixed] ');
            const engine = new WorkflowEngine(workflow);
            let error = null;
            try {
                await engine.executeFile(scriptPath, {
                    target_issues: [epicBead.id, badId],
                    members: ['local'],
                    branch: 'auto-sprint/mock-target-not-visible-mixed',
                    base_branch: 'main',
                    goal: 'P1/P2',
                    max_cycles: 1,
                }, true);
            } catch (err) {
                error = err;
            }
            assert.ok(error, 'expected Sprint Setup to refuse the launch');
            assert.match(error.message, /are not visible to the backlog member/);
            assert.ok(error.message.includes(badId), error.message);
            assert.deepEqual(error.details?.invisibleTargets, [badId], 'only the unresolvable id is reported, never the valid one');
            const reason = error.details?.reason ?? error.reason;
            assert.equal(reason, 'TARGET_NOT_VISIBLE', JSON.stringify(error.details));
            assert.equal(dispatched.length, 0, `no dispatch before the refusal: ${JSON.stringify(dispatched.map((d) => d.agent))}`);
            const mutations = commandLog.filter((c) => /\bbd\s+(update|close|create|reopen|dep|remember|forget)\b/.test(c));
            assert.deepEqual(mutations, [], 'no bead mutation before the refusal');
            passed = true;
        } finally {
            console.log(`=== END scenario: target-not-visible-mixed (${passed ? 'PASS' : 'FAIL'}) ===`);
            await teardown(tempDir);
        }
    });
});
