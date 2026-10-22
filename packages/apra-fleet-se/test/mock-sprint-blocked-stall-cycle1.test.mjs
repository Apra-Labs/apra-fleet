// =============================================================================
// End-to-end mock sprints for "a blocked sprint stops early and reports the
// blocker": a doer-BLOCKED bead (and its dependents) and a deploy that failed
// at the deploy.md Permissions pre-step are set aside for the run, and once
// nothing else can progress the run ends SPRINT_STALLED at once, naming every
// blocker with its reason.
//
// Scenarios:
//   (a) the reported user case -- one member is missing a toolchain, so the
//       doer returns BLOCKED for two beads (one with a dependent) while an
//       independent two-bead chain is workable;
//   (b) a 3-bead streak where only one bead is BLOCKED -- pinned by
//       mock-sprint-doer-blocked-set-aside.test.mjs (the blocked bead, its
//       dependent and the dependent's dependent are never re-dispatched; the
//       other 2 streak beads are dispatched next round and close);
//   (c) deploy fails at the Permissions pre-step in cycle 1 while work is
//       still open: no deployer dispatch in cycle 2, and the stall names the
//       deploy reason (the single-cycle variant is pinned by
//       mock-sprint-deploy-permissions-set-aside.test.mjs);
//   (d) no BLOCKED anywhere: dispatch counts, cycle count and outcome are
//       the pre-change ones;
//   (e) one lane BLOCKED while another lane's feature has all its children
//       closed: that feature is neither set aside nor waiting on a set-aside
//       deploy, so Deploy and Integration Test run for it before any stall;
//   (f) the deploy is set aside and all work is closed: no deploy-retry
//       cycle, no Re-Review, and the run ends FAIL naming the deploy reason.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { buildSprintPrBody } from '../fleet-sprint/pr-body.mjs';
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
const doerDispatches = (run) => run.dispatched.filter((d) => d.agent === 'doer');
const timesDispatched = (run, id) => doerDispatches(run).filter((d) => assignedIds(d.prompt).includes(id)).length;
const report = (obj) => ({ content: [{ text: JSON.stringify(obj) }] });
const approve = async () => report({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] });
const countByAgent = (run) => {
    const out = {};
    for (const d of run.dispatched) { const k = d.agent || '(none)'; out[k] = (out[k] || 0) + 1; }
    return out;
};
const cycleTwoStarted = (logs) => logs.some((m) => /\bC2 R\d|Cycle 2\b|Deploy Phase C2|Route C2/.test(m));

// Scenario (d)'s dispatch counts per agent and verdict, measured by running
// the same scenario against the engine from before the set-aside work (the
// final-review dispatch carries no agent name, hence '(none)').
const PRE_CHANGE_DISPATCH_COUNTS = { planner: 1, 'plan-reviewer': 1, '(none)': 1, doer: 2, reviewer: 2, harvester: 1 };
const PRE_CHANGE_VERDICT = 'PASS';

const TOOLCHAIN_NOTES = 'Missing toolchain: cargo is not installed on this member.';

test('(a) BLOCKED beads and their dependent are dispatched once at most; the independent work closes; SPRINT_STALLED in cycle 1', async () => {
    resetSyncMemo();
    await withScenarioMarkers('blocked stall cycle 1 (user case)', async () => {
        const T = {
            a: 'Task: build the native addon',
            b: 'Task: build the wasm target',
            c: 'Task: package the wasm target',
            d1: 'Task: independent docs first',
            d2: 'Task: independent docs second',
        };
        const blockedTitles = new Set([T.a, T.b]);
        const run = await runDevelopLoopScenario('bsc-user', {
            members: ['local'],
            taskSpecs: Object.values(T).map((title) => ({ title })),
            maxCycles: 3,
            beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => {
                const id = (title) => tasks.find((x) => x.title === title).id;
                const lanes = [[T.a, 'lane-a', 1], [T.b, 'lane-b', 1], [T.c, 'lane-c', 1], [T.d1, 'lane-d', 1], [T.d2, 'lane-d', 2]];
                for (const [title, streak, order] of lanes) {
                    await rc(`bd update ${id(title)} --set-metadata streak=${streak} --set-metadata streakOrder=${order}`, td);
                }
                await rc(`bd dep add ${id(T.c)} ${id(T.b)}`, td);
                await rc(`bd dep add ${id(T.d2)} ${id(T.d1)}`, td);
            },
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts.prompt);
                const list = JSON.parse((await rc('bd list --json', td)).stdout || '[]');
                const blocked = ids.filter((x) => blockedTitles.has((list.find((b) => b.id === x) || {}).title));
                if (blocked.length > 0) {
                    return report({ status: 'BLOCKED', closedIds: [], blockedIds: blocked, notes: TOOLCHAIN_NOTES });
                }
                for (const x of ids) await rc(`bd close ${x}`, td);
                return report({ status: 'VERIFY', closedIds: ids, notes: 'Done.' });
            },
            reviewerHandler: approve,
        });
        const id = (title) => run.tasks.find((t) => t.title === title).id;
        const [a, b, c, d1, d2] = [T.a, T.b, T.c, T.d1, T.d2].map(id);

        // Each BLOCKED bead reaches a doer exactly once; its dependent never.
        assert.equal(timesDispatched(run, a), 1, `${a} dispatch count`);
        assert.equal(timesDispatched(run, b), 1, `${b} dispatch count`);
        assert.equal(timesDispatched(run, c), 0, `${c} (dependent of a BLOCKED bead) must never be dispatched`);
        // The independent chain still closes.
        for (const x of [d1, d2]) assert.equal(run.finalBeadsById.get(x).status, 'closed', `${x} must close`);

        // The run ends SPRINT_STALLED in cycle 1, naming each blocker.
        assert.ok(run.error, 'the run must end in a stall');
        assert.equal(run.error.code, 'SPRINT_STALLED', run.error.message);
        assert.equal(run.error.details.cycle, 1);
        assert.ok(!cycleTwoStarted(run.logs), 'no second cycle may start');
        for (const x of [a, b, c]) {
            assert.ok(run.error.blockerIds.includes(x), `blockerIds must name ${x}: ${JSON.stringify(run.error.blockerIds)}`);
        }
        for (const x of [a, b]) assert.ok(run.error.blockerReasons[x].includes(TOOLCHAIN_NOTES), run.error.blockerReasons[x]);
        assert.ok(run.error.blockerReasons[c].includes(b), `the dependent's reason must name ${b}: ${run.error.blockerReasons[c]}`);
        assert.ok(run.error.message.includes(TOOLCHAIN_NOTES), run.error.message);

        // The [ABORTED] PR body built from this run's stall carries the
        // "Set aside this run" section: bead, reason, first seen.
        const body = buildSprintPrBody({ verdict: 'ABORTED', branch: run.branch, notes: run.error.message, setAside: run.error.setAside });
        const section = body.slice(body.indexOf('### Set aside this run'));
        assert.ok(body.includes('### Set aside this run'), body);
        for (const x of [a, b, c]) {
            assert.match(section, new RegExp(`- ${x}: .*\\(first seen C1 R1\\)`), section);
        }
        assert.ok(section.includes(TOOLCHAIN_NOTES), section);
    });
});

test('(c) a deploy set aside at the Permissions pre-step in C1 is not dispatched in C2; the stall carries the deploy reason', async () => {
    resetSyncMemo();
    await withScenarioMarkers('blocked stall deploy set aside', async () => {
        const PERMISSION_NOTES = 'Missing permission grant(s): Bash(docker compose:*).';
        const LATE = 'Task: finishes in cycle two';
        let deployCalls = 0;
        const run = await runDevelopLoopScenario('bsc-deploy', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: finishes in cycle one' }, { title: LATE }],
            maxCycles: 3,
            withRunbooks: true,
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts.prompt);
                const list = JSON.parse((await rc('bd list --json', td)).stdout || '[]');
                // The late bead is left open (no BLOCKED) until the deploy has
                // run once, i.e. until cycle 2.
                const closable = ids.filter((x) => deployCalls > 0 || (list.find((b) => b.id === x) || {}).title !== LATE);
                for (const x of closable) await rc(`bd close ${x}`, td);
                return report({ status: 'VERIFY', closedIds: closable, notes: 'Done what I could.' });
            },
            reviewerHandler: approve,
            deployHandler: async () => {
                deployCalls++;
                return report({ deployed: false, failedStep: 'permissions', notes: PERMISSION_NOTES });
            },
        });
        const late = run.tasks.find((t) => t.title === LATE).id;
        assert.equal(deployCalls, 1, 'the deployer must be dispatched in C1 only');
        assert.equal(run.dispatched.filter((d) => d.agent === 'deployer').length, 1);
        assert.ok(run.logs.some((l) => l.startsWith('Skipping Deploy Phase C2: deploy not dispatched -- set aside for this run since C1')),
            `C2 must skip the deployer, logs: ${JSON.stringify(run.logs.filter((l) => /Deploy/.test(l)))}`);
        assert.equal(run.finalBeadsById.get(late).status, 'closed', 'the late bead closes in C2');

        assert.ok(run.error, 'the run must stall once only IntegTest-bound work remains');
        assert.equal(run.error.code, 'SPRINT_STALLED', run.error.message);
        assert.equal(run.error.details.cycle, 2);
        assert.ok(run.error.blockerIds.includes('deploy'), JSON.stringify(run.error.blockerIds));
        assert.ok(run.error.blockerReasons.deploy.includes(PERMISSION_NOTES), run.error.blockerReasons.deploy);
        assert.ok(run.error.message.includes(PERMISSION_NOTES), run.error.message);
        const body = buildSprintPrBody({ verdict: 'ABORTED', branch: run.branch, notes: '', setAside: run.error.setAside });
        assert.match(body, /- deploy: deployer stopped at the deploy\.md Permissions check.*\(first seen C1\)/);
    });
});

test('(d) no BLOCKED anywhere: dispatch counts, cycle count and outcome are unchanged', async () => {
    resetSyncMemo();
    await withScenarioMarkers('blocked stall regression (no BLOCKED)', async () => {
        const run = await runDevelopLoopScenario('bsc-noblock', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: plain first' }, { title: 'Task: plain second' }],
            maxCycles: 2,
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts.prompt);
                for (const x of ids) await rc(`bd close ${x}`, td);
                return report({ status: 'VERIFY', closedIds: ids, notes: 'Done.' });
            },
            reviewerHandler: approve,
        });
        assert.ok(!run.error, `no stall without BLOCKED: ${run.error && run.error.message}`);
        assert.ok(!run.logs.some((m) => /set aside|SET ASIDE|Set aside/.test(m)), 'nothing may be set aside');
        assert.ok(!cycleTwoStarted(run.logs), 'the run completes in one cycle');
        // Measured on the tree before the set-aside work landed (same
        // scenario, same handlers).
        assert.deepEqual(countByAgent(run), PRE_CHANGE_DISPATCH_COUNTS, JSON.stringify(countByAgent(run)));
        assert.equal(run.result.verdict, PRE_CHANGE_VERDICT, JSON.stringify(run.result));
    });
});

test('(e) a verify-ready feature in another lane keeps the run going through Deploy and Integration Test before the stall', async () => {
    resetSyncMemo();
    await withScenarioMarkers('blocked stall verify-ready feature', async () => {
        const T = { a: 'Task: needs the missing toolchain', f1: 'Task: feature part one', f2: 'Task: feature part two' };
        const FEATURE = 'Feature: the workable feature';
        let featureId = null;
        const run = await runDevelopLoopScenario('bsc-feature', {
            members: ['local'],
            taskSpecs: Object.values(T).map((title) => ({ title })),
            maxCycles: 3,
            withRunbooks: true,
            beforeSprint: async ({ runCmd: rc, tempDir: td, tasks, epicBead }) => {
                const id = (title) => tasks.find((x) => x.title === title).id;
                featureId = (await rc(`bd create -t feature "${FEATURE}" -d "Scenario feature." --silent`, td)).stdout.trim();
                await rc(`bd update ${featureId} --parent ${epicBead.id}`, td);
                for (const t of [T.f1, T.f2]) await rc(`bd update ${id(t)} --parent ${featureId}`, td);
                const lanes = [[T.a, 'lane-a', 1], [T.f1, 'lane-f', 1], [T.f2, 'lane-f', 2]];
                for (const [title, streak, order] of lanes) {
                    await rc(`bd update ${id(title)} --set-metadata streak=${streak} --set-metadata streakOrder=${order}`, td);
                }
            },
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts.prompt);
                const list = JSON.parse((await rc('bd list --json', td)).stdout || '[]');
                const blocked = ids.filter((x) => (list.find((b) => b.id === x) || {}).title === T.a);
                if (blocked.length > 0) {
                    return report({ status: 'BLOCKED', closedIds: [], blockedIds: blocked, notes: TOOLCHAIN_NOTES });
                }
                for (const x of ids) await rc(`bd close ${x}`, td);
                return report({ status: 'VERIFY', closedIds: ids, notes: 'Done.' });
            },
            reviewerHandler: approve,
        });
        const a = run.tasks.find((t) => t.title === T.a).id;
        assert.ok(featureId, 'the feature bead must exist');
        assert.equal(timesDispatched(run, a), 1, `${a} dispatch count`);

        // Deploy and Integration Test ran for the verify-ready feature, and
        // closed it, before the run stalled.
        const deployIdx = run.dispatched.findIndex((d) => d.agent === 'deployer');
        assert.ok(deployIdx >= 0, `the deployer must be dispatched: ${JSON.stringify(countByAgent(run))}`);
        const integ = run.dispatched.filter((d) => d.agent === 'integ-test-runner');
        assert.ok(integ.some((d) => new RegExp(`verification-closure:[^.]*${featureId}`).test(d.prompt)),
            'Integration Test must be asked to verify the feature');
        assert.equal(run.finalBeadsById.get(featureId).status, 'closed', 'the feature closes through Integration Test');

        // Only then: the set-aside stall, naming the blocked bead and neither
        // the feature nor a deploy.
        assert.ok(run.error, 'the run must end in a stall once only the set-aside bead remains');
        assert.equal(run.error.code, 'SPRINT_STALLED', run.error.message);
        assert.equal(run.error.details.cycle, 1);
        assert.deepEqual(run.error.blockerIds, [a]);
    });
});

test('(f) a set-aside deploy with every bead closed exits at once: no retry cycle, no Re-Review, FAIL naming the deploy reason', async () => {
    resetSyncMemo();
    await withScenarioMarkers('blocked stall deploy set aside all closed', async () => {
        const PERMISSION_NOTES = 'Missing permission grant(s): Bash(docker compose:*).';
        let deployCalls = 0;
        // No child beads: the sprint's target is a single leaf bead, so nothing
        // can only close through Integration Test once it closes.
        const run = await runDevelopLoopScenario('bsc-deploy-done', {
            members: ['local'],
            taskSpecs: [],
            maxCycles: 3,
            withRunbooks: true,
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = assignedIds(opts.prompt);
                for (const x of ids) await rc(`bd close ${x}`, td);
                return report({ status: 'VERIFY', closedIds: ids, notes: 'Done.' });
            },
            reviewerHandler: approve,
            deployHandler: async () => {
                deployCalls++;
                return report({ deployed: false, failedStep: 'permissions', notes: PERMISSION_NOTES });
            },
        });
        assert.ok(!run.error, `no stall expected: ${run.error && run.error.message}`);
        assert.equal(run.finalBeadsById.get(run.epicBeadId).status, 'closed', 'the target bead closes in C1');
        assert.equal(deployCalls, 1, 'the deployer is dispatched exactly once');
        assert.ok(!cycleTwoStarted(run.logs), `no second cycle may start: ${JSON.stringify(run.logs.filter((l) => /Cycle|C2/.test(l)))}`);
        assert.ok(!run.logs.some((l) => /Re-attempting deploy/.test(l)), 'no misleading deploy-retry log line');
        assert.ok(run.logs.some((l) => /No deploy retry is possible this run/.test(l)), 'the set-aside exit must be logged');
        const deployIdx = run.dispatched.findIndex((d) => d.agent === 'deployer');
        // After the deploy, the only reviewer dispatch is the Final Review.
        const afterDeploy = run.dispatched.slice(deployIdx + 1);
        assert.ok(!afterDeploy.some((d) => d.agent === 'reviewer' && d.label !== 'Final Review'),
            `no Re-Review after the deploy: ${JSON.stringify(afterDeploy.map((d) => [d.agent, d.label]))}`);
        assert.equal(run.result.verdict, 'FAIL', JSON.stringify(run.result));
        assert.ok(run.result.notes.includes(PERMISSION_NOTES), run.result.notes);
        assert.ok(run.commandLog.some((c) => c.includes('Set aside this run')),
            'the published PR body must carry the "Set aside this run" section');
    });
});

