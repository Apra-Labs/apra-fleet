import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import { bdMode } from './helpers/bd-replay.mjs';
import { runCmd, buildMockFleetApi, teardown, withScenarioMarkers, bdInitCommandForClone } from './helpers/mock-sprint-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const check = (cond, msg) => assert.ok(cond, msg);

// Real bd (>= 1.3) refuses to build the parent-child + blocks cycle this fixture
// needs, in BOTH orders (blocks edge first then re-parent, or parent first then
// blocks edge): "cannot be blocked by its descendant/ancestor" or "would create
// a cycle". So under real bd the auto-repair below is defense-in-depth (it
// still protects older bd versions and pre-existing databases) and cannot be
// exercised end to end; the mock lane keeps exercising it. In real mode each
// test instead asserts the property that made the setup unconstructible: bd
// rejects the edge, in both orders.
const REAL_BD = bdMode() === 'real';

async function assertRealBdRejectsCycle(tag) {
    const tempDir = path.join(os.tmpdir(), `apra-fleet-mock-sprint-${tag}-${Date.now()}-${process.pid}`);
    await fs.mkdir(tempDir, { recursive: true });
    try {
        await runCmd(bdInitCommandForClone(tempDir), tempDir);
        const create = async (title) => (await runCmd(`bd create -t task "${title}" -d "Scenario." --silent`, tempDir)).stdout.trim();
        const rejected = (res) => Boolean(res.err || (res.stderr && res.stderr.trim()));
        const REJECTION = /descendant|ancestor|cycle/i;
        const text = (res) => `${res.err ? res.err.message : ''} ${res.stderr}`;

        // Order 1: parent first, then the blocks edge.
        const p1 = await create(`${tag} p1`);
        const c1 = await create(`${tag} c1`);
        await runCmd(`bd update ${c1} --parent ${p1}`, tempDir);
        const dep1 = await runCmd(`bd dep add ${p1} ${c1}`, tempDir);
        check(rejected(dep1) && REJECTION.test(text(dep1)), `expected real bd to reject P blocked-by its child, got: ${JSON.stringify(dep1)}`);

        // Order 2: blocks edge first, then re-parent.
        const p2 = await create(`${tag} p2`);
        const c2 = await create(`${tag} c2`);
        const dep2 = await runCmd(`bd dep add ${p2} ${c2}`, tempDir);
        check(!rejected(dep2), `the standalone blocks edge must be accepted, got: ${JSON.stringify(dep2)}`);
        const parentRes = await runCmd(`bd update ${c2} --parent ${p2}`, tempDir);
        check(rejected(parentRes) && REJECTION.test(text(parentRes)), `expected real bd to reject re-parenting under the blocker, got: ${JSON.stringify(parentRes)}`);
    } finally {
        await teardown(tempDir);
    }
}

async function setupCycleFixture(tag) {
    const tempDir = path.join(os.tmpdir(), `apra-fleet-mock-sprint-${tag}-${Date.now()}-${process.pid}`);
    await fs.mkdir(tempDir, { recursive: true });
    await runCmd(bdInitCommandForClone(tempDir), tempDir);

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
        const scriptPath = path.join(__dirname, '../fleet-sprint/runner.js');

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
    if (REAL_BD) return assertRealBdRejectsCycle('xbucyclerepair');
    await withScenarioMarkers('xbucyclerepair', async () => {
        console.log('Running mock sprint scenario (multi-target: parent blocked by its own child -- auto-repair path)...');
        const { logs, error, pId, cId, finalBeadsById } = await runCycleScenario('xbucyclerepair');

        check(
            logs.some((m) => m.includes('Pre-sprint auto-repair:') && m.includes(pId) && m.includes(cId) && m.includes('auto-removed via bd dep remove')),
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
    if (REAL_BD) return assertRealBdRejectsCycle('xbucyclenorepairwork');
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
            logs.some((m) => m.includes('Pre-sprint auto-repair:') && m.includes('auto-removed via bd dep remove')),
            `Expected the auto-repair to still have been attempted and logged before the fallback diagnostics fired, logs: ${JSON.stringify(logs)}`
        );
        check(error, 'Expected the sprint to still hard-fail when repair leaves genuinely no ready work');
    });
});
