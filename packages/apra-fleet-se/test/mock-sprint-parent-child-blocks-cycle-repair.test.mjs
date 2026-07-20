import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import { runCmd, buildMockFleetApi, teardown, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-xbu.2.1: pre-sprint validation already DETECTS the self-inflicted
// "parent-child + blocks cycle" deadlock shape (a bead has a 'blocks'
// dependency on its own --parent ancestor/descendant, which `bd dep cycles`
// does not flag since it never walks parent-child edges) -- it used to just
// throw a diagnosis naming the exact `bd dep remove` fix. Since the repair
// commands are computed deterministically, runner.js now AUTO-REPAIRS this
// shape (removes the offending 'blocks' edge, re-queries --ready, and
// continues) instead of hard-failing.
//
// Reproducing this shape requires a MULTI-target sprint (`target_issues`,
// plural): the bead carrying the 'blocks' edge (P) must itself be fetched as
// a CHILD of one target (GP) while its own child (C, the edge's other end)
// is fetched as a child of P acting as a SECOND target -- `bd list --parent`
// is single-level only, so a single-target scope can never see both ends of
// the pair at once. This mirrors the real incident shape (e.g. apra-fleet-
// 0pu blocked by its own child apra-fleet-0pu.1, inside a multi-issue
// ruggedization-batch sprint).
// =============================================================================
async function setupCycleFixture(tag) {
    const tempDir = path.join(os.tmpdir(), `apra-fleet-mock-sprint-${tag}-${Date.now()}-${process.pid}`);
    await fs.mkdir(tempDir, { recursive: true });
    await runCmd('bd init', tempDir);

    const gpRes = await runCmd(`bd create -t epic "Epic: ${tag} grandparent" -d "Scenario grandparent." --silent`, tempDir);
    const gpId = gpRes.stdout.trim();
    const pRes = await runCmd(`bd create -t task "Task: ${tag} parent (blocked by its own child)" -d "Scenario parent." --silent`, tempDir);
    const pId = pRes.stdout.trim();
    await runCmd(`bd update ${pId} --parent ${gpId}`, tempDir);
    const cRes = await runCmd(`bd create -t task "Task: ${tag} child" -d "Scenario child." --silent`, tempDir);
    const cId = cRes.stdout.trim();
    await runCmd(`bd update ${cId} --parent ${pId}`, tempDir);
    // P (parent) blocked by C (its own child) -- the self-inflicted deadlock shape.
    const depRes = await runCmd(`bd dep add ${pId} ${cId}`, tempDir);
    if (depRes.err || (depRes.stderr && depRes.stderr.trim())) {
        throw new Error(`setupCycleFixture(${tag}): bd dep add failed: err=${depRes.err ? depRes.err.message : 'null'} stderr=${depRes.stderr}`);
    }

    return { tempDir, gpId, pId, cId };
}

async function runCycleScenario(tag, { members = ['local'], maxCycles = 1, beforeSprint } = {}) {
    const { tempDir, gpId, pId, cId } = await setupCycleFixture(tag);
    if (beforeSprint) await beforeSprint({ tempDir, pId, cId });

    const dispatched = [];
    const commandLog = [];
    const logs = [];
    try {
        // `epicBead` here is just an id-carrying reference for the mock's own
        // internal prompt/title bookkeeping -- the real scope comes from
        // `target_issues` below, not from this object.
        const mockFleetApi = buildMockFleetApi(tempDir, { id: gpId }, dispatched, commandLog, {
            planReviewerMode: 'approve-immediately',
            addExtraTaskDuringPlan: false,
        });
        const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir });
        workflow.on('log', (e) => logs.push(e.msg));
        const engine = new WorkflowEngine(workflow);
        const scriptPath = path.join(__dirname, '../auto-sprint/runner.js');

        let error = null;
        let result = null;
        try {
            result = await engine.executeFile(scriptPath, {
                target_issues: [gpId, pId],
                members,
                branch: `auto-sprint/mock-${tag}`,
                base_branch: 'main',
                goal: 'P1/P2',
                max_cycles: maxCycles,
            }, true);
        } catch (err) {
            error = err;
        }

        const finalBeadsRaw = JSON.parse((await runCmd('bd list --all --json', tempDir)).stdout || '[]');
        const finalBeadsById = new Map(finalBeadsRaw.map((b) => [b.id, b]));

        return { logs, error, result, gpId, pId, cId, finalBeadsById };
    } finally {
        await teardown(tempDir);
    }
}

test('mock sprint: pre-sprint validation auto-repairs a 2-node parent+blocks cycle instead of hard-failing', async () => {
    await withScenarioMarkers('xbucyclerepair', async () => {
        console.log('Running mock sprint scenario (multi-target: parent blocked by its own child -- auto-repair path)...');
        const { logs, error, pId, cId, finalBeadsById } = await runCycleScenario('xbucyclerepair');

        check(
            logs.some((m) => m.includes('Pre-sprint auto-repair (apra-fleet-xbu.2.1)') && m.includes(pId) && m.includes(cId) && m.includes('auto-removed via bd dep remove')),
            `Expected a distinct auto-repair log line naming both beads, logs: ${JSON.stringify(logs)}`
        );
        check(
            !logs.some((m) => m.includes('Pre-sprint validation failed: scope') && m.includes('deadlocked by')),
            `Did NOT expect the old hard-fail deadlock message once auto-repair succeeds, logs: ${JSON.stringify(logs)}`
        );
        // The repair must have actually removed the edge (not just logged
        // that it would) -- neither bead should carry a 'blocks' dependency
        // on the other anymore.
        const finalP = finalBeadsById.get(pId);
        check(
            !(finalP.dependencies || []).some((d) => d.type === 'blocks' && d.depends_on_id === cId),
            `Expected the 'blocks' edge to be gone from P's dependencies after repair, got: ${JSON.stringify(finalP.dependencies)}`
        );
        // Whatever happens further into the sprint (Plan/Develop/etc.) is out
        // of this test's scope -- the point is pre-sprint validation itself
        // no longer hard-fails on this exact shape. If it does still throw
        // for some unrelated downstream reason, that's a different bug.
        if (error) {
            check(!/deadlocked by/.test(error.message), `Did not expect a deadlock-related error post-repair, got: ${error.message}`);
        }
    });
});

test('mock sprint: pre-sprint validation still hard-fails when repair leaves no other ready work', async () => {
    await withScenarioMarkers('xbucyclenorepairwork', async () => {
        console.log('Running mock sprint scenario (cycle repaired, but a separate unrelated blocker still leaves nothing ready)...');
        const { logs, error } = await runCycleScenario('xbucyclenorepairwork', {
            beforeSprint: async ({ tempDir, pId, cId }) => {
                // An unrelated, permanently-open third bead that independently
                // blocks BOTH P and C -- so removing just the P<->C cycle edge
                // (the only thing apra-fleet-xbu.2.1's repair touches) still
                // leaves --ready empty afterward, and the generic deadlock
                // diagnostics must still fire as a fallback.
                const dRes = await runCmd('bd create -t task "Task: unrelated permanent blocker" -d "Never closes." --silent', tempDir);
                const dId = dRes.stdout.trim();
                await runCmd(`bd dep add ${pId} ${dId}`, tempDir);
                await runCmd(`bd dep add ${cId} ${dId}`, tempDir);
            },
        });

        check(
            logs.some((m) => m.includes('Pre-sprint auto-repair (apra-fleet-xbu.2.1)') && m.includes('auto-removed via bd dep remove')),
            `Expected the auto-repair to still have been attempted and logged before the fallback diagnostics fired, logs: ${JSON.stringify(logs)}`
        );
        check(error, 'Expected the sprint to still hard-fail when repair leaves genuinely no ready work');
    });
});
