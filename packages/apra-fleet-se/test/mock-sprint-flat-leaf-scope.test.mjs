import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import os from 'os';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import { runCmd } from './helpers/bd-replay.mjs';
import { buildMockFleetApi, mockCmdResult, withScenarioMarkers, teardown } from './helpers/mock-sprint-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, '../fleet-sprint/runner.js');

// apra-fleet flat-leaf-scope: a distinct diagnosability regression. The
// orchestrator member's own bd clone is entirely stale/uninitialized for
// these 5 fresh ids -- simulating the real-world shape: they were created
// on a DIFFERENT clone that was never `bd dolt push`ed to the shared remote,
// or an always-on multi-sprint supervisor's persistent member has not synced
// them (see pre-sprint-validation-stale-clone.test.mjs's apra-fleet-eft.36
// for the single-target precedent this mirrors -- that fix's D-pull recovers
// a MERELY-stale clone; this scenario is a clone that never had this data at
// all, e.g. no dolt remote configured / never pulled from one, which no
// D-pull can invent). Every `bd list ... --json` read is answered with an
// EMPTY result regardless of its filter args, exactly like a clone that has
// never seen any of these ids. Before this fix, that produced the exact same
// "Nothing to do" text as the legitimate all-done case; this test pins the
// new, distinguishing diagnostic instead.
test('flat multi-id target scope: targets invisible to the orchestrator clone get a distinguishing diagnostic, not a generic "Nothing to do"', async () => {
    await withScenarioMarkers('flat-leaf-invisible', async () => {
        const tempDir = path.join(os.tmpdir(), `apra-fleet-mock-sprint-flat-leaf-inv-${Date.now()}-${process.pid}`);
        await fs.mkdir(tempDir, { recursive: true });
        await runCmd('bd init', tempDir);

        // These 5 ids are never actually created in tempDir's bd database at
        // all -- standing in for "created/mutated on a clone this
        // orchestrator member has never synced with". A syntactically valid
        // fabricated id is enough: bdListScoped's scopeIds seed is
        // unconditional (seeded straight from targetIssues, regardless of
        // whether fetchAllBeadsShared() ever saw them -- see runner.js), so
        // the failure this test targets is purely about VISIBILITY, not
        // about scopeIds construction.
        const ids = ['apra-fleet-fake0', 'apra-fleet-fake1', 'apra-fleet-fake2', 'apra-fleet-fake3', 'apra-fleet-fake4'];

        const dispatched = [];
        const commandLog = [];
        let passed = false;
        try {
            const epicBead = { id: ids[0] };
            const baseApi = buildMockFleetApi(tempDir, epicBead, dispatched, commandLog, {
                planReviewerMode: 'approve-immediately',
                addExtraTaskDuringPlan: false,
            });
            // Every `bd list ... --json` read (fetchAllBeadsShared's
            // `--all`, and bdListScoped's second-query `--ready`/`--status=...`
            // filter queries) comes back empty, regardless of args -- exactly
            // what a clone that has never synced these ids would report.
            const mockFleetApi = {
                executePrompt: baseApi.executePrompt,
                executeCommand: async (opts) => {
                    if (/^bd list\b.*--json\b/.test(opts.command)) {
                        commandLog.push(opts.command);
                        return mockCmdResult(0, '[]', '');
                    }
                    return baseApi.executeCommand(opts);
                },
            };
            const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir }, '[flat-leaf-invisible] ');
            const engine = new WorkflowEngine(workflow);

            let error = null;
            try {
                await engine.executeFile(scriptPath, {
                    target_issues: ids,
                    members: ['local'],
                    branch: 'auto-sprint/mock-flat-leaf-invisible',
                    base_branch: 'main',
                    goal: 'P1/P2',
                    max_cycles: 1,
                }, true);
            } catch (err) {
                error = err;
            }

            assert.ok(error, 'expected pre-sprint validation to throw when every target id is invisible to this clone');
            assert.ok(
                error.message.includes('are not visible to the orchestrator member'),
                `expected the new distinguishing diagnostic, got: ${error.message}`
            );
            for (const id of ids) {
                assert.ok(error.message.includes(id), `expected the diagnostic to name invisible id ${id}, got: ${error.message}`);
            }
            assert.ok(
                !/Nothing to do\.$/.test(error.message),
                `expected the invisible-target diagnostic to replace the generic "Nothing to do." message, got: ${error.message}`
            );
            passed = true;
        } finally {
            console.log(`=== END scenario: flat-leaf-invisible (${passed ? 'PASS' : 'FAIL'}) ===`);
            await teardown(tempDir);
        }
    });
});
